import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from './app.js';
import { postgresSchema } from './database.js';

// Real PostgreSQL query semantics in an isolated WASM database. Blob transport is
// simulated: live Neon connectivity, Vercel routing and Blob credentials need a deployment smoke test.
test('hosted PostgreSQL workspace and private PDF lifecycle', async t => {
  const pg = new PGlite();
  await pg.exec(postgresSchema);
  await pg.exec(postgresSchema); // DDL can be rerun by another cold start.
  const objects = new Map();
  const blobStore = {
    async put(pathname, bytes) { objects.set(pathname, Buffer.from(bytes)); return { pathname }; },
    async handleUpload({ body, onBeforeGenerateToken }) { return onBeforeGenerateToken(body.pathname); },
    async get(pathname) {
      const bytes = objects.get(pathname);
      if (!bytes) return null;
      let offset = 0;
      return { stream: new ReadableStream({ pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + 65536)); offset += 65536;
      } }) };
    },
    async del(pathname) { objects.delete(pathname); },
  };
  const db = { driver: 'postgres', pool: { query: pg.query.bind(pg) }, close: async () => {} };
  const options = { db, blobStore, publicBaseUrl: 'https://qori.example', environment: 'production', secureCookie: false, setupToken: 'test-bootstrap-token' };
  const app = createApp(options);
  const servers = [];
  async function listen(application) {
    const server = await new Promise(resolve => { const s = application.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  const base = await listen(app);
  t.after(async () => { for (const server of servers) await new Promise(resolve => server.close(resolve)); await pg.close(); });
  let cookie = '';
  async function request(route, { method = 'GET', body, headers = {}, authenticated = true, origin = base } = {}) {
    const response = await fetch(origin + route, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(authenticated ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  async function json(route, options, status = 200) {
    const response = await request(route, options);
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  const account = { name: 'Hosted Test', email: 'test@example.com', password: 'secure-hosted-test-password', setupToken: options.setupToken };
  await t.test('setup, secure origins, folders and static/dynamic codes', async () => {
    assert.equal((await request('/api/qrs')).status, 401);
    await json('/api/auth/setup', { method: 'POST', body: account }, 201);
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: account })).status, 409);
    const session = await json('/api/auth/session');
    assert.equal(session.config.database, 'PostgreSQL');
    assert.equal(session.config.blobUploads, true);
    const health = await request('/api/health');
    assert.match(health.headers.get('content-security-policy'), /https:\/\/vercel.com\/api\/blob/);
    assert.equal((await request('/api/folders', { method: 'POST', body: { name: 'Bad' }, headers: { origin: 'https://evil.example' } })).status, 403);
    const { folder } = await json('/api/folders', { method: 'POST', body: { name: 'Documents' } }, 201);
    await json('/api/folders', { method: 'POST', body: { name: 'documents' } }, 409);
    await json('/api/folders/' + folder.id, { method: 'PATCH', body: { name: 'PDFs' } });
    const { qr } = await json('/api/qrs', { method: 'POST', body: { name: 'Website', type: 'dynamic', contentType: 'url', destination: 'https://example.com/one', folderId: folder.id } }, 201);
    await json('/api/qrs/' + qr.id, { method: 'PATCH', body: { destination: 'https://example.com/two' } });
    assert.equal((await request('/r/' + qr.slug)).headers.get('location'), 'https://example.com/two');
    const analytics = await json('/api/analytics');
    assert.equal(analytics.totalScans, 1);
    assert.equal(analytics.recent[0].qrName, 'Website');
    assert.ok(analytics.recent[0].scannedAt);
    assert.equal((await json('/api/folders')).folders[0].qrCount, 1);
    const stat = await json('/api/qrs', { method: 'POST', body: { name: 'Text', type: 'static', contentType: 'text', destination: 'hello' } }, 201);
    for (const format of ['png', 'svg']) assert.equal((await request(`/api/qrs/${stat.qr.id}/download?format=${format}`)).status, 200);
    assert.equal((await json('/api/export')).qrs.length, 2);
    await json('/api/qrs/' + qr.id, { method: 'DELETE' });
    await json('/api/folders/' + folder.id, { method: 'DELETE' });
  });
  let pdfPath, pdfAsset, pdfQr;
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(8 * 1024 * 1024, 32), Buffer.from('\n%%EOF')]);
  async function upload(bytes, type = 'pdf', name = 'document.pdf') {
    const intent = await json('/api/assets/upload-intent', { method: 'POST', body: { type, name } }, 201);
    const permissions = await json('/api/assets/upload-token', { method: 'POST', body: intent });
    assert.equal(permissions.allowOverwrite, false);
    objects.set(intent.pathname, bytes);
    const { asset } = await json('/api/assets/finalize', { method: 'POST', body: intent }, 201);
    return { ...intent, asset };
  }
  await t.test('large PDF, idempotent finalization, ranges and analytics', async () => {
    const smallPdf = Buffer.from('%PDF-1.4\nsmall same-site upload\n%%EOF');
    const smallResponse = await fetch(base + '/api/assets?type=pdf', { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'X-File-Name': 'small.pdf' }, body: smallPdf });
    const smallResult = await smallResponse.json();
    assert.equal(smallResponse.status, 201, JSON.stringify(smallResult));
    const stored = await pg.query('SELECT bytes,blob_path,user_id FROM user_assets WHERE id=$1', [smallResult.asset.id]);
    assert.equal(stored.rows[0].bytes, null);
    assert.deepEqual(objects.get(stored.rows[0].blob_path), smallPdf);
    assert.equal((await request('/api/assets/upload-intent', { method: 'POST', body: { type: 'pdf' }, authenticated: false })).status, 401);
    assert.equal((await request('/api/assets', { method: 'POST', body: {} })).status, 400);
    assert.equal((await request('/api/assets/upload-token', { method: 'POST', body: { pathname: 'assets/owner-1/unknown.pdf' } })).status, 400);
    const result = await upload(pdf);
    pdfPath = result.pathname; pdfAsset = result.asset;
    assert.equal(typeof pdfAsset.size, 'number');
    const retries = await Promise.all([1, 2].map(() => json('/api/assets/finalize', { method: 'POST', body: { pathname: pdfPath } })));
    assert.equal(retries[0].asset.id, pdfAsset.id); assert.equal(retries[1].asset.id, pdfAsset.id);
    assert.equal((await request('/files/' + pdfAsset.id)).status, 404);
    pdfQr = (await json('/api/qrs', { method: 'POST', body: { name: 'PDF document', type: 'dynamic', contentType: 'pdf', assetId: pdfAsset.id } }, 201)).qr;
    const response = await request('/files/' + pdfAsset.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
    const range = await request('/files/' + pdfAsset.id, { headers: { range: 'bytes=3-17' } });
    assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), pdf.subarray(3, 18));
    const suffix = await request('/files/' + pdfAsset.id, { headers: { range: 'bytes=-5' } });
    assert.equal(await suffix.text(), '%%EOF');
    assert.equal((await request('/files/' + pdfAsset.id, { headers: { range: 'bytes=9000000-' } })).status, 416);
    const head = await request('/files/' + pdfAsset.id, { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), pdf.length);
    assert.equal((await request('/api/assets/' + pdfAsset.id, { method: 'DELETE' })).status, 409);
    assert.equal((await request('/r/' + pdfQr.slug)).headers.get('location'), 'https://qori.example/files/' + pdfAsset.id);
  });
  await t.test('replacement, pause, missing objects and rejected file contents', async () => {
    const replacement = await upload(Buffer.from('%PDF-1.4\nreplacement\n%%EOF'));
    const updated = (await json('/api/qrs/' + pdfQr.id, { method: 'PATCH', body: { assetId: replacement.asset.id } })).qr;
    assert.equal(updated.encodedValue, pdfQr.encodedValue);
    assert.equal((await request('/files/' + pdfAsset.id)).status, 404);
    await json('/api/assets/' + pdfAsset.id, { method: 'DELETE' });
    assert.equal(objects.has(pdfPath), false);
    await json('/api/qrs/' + pdfQr.id, { method: 'PATCH', body: { active: false } });
    assert.equal((await request('/r/' + pdfQr.slug)).status, 410);
    assert.equal((await request('/files/' + replacement.asset.id)).status, 404);
    await json('/api/qrs/' + pdfQr.id, { method: 'PATCH', body: { active: true } });
    objects.delete(replacement.pathname);
    const missing = await request('/files/' + replacement.asset.id);
    assert.equal(missing.status, 404); assert.match(await missing.text(), /File not found/);
    const intent = await json('/api/assets/upload-intent', { method: 'POST', body: { type: 'pdf', name: 'fake.pdf' } }, 201);
    objects.set(intent.pathname, Buffer.from('<html>not a PDF</html>'));
    await json('/api/assets/finalize', { method: 'POST', body: intent }, 400);
    assert.equal((await pg.query('SELECT COUNT(*) AS count FROM assets WHERE blob_path=$1', [intent.pathname])).rows[0].count, 0);
  });
  await t.test('sessions and login throttling survive a second Function instance', async () => {
    const other = await listen(createApp(options));
    assert.equal((await json('/api/auth/session', { origin: other })).authenticated, true);
    await json('/api/auth/logout', { method: 'POST', origin: other });
    assert.equal((await request('/api/qrs')).status, 401);
    await json('/api/auth/login', { method: 'POST', body: account });
    for (let i = 0; i < 12; i++) assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: account.email, password: 'wrong' }, origin: i % 2 ? other : base })).status, 401);
    assert.equal((await request('/api/auth/login', { method: 'POST', body: account, origin: other })).status, 429);
  });
});
