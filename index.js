// Vercel auto-detects the default-exported Express application here.
// No port listener or ephemeral SQLite storage is used in Vercel Functions.
import express from 'express';
import { createApp } from './server/app.js';

const missingDatabase = !process.env.DATABASE_URL;
const invalidOrigin = process.env.VERCEL === '1' &&
  (!process.env.PUBLIC_BASE_URL || !/^https:\/\/[^/]+\/?$/.test(process.env.PUBLIC_BASE_URL));
const configurationError = missingDatabase
  ? 'The staging PostgreSQL database is not connected.'
  : invalidOrigin
    ? 'The staging HTTPS public URL is not configured.'
    : null;

// Keep the function responsive while the staging environment is configured.
// It must never open local SQLite or reuse production credentials on Vercel.
const app = configurationError ? express() : createApp({ distPath: '__vercel_static_assets_are_on_cdn__' });

if (configurationError) {
  app.disable('x-powered-by');
  app.use((req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('X-Content-Type-Options', 'nosniff');
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ status: 'not_ready', error: 'Qori staging is awaiting its database configuration.' });
    }
    if (req.path.startsWith('/r/') || req.path.startsWith('/files/')) {
      return res.status(503).type('text/plain').send('Qori staging is unavailable. No QR redirection or file was performed.');
    }
    res.status(503).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Qori staging | Setup in progress</title><style>body{margin:0;background:#0b1420;color:#f1f5f9;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:520px;padding:36px}h1{font-size:32px;margin:12px 0}p{color:#cbd5e1;line-height:1.65}.status{color:#5eead4;font-weight:700;letter-spacing:.05em;font-size:13px}</style></head><body><main><div class="status">QORI · PRIVATE PREVIEW</div><h1>Setup in progress</h1><p>${configurationError}</p><p>The production application is not affected. The staging owner needs to configure a dedicated Neon database connection in Vercel Preview before this environment can be used.</p></main></body></html>`);
  });
}

export default app;
