const express = require('express');
const axios = require('axios');
const cors = require('cors');

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
        else if (category === 'dubbed') url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&with_original_language=ja|ko|zh|es|fr|hi|tr&sort_by=popularity.desc`;
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

app.get('/api/search', async (req, res) => {
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API}&query=${encodeURIComponent(req.query.q)}`);
        res.json({ results: response.data.results });
    } catch (error) { res.status(500).json({ error: "Search failed" }); }
});

// 4. NOTIFICATIONS & SUPPORT
app.get('/api/notifications', (req, res) => {
    res.json({ notifications: [{ id: 1, title: 'Welcome!', message: 'Enjoy StreamNova.', date: new Date().toISOString() }] });
});

app.post('/api/support', (req, res) => {
    res.json({ success: true, ticketId: Math.floor(Math.random() * 10000), status: 'open', subject: req.body.subject });
});

// 5. LIVE TV & SPORTS
app.get('/api/live-tv', (req, res) => {
    res.json({ channels: [
        { id: 1, name: 'NASA TV', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/NASA_logo.svg/1200px-NASA_logo.svg.png', url: 'https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8' },
        { id: 2, name: 'Red Bull TV', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f5/Red_Bull_TV_logo.svg/1200px-Red_Bull_TV_logo.svg.png', url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8' }
    ]});
});

app.get('/api/sports', async (req, res) => {
    try {
        const espnRes = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        res.json({ events: espnRes.data.events || [] });
    } catch (error) { res.status(500).json({ error: "Sports API Error" }); }
});

// 6. STREAM & DOWNLOAD (With VidSrc Fallback for TV Shows)
app.get('/api/stream', async (req, res) => {
    const { id, type, season = 1, episode = 1 } = req.query;
    const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

    // Method 1: VidLink
    try {
        let vidLinkUrl = `https://vidlink.pro/api/b/${type}/${id}`;
        if (type === 'tv') vidLinkUrl += `/${season}/${episode}`;
        const vidLinkRes = await axios.get(vidLinkUrl, { timeout: 4000 });
        
        if (vidLinkRes.data?.stream) {
            const hlsUrl = vidLinkRes.data.stream.playlist;
            const mp4Url = vidLinkRes.data.stream.mp4; 
            
            if (hlsUrl) {
                return res.json({ 
                    success: true, mode: 'native', 
                    streamUrl: `${proxyBase}${encodeURIComponent(hlsUrl)}`,
                    downloadUrl: mp4Url ? `${proxyBase}${encodeURIComponent(mp4Url)}` : null 
                });
            }
        }
    } catch (e) { }

    // Method 2: VidSrc (TV Show Fallback)
    try {
        let vidsrcApi = `https://vidsrc.cc/api/source/${id}`;
        if (type === 'tv') vidsrcApi = `https://vidsrc.cc/api/source/${id}?s=${season}&e=${episode}`;
        const vidsrcRes = await axios.get(vidsrcApi, { timeout: 4000 });
        
        if (vidsrcRes.data?.data?.source) {
            return res.json({ 
                success: true, mode: 'native', 
                streamUrl: `${proxyBase}${encodeURIComponent(vidsrcRes.data.data.source)}`,
                downloadUrl: null 
            });
        }
    } catch (e) { }

    // Method 3: Iframe Fallback
    let iframeUrls = type === 'movie' 
        ? [`https://vidsrc.to/embed/movie/${id}`, `https://www.2embed.cc/embed/${id}`]
        : [`https://vidsrc.to/embed/tv/${id}/${season}/${episode}`, `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}`];

    return res.json({ success: true, mode: 'iframe', iframeUrls: iframeUrls, downloadUrl: null });
});

// 7. PROXY
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
