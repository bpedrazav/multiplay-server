const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Public Consumet API instances (fallback chain)
const CONSUMET_HOSTS = [
  'https://api.consumet.org',
  'https://consumet-api.onrender.com',
  'https://consumet.herokuapp.com'
];

app.use(cors({ origin: '*' }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'MultiPlay Anime Server' });
});

// Search anime by title → returns AniList ID + info
app.get('/anime/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  for (const host of CONSUMET_HOSTS) {
    try {
      const url = `${host}/anime/gogoanime/${encodeURIComponent(q)}`;
      const r = await fetch(url, { timeout: 8000 });
      if (!r.ok) continue;
      const data = await r.json();
      return res.json(data);
    } catch (e) { continue; }
  }
  return res.status(503).json({ error: 'All Consumet hosts failed' });
});

// Get episode list for a gogoanime anime ID
app.get('/anime/info/:id', async (req, res) => {
  const { id } = req.params;
  for (const host of CONSUMET_HOSTS) {
    try {
      const url = `${host}/anime/gogoanime/info/${encodeURIComponent(id)}`;
      const r = await fetch(url, { timeout: 10000 });
      if (!r.ok) continue;
      const data = await r.json();
      return res.json(data);
    } catch (e) { continue; }
  }
  return res.status(503).json({ error: 'All Consumet hosts failed' });
});

// Get streaming sources for a specific episode
app.get('/anime/watch/:episodeId', async (req, res) => {
  const { episodeId } = req.params;
  for (const host of CONSUMET_HOSTS) {
    try {
      const url = `${host}/anime/gogoanime/watch/${encodeURIComponent(episodeId)}`;
      const r = await fetch(url, { timeout: 10000 });
      if (!r.ok) continue;
      const data = await r.json();
      // Return sources sorted: 1080p > 720p > 480p > 360p
      if (data.sources && data.sources.length > 0) {
        const qualities = ['1080p', '720p', '480p', '360p', 'default', 'backup'];
        data.sources.sort((a, b) => {
          const ai = qualities.indexOf(a.quality);
          const bi = qualities.indexOf(b.quality);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
      }
      return res.json(data);
    } catch (e) { continue; }
  }
  return res.status(503).json({ error: 'All Consumet hosts failed' });
});

// Proxy video stream to avoid CORS issues
app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const decoded = decodeURIComponent(url);
    const upstream = await fetch(decoded, {
      headers: {
        'Referer': 'https://gogoanime.hu/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
      },
      timeout: 15000
    });

    res.set('Content-Type', upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    upstream.body.pipe(res);
  } catch (e) {
    res.status(502).send('Proxy error: ' + e.message);
  }
});

app.listen(PORT, () => {
  console.log(`MultiPlay server running on port ${PORT}`);
});
