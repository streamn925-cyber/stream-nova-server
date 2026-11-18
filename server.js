const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); 

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors());
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', limiter);

const TMDB_API = '04c35731a5ee918f014970082a0088b1';

app.get('/health', (req, res) => res.status(200).json({ status: 'OK', uptime: process.uptime() }));

app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');
    if (!targetUrl.startsWith('http')) targetUrl = Buffer.from(targetUrl, 'base64').toString('utf8');

    const isM3U8 = targetUrl.includes('.m3u8');
    const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Origin': new URL(targetUrl).origin, 'Referer': new URL(targetUrl).origin + '/' };
    const currentHost = req.get('host');
    const protocol = req.protocol;

    try {
        if (isM3U8) {
            const response = await axios.get(targetUrl, { headers: HEADERS });
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
                    const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
                    line = `${protocol}://${currentHost}/proxy?url=${encodedUrl}`;
                }
                newLines.push(line);
            }
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.send(newLines.join('\n'));
        } else {
            const range = req.headers.range;
            if (range) HEADERS['Range'] = range;
            const response = await axios({ method: 'GET', url: targetUrl, headers: HEADERS, responseType: 'stream' });
            res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
            if (response.headers['content-range']) { res.setHeader('Content-Range', response.headers['content-range']); res.status(206); }
            res.setHeader('Access-Control-Allow-Origin', '*');
            response.data.pipe(res);
        }
    } catch (error) { res.status(500).send('Stream blocked'); }
});

app.get('/api/discover', async (req, res) => {
    try {
        const { type = 'movie', category, page = 1 } = req.query;
        const cacheKey = `discover_${type}_${category}_${page}`;
        const cachedData = cache.get(cacheKey);
        if (cachedData) return res.json(cachedData);

        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;
        if (category === 'trending') url = `https://api.themoviedb.org/3/trending/${type}/week?api_key=${TMDB_API}&page=${page}`;
        else if (category === 'dubbed_en') url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&with_keywords=234265&without_original_language=en&sort_by=popularity.desc`;
        
        const response = await axios.get(url, { timeout: 8000 });
        const data = { results: response.data.results };
        cache.set(cacheKey, data);
        res.json(data);
    } catch (error) { 
        const fallback = cache.get('discover_movie_trending_1');
        if (fallback) return res.json(fallback);
        res.status(502).json({ error: "Catalogue service temporarily unavailable." }); 
    }
});

app.get('/api/details', async (req, res) => {
    try {
        const { id, type } = req.query;
        const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API}&append_to_response=credits,similar,videos`;
        const response = await axios.get(url, { timeout: 8000 });
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: "Failed to load details" }); }
});

app.get('/api/download', async (req, res) => {
    const { title, site } = req.query;
    if (!title || !site) return res.status(400).json({ error: "Title and site required" });

    let browser = null;
    try {
        const executablePath = await chromium.executablePath();
        browser = await puppeteer.launch({
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            defaultViewport: chromium.defaultViewport,
            executablePath: executablePath,
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        let downloadLink = null;

        page.on('request', (request) => {
            const url = request.url();
            if (url.match(/\.(mp4|mkv|avi)(\?.*)?$/i)) {
                downloadLink = url;
            }
        });

        if (site === 'fzmovies') {
            await page.goto(`https://fzmovies.net/search.php?searchname=${encodeURIComponent(title)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            const movieLink = await page.evaluate(() => document.querySelector('a[href*="movie-"]')?.href);
            
            if (movieLink) {
                await page.goto(movieLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const dlPageLink = await page.evaluate(() => document.querySelector('a[href*="download"]')?.href || document.querySelector('a:contains("Download")')?.href);
                
                if (dlPageLink) {
                    await page.goto(dlPageLink, { waitUntil: 'networkidle2', timeout: 45000 });
                }
            }
        } 
        
        if (site === 'goojara' && !downloadLink) {
            await page.goto(`https://goojara.to/?s=${encodeURIComponent(title)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            const resultLink = await page.evaluate(() => document.querySelector('a[href*="/movie/"]')?.href);
            
            if (resultLink) {
                await page.goto(resultLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.evaluate(() => {
                    const btn = document.querySelector('button.play-button') || document.querySelector('.play-icon');
                    if (btn) btn.click();
                });
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        await browser.close();

        if (downloadLink) {
            return res.json({ success: true, downloadUrl: downloadLink });
        }
        res.status(404).json({ error: "Direct download link not found." });

    } catch (error) {
        if (browser) await browser.close();
        console.error(`Live Trace Error (${site}):`, error.message);
        res.status(500).json({ error: "Scraper blocked or timed out." });
    }
});

app.get('/api/sports', async (req, res) => {
    try {
        const cachedSports = cache.get('sports_live');
        if (cachedSports) return res.json(cachedSports);

        const response = await axios.get('https://www.thesportsdb.com/api/v1/json/3/livescore.php?s=Soccer', { timeout: 8000 });
        const events = response.data.events || [];
        const liveMatches = events.filter(e => e.strStatus !== 'FT' && e.strStatus !== 'NS');
        
        cache.set('sports_live', liveMatches, 60); 
        res.json({ success: true, matches: liveMatches });
    } catch (error) {
        res.status(500).json({ error: "Failed to load sports data." });
    }
});

app.get('/api/live', async (req, res) => {
    try {
        const cachedLive = cache.get('live_tv');
        if (cachedLive) return res.json(cachedLive);

        const { data } = await axios.get('https://iptv-org.github.io/iptv/categories/sports.m3u', { timeout: 10000 });
        const lines = data.split('\n');
        const streams = [];
        let pendingName = null;

        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('#EXTINF:')) {
                pendingName = line.split(',').pop()?.trim() || 'Live Sport';
            } else if (line && !line.startsWith('#') && pendingName) {
                streams.push({ name: pendingName, url: line });
                pendingName = null;
            }
        }

        const formattedStreams = streams.map(s => ({
            name: s.name,
            url: `${req.protocol}://${req.get('host')}/proxy?url=${Buffer.from(s.url).toString('base64')}`
        }));

        cache.set('live_tv', formattedStreams, 3600);
        res.json({ success: true, count: formattedStreams.length, streams: formattedStreams });
    } catch (error) {
        res.status(500).json({ error: "Failed to load live channels." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 STREAMNOVA V7 running on port ${PORT}`));
