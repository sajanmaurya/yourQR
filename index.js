// Vercel auto-detects a default-exported Express app at the repository root.
// This entrypoint never starts a local port listener or writes to the ephemeral filesystem.
import express from 'express';
import { createApp } from './server/app.js';

// Vercel's Express framework detection requires a direct Express import here.
if (typeof express !== 'function') throw new Error('Express runtime unavailable.');

if (!process.env.DATABASE_URL) {
  throw new Error('Vercel requires DATABASE_URL: configure a managed PostgreSQL database.');
}
if (process.env.VERCEL === '1' && (!process.env.PUBLIC_BASE_URL || !process.env.PUBLIC_BASE_URL.startsWith('https://'))) {
  throw new Error('Vercel requires a stable HTTPS PUBLIC_BASE_URL for QR links and session security.');
}

const app = createApp({ distPath: '__vercel_static_assets_are_on_cdn__' });
export default app;
