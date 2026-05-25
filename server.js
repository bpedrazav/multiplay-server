const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── HTTP GET helper ───────────────────────────────────────────────────────────
function get(url, extraHeaders = {}, ms = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const timer  = setTimeout(() => reject(new Error('Timeout ' + ms + 'ms')), ms);

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        'Connection':      'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        ...extraHeaders
      }
    };

    const req = mod.request(options, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        clearTimeout(timer);
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return get(next, extraHeaders, ms).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end',  () => { clearTimeout(timer); resolve({ status: res.statusCode, ok: res.statusCode < 400, body, headers: res.headers }); });
    });

    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// ── Decrypt gogoanime stream (they use AES encryption on the URLs) ────────────
function decryptUrl(input, key, iv) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc',
      Buffer.from(key, 'utf8'),
      Buffer.from(iv,  'utf8')
    );
    let dec = decipher.update(input, 'base64', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch(e) {
    return null;
  }
}

// Keys used by gogoanime embed player (public, reverse engineered)
const GOGO_KEYS = {
  key:       'UIVoTRDosArmFeshkdLrvcoj',   // 24 bytes -> use 32 by padding
  secondKey: 'RRFHEFE@#@:FFFD3333LLDDDERRR',
  iv:        '@@#@^@^#^@@@^@^@'
};

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ status: 'ok', service: 'MultiPlay Anime v4' }));

