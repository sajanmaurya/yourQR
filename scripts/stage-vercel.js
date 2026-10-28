// Keep Vite's normal dist output for local Node hosting. On Vercel, copy it
// to public/ where the platform's static CDN can serve it alongside Express.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const source = 'dist', target = 'public';
if (!existsSync(join(source, 'index.html'))) throw new Error('Run npm run build before staging Vercel assets.');
mkdirSync(target, { recursive: true });
rmSync(join(target, 'assets'), { recursive: true, force: true });
rmSync(join(target, 'index.html'), { force: true });
for (const item of readdirSync(source)) {
  cpSync(join(source, item), join(target, item), { recursive: true, force: true });
}
console.log('Vite build staged for Vercel public/ static CDN.');
