require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

app.get('/api/v1/health', (req, res) => res.json({ success: true, status: 'online', version: '12.0.0' }));

const TMDB_API = process.env.TMDB_API_KEY || '04c35731a5ee918f014970082a0088b1';

// --- DISCOVERY (Supports Country & Genre Filters) ---
app.get('/api/v1/discover', async (req, res) => {
    try {
        const { type = 'movie', category = 'trending', page = 1, country, genre } = req.query;
        const cacheKey = `cat_${type}_${category}_${page}_${country}_${genre}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc&primary_release_date.lte=2022-12-31`;
        
        if (category === 'trending') {
            url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=vote_count.desc&primary_release_date.lte=2022-12-31`;
        }
        
        if (country && country !== 'all') url += `&with_origin_country=${country}`;
        if (genre && genre !== 'all') url += `&with_genres=${genre}`;

        const response = await axios.get(url, { timeout: 8000 });
        const data = { success: true, page: parseInt(page), results: response.data.results };
        cache.set(cacheKey, data);
        res.json(data);
    } catch (error) { 
        res.status(500).json({ success: false, error: "Catalogue temporarily unavailable" }); 
    }
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
    } catch (error) { 
        res.status(500).json({ success: false, error: "Failed to load details" }); 
    }
});

// --- SPORTS ---
app.get('/api/v1/sports', async (req, res) => {
    try {
        const cached = cache.get('sports');
        if (cached) return res.json(cached);
        const espnRes = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = { success: true, events: espnRes.data.events || [] };
        cache.set('sports', data, 60);
        res.json(data);
    } catch (error) { 
        res.status(500).json({ success: false, error: "Sports API Error" }); 
    }
});

// --- PLAYER (Movies & TV Shows) ---
app.get('/api/v1/player/:id/sources', async (req, res) => {
    const { id } = req.params;
    const { type = 'movie', season = 1, episode = 1 } = req.query;
    const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

    try {
        let vidLinkUrl = `https://vidlink.pro/api/b/${type}/${id}`;
        if (type === 'tv') vidLinkUrl += `/${season}/${episode}`;
        vidLinkUrl += `?lang=en`;

        const vidLinkRes = await axios.get(vidLinkUrl, { timeout: 8000 });

        if (vidLinkRes.data?.stream?.playlist) {
            return res.json({ 
                success: true, 
                sources: [{ quality: 'auto', url: `${proxyBase}${encodeURIComponent(vidLinkRes.data.stream.playlist)}` }]
            });
        }
    } catch (e) { console.log("VidLink failed:", e.message); }
    return res.status(404).json({ success: false, error: "Stream not available." });
});

// --- FREE DOWNLOAD SYSTEM (No API Keys) ---
app.get('/api/v1/downloads/request', async (req, res) => {
    let { title } = req.query;
    if (!title) return res.status(400).json({ success: false, error: "Title required" });

    let cleanTitle = title.replace(/\(\d{4}\)/g, '').replace(/\d{4}/g, '').replace(/[^\w\s]/gi, '').trim();
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' };

    // 1. Try NetNaija
    try {
        const searchRes = await axios.get(`https://www.thenetnaija.net/search?q=${encodeURIComponent(cleanTitle)}`, { headers, timeout: 8000 });
        const $ = cheerio.load(searchRes.data);
        const resultLink = $('.search-result a, .post-item a').first().attr('href');
        
        if (resultLink) {
            const pageRes = await axios.get(resultLink, { headers, timeout: 8000 });
            const $page = cheerio.load(pageRes.data);
            let downloadLink = $page('a[href*="download"], a[href*=".mp4"], a[href*=".mkv"]').first().attr('href');
            if (downloadLink) return res.json({ success: true, source: 'NetNaija', url: downloadLink });
        }
    } catch (e) { console.log('NetNaija failed.'); }

    // 2. Try DuckDuckGo
    try {
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanTitle + ' mp4 download')}`;
        const ddgRes = await axios.get(ddgUrl, { headers, timeout: 8000 });
        const $ = cheerio.load(ddgRes.data);
        
        let fallbackLink = null;
        $('a.result__url').each((i, el) => {
            let href = $(el).attr('href');
            if (href && href.includes('uddg=')) {
                const urlParams = new URLSearchParams(href.split('?')[1]);
                const realUrl = decodeURIComponent(urlParams.get('uddg'));
                if (realUrl && (realUrl.includes('.mp4') || realUrl.includes('download') || realUrl.includes('1080p'))) {
                    fallbackLink = realUrl;
                    return false; 
                }
            }
        });

        if (fallbackLink) return res.json({ success: true, source: 'Web Search', url: fallbackLink });
    } catch (e) { console.log('DuckDuckGo failed.'); }

    return res.status(404).json({ success: false, error: "This title is not available for download on any free source." });
});

// --- HLS PROXY (Ad Stripping) ---
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl.startsWith('http')) targetUrl = Buffer.from(targetUrl, 'base64').toString('utf8');
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': new URL(targetUrl).origin + '/' };

    try {
        if (targetUrl.includes('.m3u8')) {
            const response = await axios.get(targetUrl, { headers });
            const lines = response.data.split('\n');
            const newLines = [];
            for (let line of lines) {
                line = line.trim();
                if (line.startsWith('#EXTINF:') && parseFloat(line.split(':')[1].split(',')[0]) < 6.0) continue; 
                if (line && !line.startsWith('#')) line = `${req.protocol}://${req.get('host')}/proxy?url=${Buffer.from(new URL(line, targetUrl).href).toString('base64')}`;
                newLines.push(line);
            }
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.send(newLines.join('\n'));
        } else {
            const response = await axios({ method: 'get', url: targetUrl, headers, responseType: 'stream' });
            response.data.pipe(res);
        }
    } catch (error) { res.status(500).send('Proxy Error'); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 STREAMNOVA V12 running on port ${PORT}`));
