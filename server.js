// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const m3u8stream = require('m3u8stream');
const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process');
const tmdbScrape = require('./vidsrc');

const app = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', limiter);

app.get('/api/v1/health', (req, res) => res.json({ success: true, status: 'online', version: '17.0.0' }));

const TMDB_API = process.env.TMDB_API_KEY || '04c35731a5ee918f014970082a0088b1';

// ============================================================================
// 1. DISCOVERY (1994-2030, Dubbed English, Anime, Reality)
// ============================================================================
app.get('/api/v1/discover', async (req, res) => {
    try {
        const { type = 'movie', category = 'trending', page = 1, country, genre, startYear = 1994, endYear = 2030 } = req.query;
        const cacheKey = `cat_${type}_${category}_${page}_${country}_${genre}_${startYear}_${endYear}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;
        const dateField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
        
        // Add Date Range
        url += `&${dateField}.gte=${startYear}-01-01&${dateField}.lte=${endYear}-12-31`;

        if (category === 'trending') {
            url += `&sort_by=vote_count.desc`;
        } else if (category === 'anime') {
            url += `&with_genres=16&with_original_language=ja&with_origin_country=JP`;
        } else if (category === 'reality') {
            url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc&with_genres=10764&first_air_date.gte=${startYear}-01-01&first_air_date.lte=${endYear}-12-31`;
        } else if (category === 'dubbed') {
            // Dubbed English filter
            url += `&with_original_language=ja|ko|zh|es|fr|hi|tr|de|it|pt&language=en-US`;
        }

        if (country && country !== 'all') url += `&with_origin_country=${country}`;
        if (genre && genre !== 'all') url += `&with_genres=${genre}`;

        const response = await axios.get(url, { timeout: 8000 });
        let results = response.data.results;

        if (category === 'dubbed') {
            results = results.filter(item => {
                const title = item.title || item.name;
                const originalTitle = item.original_title || item.original_name;
                return title && originalTitle && title !== originalTitle;
            });
        }

        const data = { success: true, page: parseInt(page), results };
        cache.set(cacheKey, data);
        res.json(data);
    } catch (error) { res.status(500).json({ success: false, error: "Catalogue unavailable" }); }
});

// --- DETAILS ---
app.get('/api/v1/details', async (req, res) => {
    try {
        const { id, type } = req.query;
        const cacheKey = `detail_${type}_${id}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API}&append_to_response=credits,similar,videos,external_ids`;
        const response = await axios.get(url, { timeout: 8000 });
        cache.set(cacheKey, response.data);
        res.json(response.data);
    } catch (error) { res.status(500).json({ success: false, error: "Failed to load details" }); }
});

// ============================================================================
// 2. PLAYER SOURCES (Uses the VidSrc Scraper)
// ============================================================================
app.get('/api/v1/player/:id/sources', async (req, res) => {
    const { id } = req.params;
    const { type = 'movie', season = 1, episode = 1 } = req.query;
    try {
        const streams = await tmdbScrape(id, type, season, episode);
        
        if (!streams || streams.length === 0) {
            return res.status(404).json({ success: false, error: "Stream unavailable" });
        }

        const sources = streams.map((s, index) => ({
            provider: s.name || `Server ${index + 1}`,
            quality: 'auto',
            url: s.stream,
            referer: s.referer,
            type: 'hls'
        }));

        return res.json({ success: true, sources: sources, mode: 'native' });
    } catch (e) { 
        return res.status(500).json({ success: false, error: "Failed to extract stream" }); 
    }
});

// ============================================================================
// 3. DOWNLOADS (FFmpeg Piping for Movies & Sports)
// ============================================================================
app.get('/api/v1/downloads/request', (req, res) => {
    const { url, referer, filename } = req.query;
    if (!url) return res.status(400).send("Stream URL is required");

    const safeFilename = filename ? filename.replace(/[^a-z0-9]/gi, '_') : 'StreamNova_Download';
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    try {
        const stream = m3u8stream(url, {
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Referer': referer || 'https://whisperingauroras.com/'
                }
            }
        });

        const ffmpegProcess = spawn(ffmpeg, [
            '-i', 'pipe:0', 
            '-c', 'copy', 
            '-bsf:a', 'aac_adtstoasc', 
            '-f', 'mp4', 
            'pipe:1'
        ]);

        stream.pipe(ffmpegProcess.stdin);
        ffmpegProcess.stdout.pipe(res);

        req.on('close', () => {
            stream.destroy();
            ffmpegProcess.kill('SIGKILL');
        });
    } catch (error) {
        if (!res.headersSent) res.status(500).send("Failed to process download.");
    }
});

// ============================================================================
// 4. SPORTS
// ============================================================================
app.get('/api/v1/sports', async (req, res) => {
    try {
        const cached = cache.get('sports');
        if (cached) return res.json(cached);
        
        const espnRes = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        
        const events = (espnRes.data.events || []).map(event => {
            const competition = event.competitions?.[0] || {};
            const status = competition.status?.type?.description || 'Scheduled';
            return { 
                id: event.id,
                name: event.name,
                date: event.date,
                status: status,
                isLive: status === 'In Progress' || status === 'Halftime',
                homeTeam: competition.competitors?.find(c => c.homeAway === 'home')?.team?.displayName,
                awayTeam: competition.competitors?.find(c => c.homeAway === 'away')?.team?.displayName,
                score: status === 'In Progress' ? `${competition.competitors?.find(c => c.homeAway === 'home')?.score} - ${competition.competitors?.find(c => c.homeAway === 'away')?.score}` : null,
            };
        });
        
        const data = { success: true, events: events };
        cache.set('sports', data, 60);
        res.json(data);
    } catch (error) { res.status(500).json({ success: false, error: "Sports Error" }); }
});

app.get('/api/v1/sports/stream/:matchId', async (req, res) => {
    const liveSportsStream = "https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8"; // Public Red Bull TV test stream
    res.json({
        success: true,
        streamUrl: liveSportsStream,
        referer: "https://www.redbull.com/",
        type: "hls"
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 STREAMNOVA V17 running on port ${PORT}`));
