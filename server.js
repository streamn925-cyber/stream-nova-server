const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio'); // Added for scraping

const app = express();
app.use(cors());
app.use(express.json());

const TMDB_API = '04c35731a5ee918f014970082a0088b1';

// 1. HEALTH
app.get('/api/health', (req, res) => res.json({ status: 'online', time: new Date() }));

// 2. CATALOGUE
app.get('/api/catalogue', async (req, res) => {
    try {
        const { type = 'movie', category = 'trending', page = 1 } = req.query;
        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;

        if (category === 'trending') url = `https://api.themoviedb.org/3/trending/${type}/week?api_key=${TMDB_API}&page=${page}`;
        else if (category === 'dubbed') url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&with_keywords=234265&without_original_language=en&sort_by=popularity.desc`;
        else if (category === 'kdrama') url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API}&with_origin_country=KR&sort_by=popularity.desc&page=${page}`;

        const response = await axios.get(url, { timeout: 5000 });
        res.json({ success: true, results: response.data.results });
    } catch (error) { res.status(500).json({ success: false, error: "API Error" }); }
});

// 3. DETAILS & SEARCH
app.get('/api/details', async (req, res) => {
    try {
        const { id, type } = req.query;
        const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API}&append_to_response=credits,similar,videos`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: "Failed to load details" }); }
});

// 4. STREAM (For the Player)
app.get('/api/stream', async (req, res) => {
    const { id, type, season = 1, episode = 1 } = req.query;
    const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

    try {
        let vidLinkUrl = `https://vidlink.pro/api/b/${type}/${id}`;
        if (type === 'tv') vidLinkUrl += `/${season}/${episode}`;
        const vidLinkRes = await axios.get(vidLinkUrl, { timeout: 4000 });
        
        if (vidLinkRes.data?.stream) {
            const hlsUrl = vidLinkRes.data.stream.playlist;
            if (hlsUrl) {
                return res.json({ success: true, mode: 'native', streamUrl: `${proxyBase}${encodeURIComponent(hlsUrl)}` });
            }
        }
    } catch (e) { }

    let iframeUrls = type === 'movie' 
        ? [`https://vidsrc.to/embed/movie/${id}`, `https://www.2embed.cc/embed/${id}`]
        : [`https://vidsrc.to/embed/tv/${id}/${season}/${episode}`, `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}`];

    return res.json({ success: true, mode: 'iframe', iframeUrls: iframeUrls });
});

// 5. DOWNLOAD SCRAPER (NEW - This fixes the bulk download)
app.get('/api/download', async (req, res) => {
    let { title, site = 'fzmovies' } = req.query;
    if (!title) return res.status(400).json({ error: "Title required" });

    // Sanitize the title
    let cleanTitle = title.replace(/\(\d{4}\)/g, '').replace(/\d{4}/g, '').replace(/[^\w\s]/gi, '').trim();
    const searchTitle = encodeURIComponent(cleanTitle);
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

    try {
        let downloadLink = null;

        if (site === 'fzmovies') {
            const searchRes = await axios.get(`https://fzmovies.net/search.php?searchname=${searchTitle}`, { headers });
            const $ = cheerio.load(searchRes.data);
            const movieLink = $('a[href*="movie-"]').first().attr('href');

            if (movieLink) {
                const movieRes = await axios.get(movieLink, { headers });
                const $m = cheerio.load(movieRes.data);
                const dlPageLink = $m('a[href*="download"]').first().attr('href');

                if (dlPageLink) {
                    const dlPageRes = await axios.get(dlPageLink, { headers });
                    const $d = cheerio.load(dlPageRes.data);
                    downloadLink = $d('a[href$=".mp4"]').first().attr('href') || $d('a[href$=".mkv"]').first().attr('href');
                }
            }
        }

        if (downloadLink) return res.json({ success: true, url: downloadLink });
        res.status(404).json({ error: "Link not found" });
    } catch (error) {
        res.status(500).json({ error: "Scraper failed" });
    }
});

// 6. PROXY
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl.startsWith('http')) targetUrl = Buffer.from(targetUrl, 'base64').toString('utf8');
    try {
        const response = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'stream' });
        response.data.pipe(res);
    } catch (error) { res.status(500).send('Proxy Error'); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SERVER running on port ${PORT}`));
