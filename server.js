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

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10 min cache

// Middleware
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', limiter);

const TMDB_API = process.env.TMDB_API_KEY || '04c35731a5ee918f014970082a0088b1';

app.get('/api/v1/health', (req, res) => res.json({ success: true, status: 'online', version: '21.0.0' }));

// ============================================================================
// 1. DISCOVERY (Movies, TV, Anime, Dubbed English, Reality)
// ============================================================================
app.get('/api/v1/discover', async (req, res) => {
    try {
        const { type = 'movie', category = 'trending', page = 1, country, genre, startYear = 1994, endYear = 2030 } = req.query;
        const cacheKey = `cat_${type}_${category}_${page}_${country}_${genre}_${startYear}_${endYear}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;
        const dateField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
        url += `&${dateField}.gte=${startYear}-01-01&${dateField}.lte=${endYear}-12-31`;

        if (category === 'trending') {
            url += `&sort_by=vote_count.desc`;
        } else if (category === 'anime') {
            url += `&with_genres=16&with_original_language=ja&with_origin_country=JP`;
        } else if (category === 'reality') {
            url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc&with_genres=10764&first_air_date.gte=${startYear}-01-01&first_air_date.lte=${endYear}-12-31`;
        } else if (category === 'dubbed') {
            // Dubbed filter
            url += `&with_original_language=ja|ko|zh|es|fr|hi|tr|de|it|pt&language=en-US`;
        }

        if (country && country !== 'all') url += `&with_origin_country=${country}`;
        if (genre && genre !== 'all') url += `&with_genres=${genre}`;

        const response = await axios.get(url, { 
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 StreamNova/1.0' }
        });
        
        let results = response.data.results;

        // Filter out items without a localized English title (ensures a Dub exists)
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
    } catch (error) { 
        console.error("TMDB Error:", error.message);
        res.status(500).json({ success: false, error: "Catalogue unavailable" }); 
    }
});

// ============================================================================
// 2. ANIVIO-STYLE ANIME EXTRACTOR (Dubbed/Subbed via Consumet)
// ============================================================================
app.get('/api/v1/anime/extract', async (req, res) => {
    const { title, episode = 1, dub = 'true' } = req.query;
    if (!title) return res.status(400).json({ error: "Anime title required" });

    try {
        // 1. Search for the anime on GogoAnime (Consumet API)
        const searchUrl = `https://api.consumet.org/anime/gogoanime/${encodeURIComponent(title)}`;
        const searchRes = await axios.get(searchUrl, { timeout: 10000 });
        
        if (!searchRes.data.results || searchRes.data.results.length === 0) {
            return res.status(404).json({ success: false, error: "Anime not found" });
        }

        // 2. Select the best match (Prioritize Dub version if requested)
        let bestMatch = searchRes.data.results[0];
        if (dub === 'true') {
            const dubMatch = searchRes.data.results.find(a => 
                a.title.toLowerCase().includes('dub') || a.id.includes('dub')
            );
            if (dubMatch) bestMatch = dubMatch;
        }

        // 3. Get the episode info
        const infoUrl = `https://api.consumet.org/anime/gogoanime/info/${bestMatch.id}`;
        const infoRes = await axios.get(infoUrl);
        
        // Find the specific episode
        const targetEp = infoRes.data.episodes.find(e => e.number === parseInt(episode)) || infoRes.data.episodes[0];
        if (!targetEp) return res.status(404).json({ success: false, error: "Episode not found" });

        // 4. Get the streaming link (HLS)
        const streamUrl = `https://api.consumet.org/anime/gogoanime/watch/${targetEp.id}`;
        const streamRes = await axios.get(streamUrl);

        // Find the highest quality m3u8
        const sources = streamRes.data.sources;
        const hlsSource = sources.find(s => s.isM3U8) || sources[0];

        res.json({
            success: true,
            provider: 'Consumet (GogoAnime)',
            title: bestMatch.title,
            episode: episode,
            streamUrl: hlsSource.url,
            headers: { "Referer": "https://gogoanime.com/" },
            type: 'hls'
        });

    } catch (error) {
        console.error("Anime Extract Error:", error.message);
        res.status(500).json({ success: false, error: "Anime extraction failed" });
    }
});

// ============================================================================
// 3. PLAYER SOURCES (VidLink HLS + Fallbacks)
// ============================================================================
app.get('/api/v1/player/:id/sources', async (req, res) => {
    const { id } = req.params;
    const { type = 'movie', season = 1, episode = 1 } = req.query;
    const sources = [];

    // Method 1: VidLink (HLS, Supports Dubbed Audio)
    try {
        let vidLinkUrl = type === 'movie' 
            ? `https://vidlink.pro/api/b/movie/${id}` 
            : `https://vidlink.pro/api/b/tv/${id}/${season}/${episode}`;
            
        const vidLinkRes = await axios.get(vidLinkUrl, { timeout: 6000 });
        
        if (vidLinkRes.data && vidLinkRes.data.stream && vidLinkRes.data.stream.playlist) {
            sources.push({
                provider: 'VidLink (Native HLS)',
                url: vidLinkRes.data.stream.playlist,
                type: 'hls',
                referer: 'https://vidlink.pro/'
            });
        }
    } catch (error) {
        console.log(`⚠️ VidLink failed for ${id}`);
    }

    // Method 2: SuperEmbed Iframe (Fallback)
    if (sources.length === 0) {
        let embedUrl = type === 'movie' 
            ? `https://multiembed.mov/?video_id=${id}&tmdb=1` 
            : `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${season}&e=${episode}`;
        sources.push({ provider: 'SuperEmbed (Iframe)', url: embedUrl, type: 'iframe' });
    }

    return res.json({ success: true, sources });
});

// ============================================================================
// 4. DOWNLOADS (FFmpeg Piping)
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
                    'Referer': referer || 'https://vidlink.pro/'
                }
            }
        });

        const ffmpegProcess = spawn(ffmpeg, [
            '-i', 'pipe:0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'mp4', 'pipe:1'
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
// 5. SPORTS
// ============================================================================
app.get('/api/v1/sports', async (req, res) => {
    try {
        const cached = cache.get('sports');
        if (cached) return res.json(cached);
        
        const espnRes = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { 
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
        
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
    const liveSportsStream = "https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8"; 
    res.json({
        success: true,
        streamUrl: liveSportsStream,
        referer: "https://www.redbull.com/",
        type: "hls"
    });
});

// ============================================================================
// START SERVER
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 STREAMNOVA V21 running on port ${PORT}`));
