require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10 minutes default cache

// --- SECURITY & MIDDLEWARE ---
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 150, 
    message: { success: false, error: "Too many requests, please try again later." }
});
app.use('/api/', limiter);

// --- HEALTH CHECK ---
app.get('/health', (req, res) => res.json({ status: 'online', service: 'StreamNova V12', time: new Date() }));
app.get('/api/v1/health', (req, res) => res.json({ success: true, status: 'online', version: '12.0.0' }));

// --- FALLBACK FOR OLD FRONTEND ROUTES ---
app.use((req, res, next) => {
    if (req.path === '/api/health') return res.redirect('/api/v1/health');
    if (req.path === '/api/catalogue') return res.redirect(`/api/v1/discover?type=${req.query.type === 'tv' ? 'tv' : 'movie'}&category=${req.query.category || 'trending'}`);
    if (req.path === '/api/sports') return res.redirect('/api/v1/sports');
    if (req.path === '/api/stream') return res.redirect(`/api/v1/player/${req.query.id}/sources?type=${req.query.type}`);
    if (req.path === '/api/download') return res.redirect(`/api/v1/downloads/request?title=${req.query.title}`);
    next();
});

// --- TMDB METADATA API ---
const TMDB_API = process.env.TMDB_API_KEY || '04c35731a5ee918f014970082a0088b1';

app.get('/api/v1/movies', async (req, res) => res.redirect('/api/v1/discover?type=movie'));
app.get('/api/v1/series', async (req, res) => res.redirect('/api/v1/discover?type=tv'));

app.get('/api/v1/discover', async (req, res) => {
    try {
        const { type = 'movie', category = 'trending', page = 1 } = req.query;
        const cacheKey = `cat_${type}_${category}_${page}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        // Filter for older/popular movies so VidLink/Scrapers can actually find them.
        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc&primary_release_date.lte=2022-12-31`;
        
        if (category === 'trending') {
            url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=vote_count.desc&primary_release_date.lte=2022-12-31`;
        } else if (category === 'anime') {
            url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API}&page=${page}&with_genres=16&with_original_language=ja&sort_by=popularity.desc`;
        }

        const response = await axios.get(url, { timeout: 8000 });
        const data = { success: true, page: parseInt(page), results: response.data.results };
        cache.set(cacheKey, data);
        res.json(data);
    } catch (error) { 
        res.status(500).json({ success: false, error: "Catalogue temporarily unavailable" }); 
    }
});

app.get('/api/v1/movies/:id', async (req, res) => res.redirect(`/api/v1/details?id=${req.params.id}&type=movie`));
app.get('/api/v1/series/:id', async (req, res) => res.redirect(`/api/v1/details?id=${req.params.id}&type=tv`));

app.get('/api/v1/details', async (req, res) => {
    try {
        const { id, type } = req.query;
        const cacheKey = `detail_${type}_${id}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API}&append_to_response=credits,similar,videos`;
        const response = await axios.get(url, { timeout: 8000 });
        cache.set(cacheKey, response.data);
        res.json(response.data);
    } catch (error) { 
        res.status(500).json({ success: false, error: "Failed to load details" }); 
    }
});

// --- SPORTS SYSTEM (ESPN) ---
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

// --- PLAYER API (VIDLINK) ---
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
                sources: [{ quality: 'auto', url: `${proxyBase}${encodeURIComponent(vidLinkRes.data.stream.playlist)}` }],
                subtitles: []
            });
        }
    } catch (e) { console.log("VidLink failed:", e.message); }

    return res.status(404).json({ success: false, error: "Stream not available." });
});

// --- DOWNLOAD SYSTEM (RAPIDAPI + SCRAPER FALLBACK) ---
app.get('/api/v1/downloads/request', async (req, res) => {
    let { title } = req.query;
    if (!title) return res.status(400).json({ success: false, error: "Title required" });

    let cleanTitle = title.replace(/\(\d{4}\)/g, '').replace(/\d{4}/g, '').replace(/[^\w\s]/gi, '').trim();
    console.log(`Searching for download: ${cleanTitle}`);

    // 1. TRY RAPIDAPI (From your screenshot)
    const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'aa62c0d996msh832a28cb7bfe22fp170b'; // Replace with full key if not using Render Env
    const RAPIDAPI_HOST = 'letscrape-6bRBa.p.rapidapi.com'; // From your URL

    try {
        const options = {
            method: 'GET',
            url: `https://${RAPIDAPI_HOST}/search`,
            params: { q: `${cleanTitle} mp4 download`, limit: '5' },
            headers: {
                'X-RapidAPI-Key': RAPIDAPI_KEY,
                'X-RapidAPI-Host': RAPIDAPI_HOST
            },
            timeout: 10000
        };

        const response = await axios.request(options);
        const results = response.data.results || response.data.organic_results || [];
        
        let downloadUrl = null;
        for (let item of results) {
            if (item.link && (item.link.endsWith('.mp4') || item.link.includes('.mp4'))) {
                downloadUrl = item.link;
                break;
            }
        }
        if (!downloadUrl && results.length > 0) downloadUrl = results[0].link;

        if (downloadUrl) {
            console.log('✅ Found via RapidAPI!');
            return res.json({ success: true, source: 'RapidAPI', url: downloadUrl });
        }
    } catch (error) {
        console.error('RapidAPI Error or Limit Reached:', error.message);
    }

    // 2. FALLBACK SCRAPERS (If RapidAPI fails)
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' };
    
    // NetNaija Fallback
    try {
        const searchRes = await axios.get(`https://www.thenetnaija.net/search?q=${encodeURIComponent(cleanTitle)}`, { headers, timeout: 8000 });
        const $ = cheerio.load(searchRes.data);
        const resultLink = $('.search-result a, .post-item a').first().attr('href');
        if (resultLink) {
            const pageRes = await axios.get(resultLink, { headers, timeout: 8000 });
            const $page = cheerio.load(pageRes.data);
            let downloadLink = $page('a[href*="download"], a[href*=".mp4"]').first().attr('href');
            if (downloadLink) {
                console.log('✅ Found on NetNaija Fallback!');
                return res.json({ success: true, source: 'NetNaija', url: downloadLink });
            }
        }
    } catch (e) { console.log('NetNaija blocked/failed.'); }

    console.log('❌ All sources failed for:', cleanTitle);
    return res.status(404).json({ success: false, error: "This title is not available for download on any source." });
});

// --- HLS PROXY (Ad Stripping) ---
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl.startsWith('http')) targetUrl = Buffer.from(targetUrl, 'base64').toString('utf8');

    const isM3U8 = targetUrl.includes('.m3u8');
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': new URL(targetUrl).origin + '/' };

    try {
        if (isM3U8) {
            const response = await axios.get(targetUrl, { headers });
            let m3u8Text = response.data;
            const lines = m3u8Text.split('\n');
            const newLines = [];
            for (let line of lines) {
                line = line.trim();
                if (line.startsWith('#EXTINF:')) {
                    const duration = parseFloat(line.split(':')[1].split(',')[0]);
                    if (duration < 6.0) continue; 
                }
                if (line && !line.startsWith('#')) {
                    const absoluteUrl = new URL(line, targetUrl).href;
                    line = `${req.protocol}://${req.get('host')}/proxy?url=${Buffer.from(absoluteUrl).toString('base64')}`;
                }
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

// 404 Handler
app.use((req, res) => res.status(404).json({ success: false, error: "Endpoint not found" }));

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 STREAMNOVA V12 running on port ${PORT}`));
