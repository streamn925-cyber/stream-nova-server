const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(cors());
app.use(express.json());

const TMDB_API = '04c35731a5ee918f014970082a0088b1';

// --- 1. HEALTH ---
app.get('/api/health', (req, res) => res.json({ status: 'online', time: new Date() }));

// --- 2. CATALOGUE ---
app.get('/api/catalogue', async (req, res) => {
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
        const data = { success: true, results: response.data.results };
        cache.set(cacheKey, data);
        res.json(data);
    } catch (error) { res.status(500).json({ success: false, error: "Catalogue temporarily unavailable" }); }
});

// --- 3. DETAILS & SEARCH ---
app.get('/api/details', async (req, res) => {
    try {
        const { id, type } = req.query;
        const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API}&append_to_response=credits,similar,videos`;
        const response = await axios.get(url, { timeout: 8000 });
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: "Failed to load details" }); }
});

// --- 4. LIVE SPORTS ---
app.get('/api/sports', async (req, res) => {
    try {
        const cached = cache.get('sports');
        if (cached) return res.json(cached);
        const espnRes = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = { events: espnRes.data.events || [] };
        cache.set('sports', data, 60);
        res.json(data);
    } catch (error) { res.status(500).json({ error: "Sports API Error" }); }
});

// --- 5. STREAMING (For Player) ---
app.get('/api/stream', async (req, res) => {
    const { id, type, season = 1, episode = 1 } = req.query;
    const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

    try {
        let vidLinkUrl = `https://vidlink.pro/api/b/${type}/${id}?lang=en`;
        if (type === 'tv') vidLinkUrl += `/${season}/${episode}`;
        const vidLinkRes = await axios.get(vidLinkUrl, { timeout: 5000 });

        if (vidLinkRes.data?.stream?.playlist) {
            return res.json({ success: true, mode: 'native', streamUrl: `${proxyBase}${encodeURIComponent(vidLinkRes.data.stream.playlist)}` });
        }
    } catch (e) { console.log("VidLink failed, trying fallback..."); }

    return res.status(404).json({ success: false, error: "Stream not available." });
});

// --- 6. DOWNLOAD SCRAPER (Multi-Site Waterfall) ---
app.get('/api/download', async (req, res) => {
    let { title, season, episode } = req.query;
    if (!title) return res.status(400).json({ success: false, error: "Title required" });

    let cleanTitle = title.replace(/\(\d{4}\)/g, '').replace(/\d{4}/g, '').replace(/[^\w\s]/gi, '').trim();
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

    console.log(`Searching for: ${cleanTitle}...`);

    // --- SITE 1: FZMovies ---
    try {
        console.log('Trying Fzmovies...');
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
                if (downloadLink) {
                    console.log('✅ Found on Fzmovies!');
                    return res.json({ success: true, url: downloadLink });
                }
            }
        }
        console.log('❌ Not found on Fzmovies.');
    } catch (e) { console.log('Fzmovies failed:', e.message); }

    // --- SITE 2: Nkiri (WordPress-based) ---
    try {
        console.log('Trying Nkiri...');
        const searchRes = await axios.get(`https://nkiri.com/?s=${encodeURIComponent(cleanTitle)}`, { headers, timeout: 15000 });
        const $ = cheerio.load(searchRes.data);
        const resultLink = $('.post-item a, article a').first().attr('href');

        if (resultLink) {
            const pageRes = await axios.get(resultLink, { headers, timeout: 15000 });
            const $page = cheerio.load(pageRes.data);
            let downloadLink = $page('a[href*="download"], a[href*=".mp4"], .dl-button').first().attr('href');
            
            if (downloadLink) {
                console.log('✅ Found on Nkiri!');
                return res.json({ success: true, url: downloadLink });
            }
        }
        console.log('❌ Not found on Nkiri.');
    } catch (e) { console.log('Nkiri failed:', e.message); }

    // --- SITE 3: NetNaija ---
    try {
        console.log('Trying NetNaija...');
        const searchRes = await axios.get(`https://www.thenetnaija.net/search?q=${encodeURIComponent(cleanTitle)}`, { headers, timeout: 15000 });
        const $ = cheerio.load(searchRes.data);
        const resultLink = $('.search-result a, .post-item a').first().attr('href');

        if (resultLink) {
            const pageRes = await axios.get(resultLink, { headers, timeout: 15000 });
            const $page = cheerio.load(pageRes.data);
            let downloadLink = $page('a[href*="download"], a[href*=".mp4"]').first().attr('href');

            if (downloadLink) {
                console.log('✅ Found on NetNaija!');
                return res.json({ success: true, url: downloadLink });
            }
        }
        console.log('❌ Not found on NetNaija.');
    } catch (e) { console.log('NetNaija failed:', e.message); }

    // --- SITE 4: O2TVSeries ---
    try {
        console.log('Trying O2TVSeries...');
        const searchRes = await axios.get(`https://o2tvseries.com/search/${encodeURIComponent(cleanTitle)}`, { headers, timeout: 15000 });
        const $ = cheerio.load(searchRes.data);
        const showLink = $('.search-result a, .home-article a').first().attr('href');

        if (showLink) {
            const showRes = await axios.get(showLink, { headers, timeout: 15000 });
            const $show = cheerio.load(showRes.data);
            const seasonLink = $show(`a:contains("Season ${season || 1}")`).attr('href');

            if (seasonLink) {
                const seasonRes = await axios.get(seasonLink, { headers, timeout: 15000 });
                const $season = cheerio.load(seasonRes.data);
                const episodeLink = $season(`a:contains("Episode ${episode || 1}")`).attr('href');

                if (episodeLink) {
                    const epRes = await axios.get(episodeLink, { headers, timeout: 15000 });
                    const $ep = cheerio.load(epRes.data);
                    const downloadLink = $ep('a[href*="download"], a[href*=".mp4"]').first().attr('href');

                    if (downloadLink) {
                        console.log('✅ Found on O2TVSeries!');
                        return res.json({ success: true, url: downloadLink });
                    }
                }
            }
        }
        console.log('❌ Not found on O2TVSeries.');
    } catch (e) { console.log('O2TVSeries failed:', e.message); }

    // --- FINAL FALLBACK ---
    console.log('❌ All sites failed for:', cleanTitle);
    return res.status(404).json({ success: false, error: "This title is not available for download on any source." });
});

// --- 7. PROXY (Ad-Stripping) ---
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
                    if (duration < 6.0) continue; // Strip short ads
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

// --- 8. START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 STREAMNOVA SERVER running on port ${PORT}`));
