const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(cors());
app.use(express.json());

const TMDB_API = '04c35731a5ee918f014970082a0088b1';

// 1. CATALOGUE
app.get('/api/catalogue', async (req, res) => {
    const { category, type = 'movie', page = 1 } = req.query;
    try {
        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;
        if (category === 'trending') url = `https://api.themoviedb.org/3/trending/${type}/week?api_key=${TMDB_API}&page=${page}`;
        if (category === 'dubbed') url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&with_keywords=234265&without_original_language=en`;
        if (category === 'anime') url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API}&page=${page}&with_genres=16&with_original_language=ja`;

        const response = await axios.get(url, { timeout: 8000 });
        res.json({ results: response.data.results });
    } catch (error) { res.status(500).json({ error: "Catalogue fetch failed" }); }
});

// 2. SPORTS
app.get('/api/sports', async (req, res) => {
    try {
        const response = await axios.get('https://www.thesportsdb.com/api/v1/json/3/livescore.php?s=Soccer');
        res.json({ matches: response.data.events || [] });
    } catch (error) { res.status(500).json({ error: "Sports fetch failed" }); }
});

// 3. SMART DOWNLOADER (Render Compatible)
app.get('/api/download', async (req, res) => {
    let { title } = req.query;
    if (!title) return res.status(400).json({ error: "Title required" });

    // Sanitize title to fix search failures
    let cleanTitle = title.replace(/\(\d{4}\)/g, '').replace(/\d{4}/g, '').replace(/[^\w\s]/gi, '').trim();
    
    let browser;
    try {
        // Render-specific Chromium setup
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });
        
        const page = await browser.newPage();
        let dlLink = null;
        
        page.on('request', req => {
            if (req.url().match(/\.(mp4|mkv)(\?.*)?$/i)) dlLink = req.url();
        });

        // networkidle2 waits for Cloudflare to finish
        await page.goto(`https://fzmovies.net/search.php?searchname=${encodeURIComponent(cleanTitle)}`, { waitUntil: 'networkidle2', timeout: 60000 });
        
        const movieLink = await page.evaluate(() => document.querySelector('a[href*="movie-"]')?.href);
        
        if (movieLink) {
            await page.goto(movieLink, { waitUntil: 'networkidle2', timeout: 60000 });
            const dlPage = await page.evaluate(() => document.querySelector('a[href*="download"]')?.href);
            if (dlPage) await page.goto(dlPage, { waitUntil: 'networkidle2', timeout: 60000 });
        }

        await browser.close();
        
        if (dlLink) return res.json({ success: true, url: dlLink });
        res.status(404).json({ error: "Link not found" });
    } catch (e) {
        if (browser) await browser.close();
        res.status(500).json({ error: "Scraper failed" });
    }
});

// 4. PROXY
app.get('/proxy', async (req, res) => {
    let url = req.query.url;
    if (!url.startsWith('http')) url = Buffer.from(url, 'base64').toString('utf8');
    try {
        const response = await axios({ method: 'get', url, responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });
        response.data.pipe(res);
    } catch (e) { res.status(500).send('Proxy error'); }
});

app.listen(process.env.PORT || 3000, () => console.log('V8 Render Server Running'));
