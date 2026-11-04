import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ReadableStream } from 'node:stream/web';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from './app.js';
import { postgresSchema } from './database.js';

// Controlled, isolated capacity regression: no live Vercel, Neon, users, or billing.
// 425 website redirects + 75 PDF redirects = 500 genuine GET scans.
// Additional PDF streams simulate the download that follows a PDF scan.
test('500 dynamic QR scans with 25 overlapping visitors and private PDF delivery', { timeout: 180000 }, async t => {
  const pg = new PGlite();
  await pg.exec(postgresSchema);
  const objects = new Map();
  const blobStore = {
    async put(pathname, bytes) { objects.set(pathname, Buffer.from(bytes)); return { pathname }; },
    async get(pathname) {
      const data = objects.get(pathname);
      if (!data) return null;
      let offset = 0;
      return { stream: new ReadableStream({
        pull(controller) {
          if (offset >= data.length) { controller.close(); return; }
          controller.enqueue(data.subarray(offset, Math.min(data.length, offset + 65536)));
          offset += 65536;
        },
      }) };
    },
    async del(pathname) { objects.delete(pathname); },
    async handleUpload() { throw new Error('Direct upload is used for the performance fixture.'); },
  };
  const db = { driver: 'postgres', pool: { query: pg.query.bind(pg) }, close: async () => {} };
  const app = createApp({
    db, blobStore, publicBaseUrl: 'https://qr-perf.example', environment: 'test', secureCookie: false,
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pg.close();
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';

  async function json(route, method = 'GET', body) {
    const response = await fetch(origin + route, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const result = await response.json();
    assert.equal(response.status, method === 'POST' ? 201 : 200, JSON.stringify(result));
    return result;
  }

  await json('/api/auth/register', 'POST', {
    name: 'Isolated Load Test', email: 'loadtest@example.com', password: 'load-test-password-12345',
  });
  const { qr: website } = await json('/api/qrs', 'POST', {
    name: 'High-volume URL', type: 'dynamic', contentType: 'url', destination: 'https://example.com/landing',
  });

  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * 1024 * 1024 - 15, 32), Buffer.from('\n%%EOF'),
  ]);
  const uploaded = await fetch(origin + '/api/assets?type=pdf', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'event.pdf' },
    body: pdf,
    signal: AbortSignal.timeout(20000),
  });
  const uploadResult = await uploaded.json();
  assert.equal(uploaded.status, 201, JSON.stringify(uploadResult));
  const { qr: fileQR } = await json('/api/qrs', 'POST', {
    name: 'High-volume PDF', type: 'dynamic', contentType: 'pdf', assetId: uploadResult.asset.id,
  });

  async function parallel(total, concurrency, task) {
    let next = 0;
    const durations = [];
    const started = performance.now();
    await Promise.all(Array.from({ length: Math.min(total, concurrency) }, async () => {
      while (next < total) {
        const index = next++;
        const start = performance.now();
        await task(index);
        durations.push(performance.now() - start);
      }
    }));
    durations.sort((a, b) => a - b);
    const percentile = q => Number(durations[Math.min(durations.length - 1, Math.ceil(durations.length * q) - 1)].toFixed(1));
    return {
      total, concurrency, elapsedMs: Number((performance.now() - started).toFixed(1)),
      p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    };
  }
  const websiteMetrics = await parallel(425, 25, async () => {
    const response = await fetch(origin + '/r/' + website.slug, {
      redirect: 'manual', signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://example.com/landing');
    assert.match(response.headers.get('cache-control'), /no-store/);
    await response.arrayBuffer();
  });
  const fileMetrics = await parallel(75, 25, async () => {
    const response = await fetch(origin + '/r/' + fileQR.slug, {
      redirect: 'manual', signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://qr-perf.example/files/' + uploadResult.asset.id);
    await response.arrayBuffer();
  });

  // A byte-range PDF read exercises the Blob stream rather than downloading
  // hundreds of megabytes merely to verify its delivery behavior.
  const pdfRangeMetrics = await parallel(30, 10, async () => {
    const response = await fetch(origin + '/files/' + uploadResult.asset.id, {
      headers: { range: 'bytes=0-8191' }, signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 206);
    assert.match(response.headers.get('content-type'), /application\/pdf/);
    assert.equal(Number(response.headers.get('content-length')), 8192);
    assert.equal((await response.arrayBuffer()).byteLength, 8192);
  });
  const pdfFullMetrics = await parallel(5, 5, async () => {
    const response = await fetch(origin + '/files/' + uploadResult.asset.id, {
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, pdf.length);
  });

  const head = await fetch(origin + '/r/' + website.slug, { method: 'HEAD', redirect: 'manual' });
  assert.equal(head.status, 302);
  const result = await pg.query('SELECT q.slug,COUNT(s.id)::int AS scans FROM user_qr_codes q LEFT JOIN user_scans s ON s.qr_id=q.id WHERE q.id IN ($1,$2) GROUP BY q.slug', [website.id, fileQR.id]);
  const counts = Object.fromEntries(result.rows.map(r => [r.slug, Number(r.scans)]));
  assert.equal(counts[website.slug], 425);
  assert.equal(counts[fileQR.slug], 75);
  const analytics = await json('/api/analytics');
  assert.equal(analytics.totalScans, 500);
  assert.equal(analytics.series.reduce((sum, day) => sum + day.scans, 0), 500);

  // Pausing a printed code must take effect immediately without an edge cache.
  const paused = await fetch(origin + '/api/qrs/' + fileQR.id, {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ active: false }), signal: AbortSignal.timeout(20000),
  });
  assert.equal(paused.status, 200);
  const blocked = await fetch(origin + '/r/' + fileQR.slug, { redirect: 'manual' });
  assert.equal(blocked.status, 410);
  const blockedFile = await fetch(origin + '/files/' + uploadResult.asset.id);
  assert.equal(blockedFile.status, 404);

  console.log('QR_CAPACITY_REGRESSION ' + JSON.stringify({
    scanned: 500, recorded: analytics.totalScans, failed: 0,
    website: websiteMetrics, pdfRedirect: fileMetrics,
    pdfRange: pdfRangeMetrics, pdfFull: pdfFullMetrics,
    database: 'isolated PGlite PostgreSQL engine (not live Neon)',
  }));
});