// ── /anime/watch/:episodeId ───────────────────────────────────────────────────
app.get('/anime/watch/:episodeId', async (req, res) => {
  const epId = decodeURIComponent(req.params.episodeId);
  console.log('[watch]', epId);
  const errors  = [];
  let   sources = [];

  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGY 1: emb.gogocdn.net embed (no Cloudflare, no auth needed)
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const embedUrl = `https://emb.gogocdn.net/embed/${epId}`;
    console.log('[S1] Fetching embed:', embedUrl);
    const embed = await get(embedUrl, { 'Referer': 'https://anitaku.pe/' });

    if (embed.ok && embed.body.length > 100) {
      console.log('[S1] Embed page size:', embed.body.length);

      // Extract the streaming.php link (contains encrypted params)
      const streamMatch = embed.body.match(/https?:\/\/[^"'\s]*streaming\.php[^"'\s]*/);
      const streamUrl   = streamMatch ? streamMatch[0].replace(/&amp;/g, '&') : null;
      console.log('[S1] Stream URL:', streamUrl ? 'found' : 'not found');

      if (streamUrl) {
        const streamPage = await get(streamUrl, {
          'Referer': embedUrl,
          'X-Requested-With': 'XMLHttpRequest'
        });

        if (streamPage.ok) {
          // Extract all m3u8 URLs
          const m3u8s = [...streamPage.body.matchAll(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g)];
          for (const m of m3u8s) {
            const u = m[0].replace(/&amp;/g, '&');
            if (!sources.find(s => s.url === u)) {
              const q = u.includes('1080') ? '1080p' : u.includes('720') ? '720p' : u.includes('480') ? '480p' : 'auto';
              sources.push({ url: u, isM3U8: true, quality: q });
            }
          }

          // Also try jwplayer sources
          const jwMatch = streamPage.body.match(/jwplayer\([^)]+\)\.setup\((\{[\s\S]+?\})\)/);
          if (jwMatch) {
            try {
              const cfg = JSON.parse(jwMatch[1].replace(/'/g, '"'));
              if (cfg.sources) {
                for (const s of cfg.sources) {
                  if (s.file && !sources.find(x => x.url === s.file)) {
                    sources.push({ url: s.file, isM3U8: s.file.includes('.m3u8'), quality: s.label || 'auto' });
                  }
                }
              }
            } catch(e) {}
          }

          console.log('[S1] Sources from streamPage:', sources.length);
        }
      }

      // Fallback: look for m3u8 directly in embed page
      if (!sources.length) {
        const directM3u8 = [...embed.body.matchAll(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g)];
        for (const m of directM3u8) {
          const u = m[0];
          if (!sources.find(s => s.url === u)) sources.push({ url: u, isM3U8: true, quality: 'auto' });
        }
        console.log('[S1] Direct m3u8 from embed:', sources.length);
      }
    }
  } catch(e) { errors.push('S1: ' + e.message); console.log('[S1] Error:', e.message); }

  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGY 2: Use gogocdn AJAX to get video server, then get stream
  // ─────────────────────────────────────────────────────────────────────────
  if (!sources.length) {
    try {
      // The gogocdn embed also has a secondary server fetch endpoint
      const ajaxEmbed = `https://ajax.gogocdn.net/embed/${epId}`;
      const ae = await get(ajaxEmbed, { 'Referer': 'https://anitaku.pe/' });
      if (ae.ok) {
        const m3u8s = [...ae.body.matchAll(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g)];
        for (const m of m3u8s) {
          sources.push({ url: m[0], isM3U8: true, quality: 'auto' });
        }
        console.log('[S2] Ajax embed sources:', sources.length);
      }
    } catch(e) { errors.push('S2: ' + e.message); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGY 3: Try the anime.js API (a working public endpoint)
  // ─────────────────────────────────────────────────────────────────────────
  if (!sources.length) {
    try {
      // Some public Consumet mirrors on Vercel (different from the dead ones)
      const mirrors = [
        'https://consumet-api-one-eta.vercel.app',
        'https://consumet-pi.vercel.app',
        'https://consumet-3qp9.vercel.app',
      ];
      for (const mirror of mirrors) {
        try {
          const r = await get(`${mirror}/anime/gogoanime/watch/${encodeURIComponent(epId)}`, {}, 10000);
          if (r.ok) {
            const j = JSON.parse(r.body);
            if (j.sources && j.sources.length) {
              sources = j.sources;
              console.log('[S3] Mirror sources:', mirror, sources.length);
              break;
            }
          }
        } catch(e) { continue; }
      }
    } catch(e) { errors.push('S3: ' + e.message); }
  }

  if (sources.length) {
    const qOrder = ['1080p','720p','480p','360p','auto'];
    sources.sort((a,b) => {
      const ai = qOrder.indexOf(a.quality); const bi = qOrder.indexOf(b.quality);
      return (ai<0?99:ai)-(bi<0?99:bi);
    });
    console.log('[done] Returning', sources.length, 'sources');
    return res.json({ sources });
  }

  console.log('[done] No sources. Errors:', errors);
  return res.status(404).json({ sources: [], errors });
});

// ── /proxy?url= — proxies m3u8 + rewrites segment URLs ───────────────────────
app.get('/proxy', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('Missing url');

  try {
    const url     = decodeURIComponent(raw);
    const isM3U8  = url.includes('.m3u8');
    const parsed  = new URL(url);
    const mod     = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer':    'https://anitaku.pe/',
        'Origin':     'https://anitaku.pe',
        'Accept':     '*/*'
      }
    };

    const upReq = mod.request(options, (upRes) => {
      const ct = upRes.headers['content-type'] || (isM3U8 ? 'application/vnd.apple.mpegurl' : 'video/MP2T');
      res.set('Content-Type', ct);
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-cache');

      if (isM3U8) {
        // Rewrite segment and sub-playlist URLs through our proxy
        const base = url.substring(0, url.lastIndexOf('/') + 1);
        const host = `${req.protocol}://${req.get('host')}`;
        let body = '';
        upRes.setEncoding('utf8');
        upRes.on('data', c => body += c);
        upRes.on('end', () => {
          const rewritten = body.replace(/^([^#].+)$/gm, (line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            const absUrl = trimmed.startsWith('http') ? trimmed : base + trimmed;
            return `${host}/proxy?url=${encodeURIComponent(absUrl)}`;
          });
          res.send(rewritten);
        });
      } else {
        upRes.pipe(res);
      }
    });

    upReq.on('error', e => { if (!res.headersSent) res.status(502).send(e.message); });
    upReq.end();
  } catch(e) { res.status(500).send(e.message); }
});

app.listen(PORT, () => console.log('MultiPlay Anime v4 on port', PORT));
