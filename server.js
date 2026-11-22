require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cheerio = require('cheerio');
const cloudscraper = require('cloudscraper');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', limiter);

app.get('/api/v1/health', (req, res) => res.json({ success: true, status: 'online', version: '12.0.0' }));

const TMDB_API = process.env.TMDB_API_KEY || '04c35731a5ee918f014970082a0088b1';

// --- DISCOVERY ---
app.get('/api/v1/discover', async (req, res) => {
    try {
        const { type = 'movie', category = 'trending', page = 1, country, genre } = req.query;
        const cacheKey = `cat_${type}_${category}_${page}_${country}_${genre}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc&primary_release_date.lte=2022-12-31`;
        if (category === 'trending') url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=vote_count.desc&primary_release_date.lte=2022-12-31`;
        if (country && country !== 'all') url += `&with_origin_country=${country}`;
        if (genre && genre !== 'all') url += `&with_genres=${genre}`;

        const response = await axios.get(url, { timeout: 8000 });
        const data = { success: true, page: parseInt(page), results: response.data.results };
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

// --- SPORTS ---
app.get('/api/v1/sports', async (req, res) => {
    try {
        const cached = cache.get('sports');
        if (cached) return res.json(cached);
        const espnRes = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const events = (espnRes.data.events || []).map(event => {
            let watchUrl = null, broadcastName = null;
            if (event.links) {
                const watchLink = event.links.find(l => l.rel.includes('watch') || l.href.includes('watch'));
                if (watchLink) { watchUrl = watchLink.href; broadcastName = "ESPN Live"; }
            }
            if (event.competitions?.[0]?.broadcasts) broadcastName = event.competitions[0].broadcasts[0]?.names?.[0] || "Live Stream";
            return { ...event, watchUrl, broadcastName };
        });
        const data = { success: true, events: events };
        cache.set('sports', data, 60);
        res.json(data);
    } catch (error) { res.status(500).json({ success: false, error: "Sports Error" }); }
});

// --- PLAYER ---
app.get('/api/v1/player/:id/sources', async (req, res) => {
    const { id } = req.params;
    const { type = 'movie', season = 1, episode = 1 } = req.query;
    try {
        const sources = [];
        let vidsrcUrl = type === 'movie' ? `https://vidsrc.sh/embed/movie/${id}` : `https://vidsrc.sh/embed/tv/${id}/${season}/${episode}`;
        sources.push({ quality: 'auto', url: vidsrcUrl, provider: 'Vidsrc' });

        let embedUrl = type === 'movie' ? `https://www.2embed.cc/embed/${id}` : `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}`;
        sources.push({ quality: 'auto', url: embedUrl, provider: '2Embed' });

        return res.json({ success: true, sources: sources, mode: 'iframe' });
    } catch (e) { return res.status(404).json({ success: false, error: "Stream unavailable" }); }
});

// --- DOWNLOAD (Cloudflare Bypass) ---
app.get('/api/v1/downloads/request', async (req, res) => {
    let { title, type, season, episode, id } = req.query;
    if (!title) return res.status(400).json({ success: false, error: "Title required" });

    let cleanTitle = title.replace(/\(\d{4}\)/g, '').replace(/\d{4}/g, '').replace(/[^\w\s]/gi, '').trim();
    let searchQuery = cleanTitle;
    if (type === 'tv' && season && episode) searchQuery = `${cleanTitle} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;

    try {
        const searchUrl = `https://www.thenetnaija.net/search?q=${encodeURIComponent(searchQuery)}`;
        const searchHtml = await cloudscraper.get(searchUrl, { timeout: 10000 });
        const $ = cheerio.load(searchHtml);
        const movieLink = $('.search-result a, .post-item a').first().attr('href');
        
        if (movieLink) {
            const movieHtml = await cloudscraper.get(movieLink, { timeout: 10000 });
            const $movie = cheerio.load(movieHtml);
            let downloadLink = $movie('a[href*="download"], a[href*=".mp4"], a[href*=".mkv"]').first().attr('href');
            
            if (downloadLink) {
                return res.json({ success: true, options: [{ name: "Direct Download", quality: "HD", url: downloadLink }] });
            }
        }
    } catch (error) { console.log("Scraper failed."); }

    // Fallback
    let fallbackUrl = type === 'movie' ? `https://vidsrc.sh/embed/movie/${id}` : `https://vidsrc.sh/embed/tv/${id}/${season}/${episode}`;
    return res.json({ success: true, options: [{ name: "Stream Link", quality: "Browser Download", url: fallbackUrl }] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 STREAMNOVA V12 running on port ${PORT}`));
