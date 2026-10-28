import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { createApp } from './app.js';

const owner = { name: 'Test Owner', email: 'owner@example.com', password: 'a-correct-test-password-123' };
const publicBaseUrl = 'http://localhost:8787';
const execFileAsync = promisify(execFile);

async function removeTestDir(dir) {
  const resolvedDir = path.resolve(dir), resolvedTemp = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolvedDir).toLowerCase(), resolvedTemp.toLowerCase());
  assert.match(path.basename(resolvedDir), /^yourQR-test-/);
  await rm(resolvedDir, { recursive: true, force: true });
}

async function fixture(options = {}) {
  const app = createApp({ dbPath: ':memory:', publicBaseUrl, environment: 'test', setupToken: '', secureCookie: false, ...options });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const api = async (route, { method = 'GET', body, authenticated = true, headers = {}, ...rest } = {}) => {
    const response = await fetch(`${origin}${route}`, {
      method, redirect: 'manual', ...rest,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(authenticated && cookie ? { cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  const json = async (route, args) => { const response = await api(route, args); return { status: response.status, body: await response.json(), headers: response.headers }; };
  const setup = () => json('/api/auth/setup', { method: 'POST', body: owner });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await new Promise((resolve) => server.close(resolve)); app.locals.close(); };
  return { app, api, json, setup, close, origin, getCookie: () => cookie };
}

async function createQR(f, props = {}) {
  const response = await f.json('/api/qrs', { method: 'POST', body: { name: 'Portfolio', type: 'dynamic', contentType: 'url', destination: 'https://example.com/portfolio', ...props } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.qr;
}

test('owner setup, protected API, login, CSRF checks, logout, no account takeover', async (t) => {
  const f = await fixture(); t.after(f.close);
  const initial = await f.json('/api/auth/session');
  assert.equal(initial.body.setupRequired, true);
  assert.equal(initial.body.authenticated, false);
  assert.equal((await f.api('/api/qrs')).status, 401);
  assert.equal((await f.json('/api/auth/setup', { method: 'POST', body: { ...owner, password: 'short' } })).status, 400);
  const setup = await f.setup();
  assert.equal(setup.status, 201);
  assert.match(setup.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(setup.headers.get('set-cookie'), /SameSite=Strict/i);
  assert.equal(setup.body.user.email, owner.email);
  assert.equal((await f.json('/api/auth/setup', { method: 'POST', body: { ...owner, email: 'attacker@example.com' } })).status, 409);
  const session = await f.json('/api/auth/session');
  assert.equal(session.body.authenticated, true);
  assert.equal('password_hash' in session.body.user, false);
  assert.equal((await f.json('/api/folders', { method: 'POST', body: { name: 'CSRF' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.json('/api/folders', { method: 'POST', body: { name: 'Vite' }, headers: { origin: 'http://localhost:5173' } })).status, 201);
  const oldCookie = f.getCookie();
  assert.equal((await f.json('/api/auth/logout', { method: 'POST' })).status, 200);
  assert.equal((await f.api('/api/qrs', { headers: { cookie: oldCookie } })).status, 401);
  assert.equal((await f.json('/api/auth/login', { method: 'POST', body: { email: owner.email, password: 'wrong' } })).status, 401);
  assert.equal((await f.json('/api/auth/login', { method: 'POST', body: { email: owner.email.toUpperCase(), password: owner.password } })).status, 200);
  assert.equal((await f.json('/api/qrs')).status, 200);
});

test('dynamic destination editing keeps encoded URL; GET counts and HEAD does not; pause and deletion work', async (t) => {
  const f = await fixture(); t.after(f.close); await f.setup();
  const qr = await createQR(f, { slug: 'portfolio-link' });
  assert.equal(qr.shortUrl, `${publicBaseUrl}/r/portfolio-link`);
  assert.equal(qr.encodedValue, qr.shortUrl);
  let response = await f.api('/r/portfolio-link', { method: 'HEAD', authenticated: false });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal((await f.json('/api/analytics?days=7')).body.totalScans, 0);
  response = await f.api('/r/portfolio-link', { authenticated: false, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; Mobile)', referer: 'https://news.example/article?private=value' } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://example.com/portfolio');
  await f.api('/r/portfolio-link', { authenticated: false, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; Mobile)' } });
  const analytics = (await f.json('/api/analytics?days=7')).body;
  assert.equal(analytics.totalScans, 2);
  assert.equal(analytics.uniqueVisitors, 1);
  assert.equal(analytics.series.length, 7);
  assert.equal(analytics.series.reduce((sum, row) => sum + row.scans, 0), 2);
  assert.deepEqual(analytics.devices, [{ name: 'Mobile', count: 2 }]);
  assert.equal(analytics.referrers.find((row) => row.name === 'news.example').count, 1);
  assert.equal(analytics.recent.some((row) => JSON.stringify(row).includes('private')), false);
  assert.equal(analytics.topCodes[0].id, qr.id);
  const edited = await f.json(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { destination: 'https://example.org/new' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.qr.encodedValue, qr.encodedValue);
  assert.equal((await f.api('/r/portfolio-link', { authenticated: false })).headers.get('location'), 'https://example.org/new');
  assert.equal((await f.json(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { slug: 'changed-link' } })).status, 400);
  assert.equal((await f.json(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await f.api('/r/portfolio-link', { authenticated: false })).status, 410);
  assert.equal((await f.json('/api/analytics?days=7')).body.totalScans, 3);
  assert.equal((await f.json(`/api/qrs/${qr.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await f.api('/r/portfolio-link', { authenticated: false })).status, 404);
  assert.equal((await f.json('/api/analytics?days=7')).body.totalScans, 0);
});

test('static URL and text remain permanent, folder deletion unfiles codes', async (t) => {
  const f = await fixture(); t.after(f.close); await f.setup();
  const folder = (await f.json('/api/folders', { method: 'POST', body: { name: 'Work', color: '#AABBCC' } })).body.folder;
  assert.equal((await f.json('/api/folders', { method: 'POST', body: { name: 'work' } })).status, 409);
  const qr = await createQR(f, { type: 'static', folderId: folder.id });
  assert.equal(qr.encodedValue, 'https://example.com/portfolio');
  assert.equal(qr.shortUrl, null);
  assert.equal((await f.json('/api/folders')).body.folders[0].qrCount, 1);
  assert.equal((await f.json(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { destination: 'https://different.example' } })).status, 400);
  assert.equal((await f.json(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { active: false } })).status, 400);
  assert.equal((await f.json(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { name: 'Renamed', fgColor: '#000000' } })).status, 200);
  assert.equal((await f.json(`/api/folders/${folder.id}`, { method: 'PATCH', body: { name: 'Projects' } })).status, 200);
  assert.equal((await f.json(`/api/folders/${folder.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await f.json('/api/qrs')).body.qrs[0].folderId, null);
  const text = await createQR(f, { type: 'static', contentType: 'text', destination: 'Hello from yourQR! नमस्ते 🌿\nA second line.', name: 'Text' });
  assert.equal(text.encodedValue, 'Hello from yourQR! नमस्ते 🌿\nA second line.');
  const png = Buffer.from(await (await f.api(`/api/qrs/${text.id}/download?format=png`)).arrayBuffer());
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data, text.encodedValue);
  assert.equal((await f.json(`/api/analytics?qrId=${text.id}&days=30`)).body.totalScans, 0);
  const library = await f.json('/api/export');
  assert.equal(library.body.qrs.length, 2);
  assert.equal('owner' in library.body, false);
  assert.equal('sessions' in library.body, false);
});

test('real logo PNG and SVG exports decode to saved content with safe margins', async (t) => {
  const f = await fixture(); t.after(f.close); await f.setup();
  const logo = await sharp({ create: { width: 60, height: 40, channels: 4, background: '#F09E5A' } }).png().toBuffer();
  for (const type of ['static', 'dynamic']) {
    const qr = await createQR(f, { type, logoDataUrl: `data:image/png;base64,${logo.toString('base64')}`, fgColor: '#173C35', bgColor: '#FAFAF0' });
    const svgResponse = await f.api(`/api/qrs/${qr.id}/download?format=svg`);
    assert.equal(svgResponse.status, 200);
    assert.match(svgResponse.headers.get('content-type'), /svg/);
    const svg = await svgResponse.text();
    assert.match(svg, /<image /);
    assert.match(svg, /data:image\/png;base64,/);
    assert.doesNotMatch(svg, /https?:\/\/example.com.*href=/);
    for (const image of [Buffer.from(await (await f.api(`/api/qrs/${qr.id}/download?format=png`)).arrayBuffer()), Buffer.from(svg)]) {
      const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 1024);
      const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
      assert.equal(decoded?.data, qr.encodedValue, `QR did not decode for ${type}`);
    }
  }
});

test('input validation blocks hostile URLs, weak contrast, fake logos and invalid content', async (t) => {
  const f = await fixture(); t.after(f.close); await f.setup();
  for (const props of [
    { destination: 'javascript:alert(1)' },
    { destination: 'https://user:password@example.com' },
    { destination: `${publicBaseUrl}/r/some-other` },
    { destination: 'https://example.com/ bad' },
    { contentType: 'text' },
    { fgColor: '#eeeeee', bgColor: '#ffffff' },
    { fgColor: '#ffffff', bgColor: '#000000' },
    { fgColor: 'red' },
    { logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    { logoDataUrl: 'data:image/png;base64,ZmFrZSBpbWFnZQ==' },
    { folderId: 'missing' },
    { slug: 'bad/slug' },
    { slug: 'preview' },
    { type: 'static', contentType: 'text', destination: 'x'.repeat(1001) },
  ]) {
    const result = await f.json('/api/qrs', { method: 'POST', body: { name: 'Test', type: 'dynamic', contentType: 'url', destination: 'https://example.com', ...props } });
    assert.equal(result.status, 400, JSON.stringify(props));
    assert.equal(typeof result.body.error, 'string');
  }
  const qr = await createQR(f, { slug: 'unique-link' });
  assert.equal((await f.json('/api/qrs', { method: 'POST', body: { name: 'Duplicate', destination: 'https://example.com', slug: qr.slug } })).status, 409);
  assert.equal((await f.json(`/api/qrs/${qr.id}/download?format=pdf`)).status, 400);
  assert.equal((await f.json('/api/analytics?days=365')).status, 400);
  assert.equal((await f.json('/api/analytics?qrId=missing')).status, 404);
  const preview = await f.json('/api/preview', { method: 'POST', body: { type: 'dynamic', destination: 'https://example.com' } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.encodedValue, `${publicBaseUrl}/r/preview`);
  assert.match(preview.body.svg, /<svg /);
  assert.equal((await f.json('/api/qrs')).body.qrs.length, 1);
});

test('database persists owner, session, folders, code and scan history across restarts', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yourQR-test-'));
  const dbPath = path.join(dir, 'yourQR.sqlite');
  let f = await fixture({ dbPath });
  t.after(async () => {
    await f.close();
    await removeTestDir(dir);
  });
  await f.setup();
  const cookie = f.getCookie();
  const folder = (await f.json('/api/folders', { method: 'POST', body: { name: 'Persisted folder' } })).body.folder;
  const qr = await createQR(f, { folderId: folder.id });
  await f.api(`/r/${qr.slug}`, { authenticated: false });
  const secret = f.app.locals.db.prepare("SELECT value FROM settings WHERE key='analytics_secret'").get().value;
  await f.close();
  f = await fixture({ dbPath, publicBaseUrl: 'https://new-origin.example' });
  const session = await f.json('/api/auth/session', { headers: { cookie } });
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.setupRequired, false);
  assert.equal(f.app.locals.db.prepare("SELECT value FROM settings WHERE key='analytics_secret'").get().value, secret);
  const library = await f.json('/api/qrs', { headers: { cookie } });
  assert.equal(library.body.qrs[0].id, qr.id);
  assert.equal(library.body.qrs[0].scanCount, 1);
  assert.equal(library.body.qrs[0].encodedValue, qr.encodedValue);
  assert.equal(library.body.qrs[0].folderId, folder.id);
  assert.equal((await f.json('/api/folders', { headers: { cookie } })).body.folders[0].name, folder.name);
  const edited = await f.json(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { destination: 'https://updated.example/' }, headers: { cookie } });
  assert.equal(edited.body.qr.encodedValue, qr.encodedValue);
  const preview = await f.json('/api/preview', { method: 'POST', body: { id: qr.id, destination: 'https://preview.example/' }, headers: { cookie } });
  assert.equal(preview.body.encodedValue, qr.encodedValue);
  const newCode = await f.json('/api/qrs', { method: 'POST', body: { name: 'New origin', destination: 'https://example.com' }, headers: { cookie } });
  assert.match(newCode.body.qr.encodedValue, /^https:\/\/new-origin\.example\/r\//);
  const redirectLoop = await f.json(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { destination: qr.encodedValue }, headers: { cookie } });
  assert.equal(redirectLoop.status, 400);
});

test('offline password recovery changes owner password and revokes existing sessions', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yourQR-test-'));
  const dbPath = path.join(dir, 'yourQR.sqlite');
  let f = await fixture({ dbPath });
  t.after(async () => { await f.close(); await removeTestDir(dir); });
  await f.setup();
  const oldCookie = f.getCookie();
  await f.close();
  const newPassword = 'a-new-owner-password-456';
  const resetScript = fileURLToPath(new URL('./reset-password.js', import.meta.url));
  const result = await execFileAsync(process.execPath, [resetScript], {
    env: { ...process.env, DB_PATH: dbPath, RESET_EMAIL: owner.email, RESET_PASSWORD: newPassword },
  });
  assert.match(result.stdout, /All sessions were signed out/);
  assert.equal(result.stdout.includes(newPassword), false);
  assert.equal(result.stderr.includes(newPassword), false);
  f = await fixture({ dbPath });
  assert.equal((await f.api('/api/qrs', { headers: { cookie: oldCookie } })).status, 401);
  assert.equal((await f.json('/api/auth/login', { method: 'POST', body: { email: owner.email, password: owner.password } })).status, 401);
  assert.equal((await f.json('/api/auth/login', { method: 'POST', body: { email: owner.email, password: newPassword } })).status, 200);
});

test('production setup token, secure cookies, and auth throttling', async (t) => {
  assert.throws(() => createApp({ dbPath: ':memory:', environment: 'production', setupToken: '' }), /SETUP_TOKEN/);
  const f = await fixture({ environment: 'production', publicBaseUrl: 'https://qr.example.com', setupToken: 'test-long-setup-token', secureCookie: true }); t.after(f.close);
  assert.equal((await f.setup()).status, 403);
  const setup = await f.json('/api/auth/setup', { method: 'POST', body: { ...owner, setupToken: 'test-long-setup-token' } });
  assert.equal(setup.status, 201);
  assert.match(setup.headers.get('set-cookie'), /Secure/);
  for (let i = 0; i < 11; i++) await f.json('/api/auth/login', { method: 'POST', body: { email: owner.email, password: 'incorrect' } });
  const limited = await f.json('/api/auth/login', { method: 'POST', body: owner });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});
