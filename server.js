require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10 minutes default

// --- 13. SECURITY & MIDDLEWARE ---
app.use(helmet());
app.use(cors({ origin: '*' })); // Lock down to your frontend domain in production
app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
    message: { success: false, error: "Too many requests, please try again later." }
});
app.use('/api/', limiter);

// --- 14. HEALTH CHECK ---
app.get('/health', (req, res) => res.json({ status: 'online', service: 'StreamNova V12', time: new Date() }));
app.get('/api/v1/health', (req, res) => res.json({ success: true, status: 'online', version: '12.0.0' }));

// Fallback for old frontend compatibility (Maps old routes to V12)
app.use((req, res, next) => {
    if (req.path === '/api/health') return res.redirect('/api/v1/health');
    if (req.path === '/api/catalogue') return res.redirect(`/api/v1/${req.query.type === 'tv' ? 'series' : 'movies'}?category=${req.query.category || 'trending'}`);
    if (req.path === '/api/sports') return res.redirect('/api/v1/sports');
    if (req.path === '/api/stream') return res.redirect(`/api/v1/player/${req.query.id}/sources?type=${req.query.type}`);
    if (req.path === '/api/download') return res.redirect(`/api/v1/downloads/request?title=${req.query.title}`);
    next();
});

// --- 2. COMPLETE ENTERTAINMENT API (TMDB INTEGRATION) ---
const TMDB_API = process.env.TMDB_API_KEY || '04c35731a5ee918f014970082a0088b1';

// MOVIES & SERIES
app.get('/api/v1/movies', async (req, res) => res.redirect('/api/v1/discover?type=movie'));
app.get('/api/v1/series', async (req, res) => res.redirect('/api/v1/discover?type=tv'));

app.get('/api/v1/discover', async (req, res) => {
    try {
        const { type = 'movie', category = 'trending', page = 1 } = req.query;
        const cacheKey = `cat_${type}_${category}_${page}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;
        
        if (category === 'trending') url = `https://api.themoviedb.org/3/trending/${type}/week?api_key=${TMDB_API}&page=${page}`;
        else if (category === 'dubbed') url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&with_keywords=234265&without_original_language=en&sort_by=popularity.desc`;
        else if (category === 'anime') url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API}&page=${page}&with_genres=16&with_original_language=ja&sort_by=popularity.desc`;

        const response = await axios.get(url, { timeout: 8000 });
        const data = { success: true, page: parseInt(page), results: response.data.results };
        cache.set(cacheKey, data);
        res.json(data);
    } catch (error) { res.status(500).json({ success: false, error: "Catalogue temporarily unavailable" }); }
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
    } catch (error) { res.status(500).json({ success: false, error: "Failed to load details" }); }
});

// --- 9. SPORTS SYSTEM ---
app.get('/api/v1/sports', async (req, res) => {
    try {
        const cached = cache.get('sports');
        if (cached) return res.json(cached);
        const espnRes = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = { success: true, events: espnRes.data.events || [] };
        cache.set('sports', data, 60);
        res.json(data);
    } catch (error) { res.status(500).json({ success: false, error: "Sports API Error" }); }
});

// --- 6. STREAMNOVA PLAYER API ---
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

// --- 7. NOVA DOWNLOAD SYSTEM ---
app.get('/api/v1/downloads/request', async (req, res) => {
    let { title, season, episode } = req.query;
    if (!title) return res.status(400).json({ success: false, error: "Title required" });

    let cleanTitle = title.replace(/\(\d{4}\)/g, '').replace(/\d{4}/g, '').replace(/[^\w\s]/gi, '').trim();
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' };

    // --- SITE 1: FZMovies ---
    try {
        let searchStr = cleanTitle;
        if (season && episode) searchStr = `${cleanTitle} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;
        const searchRes = await axios.get(`https://fzmovies.net/search.php?searchname=${encodeURIComponent(searchStr)}`, { headers, timeout: 15000 });
        const $ = cheerio.load(searchRes.data);
        let showLink = $('a[href*="tv-"]').first().attr('href') || $('a[href*="movie-"]').first().attr('href');

        if (showLink) {
            const showRes = await axios.get(showLink, { headers, timeout: 15000 });
            const $show = cheerio.load(showRes.data);
            let downloadPageLink = null;

            if (season && episode) {
                const seasonLink = $show(`a:contains("Season ${season}")`).attr('href');
                if (seasonLink) {
                    const seasonRes = await axios.get(seasonLink, { headers, timeout: 15000 });
                    const $season = cheerio.load(seasonRes.data);
                    const episodeLink = $season(`a:contains("Episode ${episode}")`).attr('href');
                    if (episodeLink) {
                        const epRes = await axios.get(episodeLink, { headers, timeout: 15000 });
                        const $ep = cheerio.load(epRes.data);
                        downloadPageLink = $ep('a[href*="download"]').first().attr('href');
                    }
                }
            } else {
                downloadPageLink = $show('a[href*="download"]').first().attr('href');
            }

            if (downloadPageLink) {
                const dlRes = await axios.get(downloadPageLink, { headers, timeout: 15000 });
                const $dl = cheerio.load(dlRes.data);
                const downloadLink = $dl('a[href$=".mp4"]').first().attr('href') || $dl('a[href$=".mkv"]').first().attr('href');
                if (downloadLink) return res.json({ success: true, url: downloadLink });
            }
        }
    } catch (e) { console.log('Fzmovies failed:', e.message); }

    // --- SITE 2: Nkiri ---
    try {
        const searchRes = await axios.get(`https://nkiri.com/?s=${encodeURIComponent(cleanTitle)}`, { headers, timeout: 15000 });
        const $ = cheerio.load(searchRes.data);
        const resultLink = $('.post-item a, article a').first().attr('href');
        if (resultLink) {
            const pageRes = await axios.get(resultLink, { headers, timeout: 15000 });
            const $page = cheerio.load(pageRes.data);
            let downloadLink = $page('a[href*="download"], a[href*=".mp4"], .dl-button').first().attr('href');
            if (downloadLink) return res.json({ success: true, url: downloadLink });
        }
    } catch (e) { console.log('Nkiri failed:', e.message); }

    // --- SITE 3: NetNaija ---
    try {
        const searchRes = await axios.get(`https://www.thenetnaija.net/search?q=${encodeURIComponent(cleanTitle)}`, { headers, timeout: 15000 });
        const $ = cheerio.load(searchRes.data);
        const resultLink = $('.search-result a, .post-item a').first().attr('href');
        if (resultLink) {
            const pageRes = await axios.get(resultLink, { headers, timeout: 15000 });
            const $page = cheerio.load(pageRes.data);
            let downloadLink = $page('a[href*="download"], a[href*=".mp4"]').first().attr('href');
            if (downloadLink) return res.json({ success: true, url: downloadLink });
        }
    } catch (e) { console.log('NetNaija failed:', e.message); }

    return res.status(404).json({ success: false, error: "This title is not available for download on any source." });
});

// --- PROXY (Ad-Stripping) ---
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

// --- 10, 11, 12. STUBS FOR V12 (Require Database) ---
app.all('/api/v1/users/*', (req, res) => res.status(501).json({ success: false, error: "User system requires database integration." }));
app.all('/api/v1/admin/*', (req, res) => res.status(501).json({ success: false, error: "Admin system requires database integration." }));
app.all('/api/v1/live/*', (req, res) => res.status(501).json({ success: false, error: "Live TV requires database integration." }));

// 404 Handler
app.use((req, res) => res.status(404).json({ success: false, error: "Endpoint not found" }));

// --- 8. START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 STREAMNOVA V12 running on port ${PORT}`));
