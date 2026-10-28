import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
assert.equal(config.framework, 'express');
assert.equal(config.buildCommand, 'npm run build:vercel');
assert.match(config.functions?.['index.js']?.includeFiles || '', /db\/postgres\/schema\.sql/);
assert.ok(existsSync('public/favicon.svg'), 'Original favicon must remain available');
assert.ok(existsSync('public/index.html'), 'Vite static entry must be staged in public/');
const html = readFileSync('public/index.html', 'utf8');
const scripts = [...html.matchAll(/\bsrc="([^"]+\.js)"/g)].map(x => x[1]);
assert.ok(scripts.length > 0, 'Staged HTML needs a bundled entrypoint');
for (const script of scripts) {
  assert.ok(existsSync(join('public', script.replace(/^\//, ''))), 'Missing JS bundle: ' + script);
}
assert.ok(existsSync('dist/index.html'), 'Local Node deployment must retain dist/index.html');
console.log('Vercel static assets and Express routing configuration look consistent.');

assert.equal(config.functions['index.js'].regions?.[0], 'iad1', 'Backend must run near Neon US East');
assert.match(config.functions['index.js'].includeFiles, /public\/index\.html/, 'Homepage must be included in the function bundle');
assert.match(config.functions['index.js'].includeFiles, /dist\/assets/, 'Compiled JS/CSS must be available in the Function fallback');
const entry = readFileSync('index.js', 'utf8');
assert.match(entry, /app\.get\('\/assets\/:filename'/, 'The Express entrypoint must serve compiled JS and CSS as a fallback');
for (const file of readdirSync('dist/assets')) {
  if (!/\.(?:js|css)$/.test(file)) continue;
  assert.ok(existsSync(join('dist', 'assets', file)), 'Asset missing from the Function bundle: ' + file);
}

