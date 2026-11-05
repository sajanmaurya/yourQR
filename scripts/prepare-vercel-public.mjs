import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const publicDir = path.join(root, 'public');
await mkdir(publicDir, { recursive: true });
// HTML goes through Express so its CSP uses the configured Clerk hostname.
// Hashed JS/CSS still use Vercel's static CDN.
await cp(path.join(dist, 'assets'), path.join(publicDir, 'assets'), { recursive: true });
