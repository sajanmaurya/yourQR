import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDatabase } from './database.js';
import { registerAssets } from './assets.js';
import { createR2Storage, r2Marker, r2StoredKey, blobBytes } from './r2.js';
import { ValidationError } from './qr.js';

test('R2 requires all settings, keeps internal reference compact and validates keys', () => {
  assert.equal(createR2Storage({}), null);
  assert.throws(() => createR2Storage({ R2_BUCKET: 'some-bucket' }), /partially configured/);
  const key = 'pdf/legacy/6a99821d-6532-4fab-8c3a-aeddf4807e62.pdf';
  assert.deepEqual(r2StoredKey(r2Marker(key, true)), { key, pending: true });
  assert.deepEqual(r2StoredKey(r2Marker(key)), { key, pending: false });
  assert.deepEqual(r2StoredKey('\\x' + r2Marker(key).toString('hex')), { key, pending: false });
  assert.equal(r2StoredKey(Buffer.from('%PDF-1.7')), null);
  assert.throws(() => r2Marker('../other-bucket/secret'), /Invalid/);
  assert.equal(blobBytes({ bytes: '\\x25504446' }).toString('ascii'), '%PDF');
});

test('PDF direct upload finalization is owner-scoped, verified and opens via short R2 redirect', async t => {
  const db = openDatabase(':memory:');
  const calls = { init: [], verified: [], signed: [], deleted: [] };
  const r2 = {
    async initPdf(input) { calls.init.push(input); return { key: 'pdf/legacy/' + input.id + '.pdf', url: 'https://upload.invalid/signed', contentType: 'application/pdf' }; },
    async verifyPdf(input) { calls.verified.push(input); },
    async downloadUrl(key) { calls.signed.push(key); return 'https://downloads.invalid/signed'; },
    async delete(key) { calls.deleted.push(key); },
  };
  const app = express();
  app.use((req, _res, next) => { req.ownerKey = req.get('x-tenant') || 'legacy'; next(); });
  const publicFile = registerAssets(app, db, { r2 });
  app.get('/files/:id', publicFile);
  app.use((error, _req, res, _next) => {
    if (error instanceof ValidationError) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: error.message });
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => db.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (path, data, tenant) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tenant ? { 'X-Tenant': tenant } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const init = await post('/api/assets/r2/init', { kind: 'pdf', name: 'food-menu.pdf', size: 10 * 1024 * 1024 });
  assert.equal(init.status, 201);
  const id = init.body.id;
  assert.equal(calls.init.length, 1);
  assert.equal((await post('/api/assets/r2/complete', { id }, 'other-tenant')).status, 404);
  assert.equal((await fetch(base + '/api/assets/' + id + '/content', { redirect: 'manual' })).status, 404);
  const complete = await post('/api/assets/r2/complete', { id });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.asset.size, 10 * 1024 * 1024);
  assert.equal(calls.verified.length, 1);
  const privateRead = await fetch(base + '/api/assets/' + id + '/content', { redirect: 'manual' });
  assert.equal(privateRead.status, 302);
  assert.equal(privateRead.headers.get('location'), 'https://downloads.invalid/signed');
  assert.equal((await fetch(base + '/files/' + id, { redirect: 'manual' })).status, 404);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO qr_codes(id,name,type,content_type,destination,slug,fg_color,bg_color,active,created_at,updated_at,asset_id,owner_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('qr1', 'Menu', 'dynamic', 'url', 'https://localhost.invalid/files/' + id, 'menu', '#111111', '#ffffff', 1, now, now, id, 'legacy');
  const scannedFile = await fetch(base + '/files/' + id, { redirect: 'manual' });
  assert.equal(scannedFile.status, 302);
  assert.equal(scannedFile.headers.get('location'), 'https://downloads.invalid/signed');
  db.prepare('UPDATE qr_codes SET active=0 WHERE id=?').run('qr1');
  assert.equal((await fetch(base + '/files/' + id, { redirect: 'manual' })).status, 404);
  const blockedDelete = await fetch(base + '/api/assets/' + id, { method: 'DELETE' });
  assert.equal(blockedDelete.status, 409);
  db.prepare('DELETE FROM qr_codes WHERE id=?').run('qr1');
  const deleted = await fetch(base + '/api/assets/' + id, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(calls.deleted.length, 1);
  assert.equal((await fetch(base + '/files/' + id, { redirect: 'manual' })).status, 404);
});
