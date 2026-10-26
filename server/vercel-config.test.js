import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Vercel serves the homepage from the CDN, with API close to Neon', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.framework, 'express');
  assert.deepEqual(config.functions['index.js'].regions, ['iad1']);
  assert.ok(config.rewrites.some(r => r.source === '/' && r.destination === '/index.html'));
});

test('PostgreSQL connection startup has a rejection handler', () => {
  const source = readFileSync(new URL('./postgres.js', import.meta.url), 'utf8');
  assert.match(source, /db\.ready\.catch\(\(\) => \{\}\)/);
});
