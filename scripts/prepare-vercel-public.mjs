import { cp, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const publicDir = path.join(root, 'public');
await mkdir(publicDir, { recursive: true });
await copyFile(path.join(dist, 'index.html'), path.join(publicDir, 'index.html'));
await cp(path.join(dist, 'assets'), path.join(publicDir, 'assets'), { recursive: true });
