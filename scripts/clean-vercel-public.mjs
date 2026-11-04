import { rm } from 'node:fs/promises';

await Promise.all([
  rm(new URL('../public/index.html', import.meta.url), { force: true }),
  rm(new URL('../public/assets', import.meta.url), { recursive: true, force: true }),
]);
