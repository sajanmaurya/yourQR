// A lightweight Vercel entrypoint: React's homepage must not block on Neon.
import express from 'express';
import { readFile } from 'node:fs/promises';
import { createApp } from './server/app.js';

const missingDatabase = !process.env.DATABASE_URL;
const invalidOrigin = process.env.VERCEL === '1' &&
  (!process.env.PUBLIC_BASE_URL || !/^https:\/\/[^/]+\/?$/.test(process.env.PUBLIC_BASE_URL));
const configurationError = missingDatabase
  ? 'The staging PostgreSQL database is not connected.'
  : invalidOrigin
    ? 'The staging HTTPS public URL is not configured.'
    : null;
const app = express();
app.disable('x-powered-by');

if (configurationError) {
  app.use((req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('X-Content-Type-Options', 'nosniff');
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ status: 'not_ready', error: 'yourQR staging is awaiting its database configuration.' });
    }
    if (req.path.startsWith('/r/') || req.path.startsWith('/files/')) {
      return res.status(503).type('text/plain').send('yourQR staging is unavailable. No QR redirection or file was performed.');
    }
    res.status(503).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>yourQR staging | Setup in progress</title><style>body{margin:0;background:#0b1420;color:#f1f5f9;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:520px;padding:36px}h1{font-size:32px;margin:12px 0}p{color:#cbd5e1;line-height:1.65}.status{color:#5eead4;font-weight:700;letter-spacing:.05em;font-size:13px}</style></head><body><main><div class="status">yourQR · PRIVATE PREVIEW</div><h1>Setup in progress</h1><p>${configurationError}</p><p>The production application is not affected. Configure a dedicated Neon database connection in Vercel Preview before this environment can be used.</p></main></body></html>`);
  });
} else {
  // Express uses the root route before database-dependent middleware.
  // Vercel's build stages this file into public/ and bundles it via includeFiles.
  if (process.env.VERCEL === '1') {
    app.get('/', async (_req, res, next) => {
      try {
        const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
        res.set('Cache-Control', 'no-store').type('html').send(html);
      } catch (error) { next(error); }
    });
    // If Vercel did not register post-build Vite bundles as CDN static files,
    // serve the versioned JS/CSS from the Function bundle. Without them, React
    // never mounts and visitors see only a white page.
    app.get('/assets/:filename', async (req, res, next) => {
      const filename = req.params.filename;
      if (!/^[A-Za-z0-9_-]+\.(?:js|css)$/.test(filename)) return res.status(404).type('text/plain').send('Asset not found');
      try {
        const body = await readFile(new URL('./dist/assets/' + filename, import.meta.url));
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.type(filename.endsWith('.js') ? 'application/javascript' : 'text/css').send(body);
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).type('text/plain').send('Asset not found');
        next(error);
      }
    });
    app.get('/favicon.ico', (_req, res) => res.status(204).end());
  }
  app.use(createApp({ distPath: '__vercel_static_assets_are_on_cdn__' }));
}

export default app;
