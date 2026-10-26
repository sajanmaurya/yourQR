import test from 'node:test';
import assert from 'node:assert/strict';

test('Vercel staging without DATABASE_URL responds with actionable 503 instead of crashing', async () => {
  const previous = process.env.DATABASE_URL;
  const previousVercel = process.env.VERCEL;
  const previousOrigin = process.env.PUBLIC_BASE_URL;
  delete process.env.DATABASE_URL;
  process.env.VERCEL = '1';
  process.env.PUBLIC_BASE_URL = 'https://staging.example.com';
  let server;
  try {
    const { default: app } = await import('../index.js');
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const page = await fetch(base + '/');
    assert.equal(page.status, 503);
    assert.match(await page.text(), /staging PostgreSQL database is not connected/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const api = await fetch(base + '/api/auth/me');
    assert.equal(api.status, 503);
    assert.equal((await api.json()).status, 'not_ready');
    const qr = await fetch(base + '/r/important-code', { redirect: 'manual' });
    assert.equal(qr.status, 503);
    assert.equal(qr.headers.get('location'), null);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
    if (previousOrigin === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = previousOrigin;
  }
});
