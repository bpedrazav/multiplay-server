const express = require('express');
const cors    = require('cors');
const http    = require('https'); // built-in, no dependency issues
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Helper: fetch with timeout using built-in https ──────────────────────────
function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MultiPlay/1.0)',
        'Referer': 'https://gogoanime.hu/',
        ...(options.headers || {})
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        fetchWithTimeout(res.headers.location, options, timeoutMs).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ ok: res.statusCode < 400, status: res.statusCode, text: () => Promise.resolve(data), json: () => Promise.resolve(JSON.parse(data)) });
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ── Consumet-compatible sources via direct gogoanime scraping ─────────────────
// Use multiple working API alternatives
const APIS = [
  // Consumet self-hosted alternatives that are actually working
  'https://consumet-api-pi.vercel.app',
  'https://consumet.api.consumet.org',
  'https://api.consumet.org',
];

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'MultiPlay Anime Server', version: '2.0' });
});

// ── Watch episode — tries all APIs ───────────────────────────────────────────
app.get('/anime/watch/:episodeId', async (req, res) => {
  const { episodeId } = req.params;
  const errors = [];

  for (const api of APIS) {
    try {
      const url = `${api}/anime/gogoanime/watch/${encodeURIComponent(episodeId)}`;
      console.log(`Trying: ${url}`);
      const r = await fetchWithTimeout(url, {}, 14000);
      if (!r.ok) { errors.push(`${api}: HTTP ${r.status}`); continue; }
      const data = await r.json();

      if (!data.sources || !data.sources.length) {
        errors.push(`${api}: no sources`); continue;
      }

      // Sort by quality
      const qOrder = ['1080p','720p','480p','360p','default','backup'];
      data.sources.sort((a, b) => {
        const ai = qOrder.indexOf(a.quality); const bi = qOrder.indexOf(b.quality);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });

      console.log(`Success from ${api}: ${data.sources.length} sources`);
      return res.json(data);
    } catch(e) { errors.push(`${api}: ${e.message}`); continue; }
  }

  console.log('All APIs failed:', errors);
  return res.status(503).json({ error: 'No sources found', details: errors });
});

// ── Proxy M3U8 stream to fix CORS ─────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const decoded = decodeURIComponent(url);
    const mod = decoded.startsWith('https') ? require('https') : require('http');
    const upstream = mod.get(decoded, {
      headers: {
        'Referer': 'https://gogoanime.hu/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    }, (upRes) => {
      res.set('Content-Type', upRes.headers['content-type'] || 'application/vnd.apple.mpegurl');
      res.set('Access-Control-Allow-Origin', '*');
      upRes.pipe(res);
    });
    upstream.on('error', (e) => res.status(502).send('Proxy error: ' + e.message));
  } catch(e) { res.status(502).send('Error: ' + e.message); }
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get('/anime/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  for (const api of APIS) {
    try {
      const url = `${api}/anime/gogoanime/${encodeURIComponent(q)}`;
      const r = await fetchWithTimeout(url, {}, 10000);
      if (!r.ok) continue;
      const data = await r.json();
      return res.json(data);
    } catch(e) { continue; }
  }
  return res.status(503).json({ error: 'Search failed' });
});

app.listen(PORT, () => console.log(`MultiPlay server v2 running on port ${PORT}`));

