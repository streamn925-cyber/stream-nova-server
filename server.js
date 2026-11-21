require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(helmet({
    crossOriginResourcePolicy: false, 
    contentSecurityPolicy: false
}));
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
        
        const events = (espnRes.data.events || []).map(event => {
            let watchUrl = null;
            let broadcastName = null;

            if (event.links && event.links.length > 0) {
                const watchLink = event.links.find(l => l.rel.includes('watch') || l.href.includes('watch') || l.href.includes('espn.com/watch'));
                if (watchLink) {
                    watchUrl = watchLink.href;
                    broadcastName = "ESPN Live";
                }
            }
            if (event.competitions && event.competitions[0]?.broadcasts) {
                const bcast = event.competitions[0].broadcasts[0]?.names;
                if (bcast && bcast.length > 0) broadcastName = bcast[0];
            }
            return { ...event, watchUrl, broadcastName: broadcastName || "Live Stream" };
        });

        const data = { success: true, events: events };
        cache.set('sports', data, 60);
        res.json(data);
    } catch (error) { 
        res.status(500).json({ success: false, error: "Sports API Error" }); 
    }
});

// --- PLAYER (Vidsrc Iframe) ---
app.get('/api/v1/player/:id/sources', async (req, res) => {
    const { id } = req.params;
    const { type = 'movie', season = 1, episode = 1 } = req.query;
    
    try {
        // Using vidsrc.sh, the current active domain for Vidsrc
        let vidsrcUrl = '';
        if (type === 'movie') {
            vidsrcUrl = `https://vidsrc.sh/embed/movie/${id}`;
        } else {
            vidsrcUrl = `https://vidsrc.sh/embed/tv/${id}/${season}/${episode}`;
        }

        return res.json({ 
            success: true, 
            sources: [{ quality: 'auto', url: vidsrcUrl }],
            mode: 'iframe'
        });
    } catch (e) { 
        return res.status(404).json({ success: false, error: "Stream not available." });
    }
});

// --- DOWNLOAD (Vidsrc Direct) ---
app.get('/api/v1/downloads/request', async (req, res) => {
    let { id, type, season, episode } = req.query;
    if (!id) return res.status(400).json({ success: false, error: "ID required" });

    try {
        let downloadUrl = '';
        if (type === 'movie') {
            downloadUrl = `https://vidsrc.sh/download/movie/${id}`;
        } else {
            downloadUrl = `https://vidsrc.sh/download/tv/${id}/${season}/${episode}`;
        }

        return res.json({ success: true, source: 'Vidsrc', url: downloadUrl });
    } catch (error) { 
        return res.status(404).json({ success: false, error: "Download not available." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 STREAMNOVA V12 running on port ${PORT}`));
