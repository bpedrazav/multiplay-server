const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpGet(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const mod    = url.startsWith('https') ? https : http;
    const timer  = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
    const opts   = require('url').parse(url);
    opts.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://anitaku.pe/',
      ...headers
    };

    const req = mod.get(opts, (res) => {
      // Follow redirects up to 3 times
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        clearTimeout(timer);
        const next = res.headers.location.startsWith('http') ? res.headers.location : `https://anitaku.pe${res.headers.location}`;
        return httpGet(next, headers, timeoutMs).then(resolve).catch(reject);
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 400, body, headers: res.headers });
      });
    });

    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ status: 'ok', service: 'MultiPlay v4' }));

// ── /anime/watch/:episodeId ────────────────────────────────────────────────────
// Returns direct m3u8 sources — played in <video> tag with ZERO ads
app.get('/anime/watch/:episodeId', async (req, res) => {
  const episodeId = decodeURIComponent(req.params.episodeId);
  console.log('[watch]', episodeId);

  const sources   = [];
  const errors    = [];

  // ── Step 1: Get episode page from anitaku.pe ─────────────────────────────
  let embedUrl = null;
  try {
    const pageUrl  = `https://anitaku.pe/${episodeId}`;
    const page     = await httpGet(pageUrl);

    if (!page.ok) throw new Error(`Page status ${page.status}`);

    // Extract embed server URLs from page
    // Pattern 1: <div class="play-video"><iframe src="...">
    const iframe1  = page.body.match(/class="play-video"[^>]*>[\s\S]*?<iframe[^>]*src="([^"]+)"/);
    // Pattern 2: <li class="servers-sub"><a data-video="...">
    const iframe2  = page.body.match(/data-video="([^"]+gogocdn[^"]+)"/);
    const iframe3  = page.body.match(/data-video="([^"]+vidstreaming[^"]+)"/);
    // Pattern 3: link href in page
    const iframe4  = page.body.match(/https:\/\/emb\.gogocdn\.net\/embed\/[^\s"']+/);

    embedUrl = (iframe1 && iframe1[1]) ||
               (iframe2 && iframe2[1]) ||
               (iframe3 && iframe3[1]) ||
               (iframe4 && iframe4[0]);

    if (embedUrl && embedUrl.startsWith('//')) embedUrl = 'https:' + embedUrl;
    console.log('[watch] embed URL:', embedUrl);
  } catch(e) {
    errors.push('Step1 (page): ' + e.message);
    console.log('[watch] Step1 error:', e.message);
  }

  // ── Step 2: Fetch embed page and extract streaming sources ────────────────
  if (embedUrl) {
    try {
      const embedPage = await httpGet(embedUrl, { 'Referer': 'https://anitaku.pe/' });

      if (embedPage.ok) {
        // Extract m3u8 URLs - multiple patterns
        const m3u8Pattern  = /https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/g;
        const m3u8Matches  = [...embedPage.body.matchAll(m3u8Pattern)];

        for (const m of m3u8Matches) {
          const url = m[0].replace(/\\u002F/g, '/').replace(/&amp;/g, '&');
          if (!sources.find(s => s.url === url)) {
            const quality = url.includes('1080') ? '1080p' : url.includes('720') ? '720p' : url.includes('480') ? '480p' : 'auto';
            sources.push({ url, isM3U8: true, quality });
          }
        }

        // Also look for jwplayer/videojs sources
        const fileMatch = embedPage.body.match(/(?:file|src):\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
        if (fileMatch && !sources.find(s => s.url === fileMatch[1])) {
          sources.push({ url: fileMatch[1], isM3U8: true, quality: 'auto' });
        }

        // Look for encoded/escaped URLs
        const encodedMatch = embedPage.body.match(/\\u0068\\u0074\\u0074\\u0070[\\u0-9a-f]*/);
        if (encodedMatch) {
          try {
            const decoded = JSON.parse('"' + encodedMatch[0] + '"');
            if (decoded.includes('.m3u8')) sources.push({ url: decoded, isM3U8: true, quality: 'auto' });
          } catch(e) {}
        }

        console.log('[watch] Found sources from embed:', sources.length);
      }
    } catch(e) {
      errors.push('Step2 (embed): ' + e.message);
      console.log('[watch] Step2 error:', e.message);
    }
  }

  // ── Step 3: Try Ajax API as fallback ──────────────────────────────────────
  if (!sources.length) {
    try {
      // Get anime category page to find movie_id
      const epParts  = episodeId.match(/^(.+)-episode-(\d+)$/);
      if (epParts) {
        const slug   = epParts[1];
        const epNum  = epParts[2];
        const catUrl = `https://anitaku.pe/category/${slug}`;
        const cat    = await httpGet(catUrl);

        const movieId = (cat.body.match(/value="(\d+)"\s+name="movie_id"/) || [])[1];
        const alias   = (cat.body.match(/value="([^"]+)"\s+name="alias_anime"/) || [])[1];

        if (movieId && alias) {
          const ajaxUrl = `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=${epNum}&ep_end=${epNum}&id=${movieId}&default_ep=0&alias=${alias}`;
          const ajax    = await httpGet(ajaxUrl, { 'X-Requested-With': 'XMLHttpRequest' });

          const href    = (ajax.body.match(/href="\/([^"]+)"/) || [])[1];
          if (href) {
            const epPage  = await httpGet(`https://anitaku.pe/${href}`);
            const m3u8    = epPage.body.match(/https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/);
            if (m3u8) {
              sources.push({ url: m3u8[0], isM3U8: true, quality: 'auto' });
              console.log('[watch] Ajax fallback found source');
            }
          }
        }
      }
    } catch(e) {
      errors.push('Step3 (ajax): ' + e.message);
    }
  }

  if (sources.length) {
    // Sort: 1080p first
    const qOrder = ['1080p','720p','480p','360p','auto'];
    sources.sort((a, b) => {
      const ai = qOrder.indexOf(a.quality); const bi = qOrder.indexOf(b.quality);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    return res.json({ sources, errors });
  }

  return res.status(404).json({ sources: [], errors, message: 'No sources found' });
});

// ── /proxy?url=... — proxy M3U8 segments to fix CORS ─────────────────────────
app.get('/proxy', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('Missing url');

  try {
    const url = decodeURIComponent(rawUrl);
    const mod = url.startsWith('https') ? https : http;
    const parsed = require('url').parse(url);
    parsed.headers = {
      'Referer': 'https://anitaku.pe/',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Origin': 'https://anitaku.pe',
      'Accept': '*/*'
    };

    const upstream = mod.get(parsed, (upRes) => {
      const ct = upRes.headers['content-type'] || 'application/vnd.apple.mpegurl';
      res.set('Content-Type', ct);
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Headers', '*');

      // For m3u8 playlists, rewrite internal URLs to also go through proxy
      if (ct.includes('mpegurl') || rawUrl.includes('.m3u8')) {
        let body = '';
        upRes.setEncoding('utf8');
        upRes.on('data', c => body += c);
        upRes.on('end', () => {
          // Rewrite relative URLs in m3u8 to absolute proxied URLs
          const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
          const rewritten = body.replace(/^([^#\n][^\n]+\.ts[^\n]*)/gm, (line) => {
            if (line.startsWith('http')) {
              return `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(line)}`;
            } else {
              return `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(baseUrl + line)}`;
            }
          }).replace(/^(https?:\/\/[^\n]+\.m3u8[^\n]*)/gm, (line) => {
            return `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(line)}`;
          });
          res.send(rewritten);
        });
      } else {
        upRes.pipe(res);
      }
    });

    upstream.on('error', e => {
      if (!res.headersSent) res.status(502).send('Proxy error: ' + e.message);
    });
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

app.listen(PORT, () => console.log(`MultiPlay v4 running on port ${PORT}`));
