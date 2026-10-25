import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { createApp } from './app.js';
import { CONTENT_TYPES } from '../shared/content-types.js';
import { pdfFile, pptxFile, wavFile } from '../tests/fixtures.js';

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', publicBaseUrl: 'http://localhost:8787', environment: 'test', setupToken: '', secureCookie: false });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (path, { method = 'GET', body, raw, auth = true, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { ...(auth ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw || (body ? JSON.stringify(body) : undefined) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  await request('/api/auth/setup', { method: 'POST', body: { name: 'Test', email: 'types@example.com', password: 'testing-types-long-password' } });
  const create = async body => { const response = await request('/api/qrs', { method: 'POST', body: { name: body.contentType, ...body } }); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).qr; };
  const upload = async (kind, bytes, name) => { const response = await request(`/api/assets?type=${kind}`, { method: 'POST', raw: bytes, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) } }); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).asset; };
  return { app, request, create, upload };
}

test('all 19 catalog types create real QR payloads; Wi-Fi and vCard exports decode', async t => {
  const f = await fixture(t);
  const cases = {
    url: { destination: 'https://example.com' }, text: { destination: 'Hello QR' },
    whatsapp: { payload: { phone: '+919876543210', message: 'Hello & welcome!' } },
    youtube: { payload: { url: 'https://youtu.be/example' } }, instagram: { payload: { url: 'https://www.instagram.com/example/' } },
    facebook: { payload: { url: 'https://www.facebook.com/example' } }, telegram: { payload: { username: '@example' } },
    map: { payload: { address: 'New Delhi, India' } }, booking: { payload: { url: 'https://example.com/book' } },
    phone: { payload: { phone: '+91 98765 43210' } }, email: { payload: { email: 'hello@example.com', subject: 'Hello & welcome', body: 'Line one\nLine two' } },
    wifi: { payload: { ssid: ' My;Network ', security: 'WPA', password: ' secret;word ', hidden: true } },
    vcard: { payload: { firstName: 'Sajan', lastName: 'Maurya', email: 'hello@example.com', phone: '+919876543210', organization: 'My; Studio' } },
    app: { payload: { iosUrl: 'https://apps.apple.com/app/id123', androidUrl: 'https://play.google.com/store/apps/details?id=example', fallbackUrl: 'https://example.com' } },
    smart: { payload: { fallbackUrl: 'https://example.com', iosUrl: 'https://example.com/ios' } },
  };
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#236d51' } }).png().toBuffer();
  for (const [kind, bytes, name] of [['pdf', pdfFile(), 'guide.pdf'], ['image', png, 'picture.png'], ['audio', wavFile(), 'recording.wav'], ['pptx', pptxFile(), 'slides.pptx']]) {
    const asset = await f.upload(kind, bytes, name); cases[kind] = { assetId: asset.id };
  }
  for (const meta of CONTENT_TYPES) {
    const qr = await f.create({ contentType: meta.id, ...cases[meta.id] });
    assert.equal(qr.contentType, meta.id); assert.equal(qr.type, meta.mode || 'dynamic');
    const response = await f.request(`/api/qrs/${qr.id}/download?format=png`);
    const { data, info } = await sharp(Buffer.from(await response.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data, qr.encodedValue, meta.id);
    if (meta.id === 'wifi') { assert.match(qr.encodedValue, /S: My\\;Network ;/); assert.match(qr.encodedValue, /P: secret\\;word ;H:true/); }
    if (meta.id === 'vcard') { assert.match(qr.encodedValue, /^BEGIN:VCARD\r\nVERSION:3.0/); assert.match(qr.encodedValue, /ORG:My\\; Studio/); }
    if (meta.id === 'email') assert.match(qr.encodedValue, /^mailto:hello@example.com\?subject=Hello%20%26%20welcome&body=/);
  }
});

test('PDF upload, public access, replacement, ranges, pause, cleanup, and analytics', async t => {
  const f = await fixture(t), firstBytes = pdfFile('First edition'), nextBytes = pdfFile('Replacement edition');
  assert.equal((await f.request('/api/assets?type=pdf', { method: 'POST', auth: false, raw: firstBytes, headers: { 'content-type': 'application/octet-stream' } })).status, 401);
  const first = await f.upload('pdf', firstBytes, 'My guide.pdf');
  assert.equal((await f.request(`/files/${first.id}`, { auth: false })).status, 404);
  const qr = await f.create({ contentType: 'pdf', assetId: first.id, slug: 'pdf-guide' });
  assert.equal(qr.asset.name, 'My guide.pdf');
  let response = await f.request('/r/pdf-guide', { auth: false });
  assert.equal(response.status, 302); assert.match(response.headers.get('location'), new RegExp(`/files/${first.id}$`));
  response = await f.request(`/files/${first.id}`, { auth: false });
  assert.equal(response.headers.get('content-type'), 'application/pdf'); assert.match(response.headers.get('content-disposition'), /^inline;/);
  assert.match(response.headers.get('content-security-policy'), /\ballow-downloads\b/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), firstBytes);
  const download = await f.request(`/files/${first.id}?download=1`, { auth: false });
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), firstBytes);
  response = await f.request(`/files/${first.id}`, { auth: false, headers: { range: 'bytes=0-4' } });
  assert.equal(response.status, 206); assert.equal(await response.text(), '%PDF-');
  assert.equal((await f.request(`/files/${first.id}`, { auth: false, headers: { range: 'bytes=9999999-' } })).status, 416);
  assert.equal((await f.request(`/api/assets/${first.id}`, { method: 'DELETE' })).status, 409);
  const next = await f.upload('pdf', nextBytes, 'Updated.pdf');
  response = await f.request(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { assetId: next.id } });
  const updated = (await response.json()).qr;
  assert.equal(updated.encodedValue, qr.encodedValue); assert.equal(updated.assetId, next.id);
  assert.equal((await f.request(`/files/${first.id}`, { auth: false })).status, 404);
  assert.deepEqual(Buffer.from(await (await f.request(`/files/${next.id}`, { auth: false })).arrayBuffer()), nextBytes);
  await f.request(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal((await f.request(`/files/${next.id}`, { auth: false })).status, 404);
  assert.equal((await f.request('/r/pdf-guide', { auth: false })).status, 410);
  const stats = await (await f.request('/api/analytics')).json(); assert.equal(stats.totalScans, 1);
  await f.request(`/api/qrs/${qr.id}`, { method: 'DELETE' });
  assert.equal((await f.request(`/api/assets/${next.id}`, { method: 'DELETE' })).status, 200);
});

test('smart and store routing choose iOS, Android, and fallback destinations', async t => {
  const f = await fixture(t);
  for (const category of ['smart', 'app']) {
    const payload = category === 'app' ? { iosUrl: 'https://apps.apple.com/app/id123', androidUrl: 'https://play.google.com/store/apps/details?id=example', fallbackUrl: 'https://example.com/' } : { iosUrl: 'https://example.com/ios', androidUrl: 'https://example.com/android', fallbackUrl: 'https://example.com/' };
    const qr = await f.create({ contentType: category, payload });
    for (const [ua, expected] of [['iPhone Mobile', payload.iosUrl], ['Android Mobile', payload.androidUrl], ['Desktop Browser', payload.fallbackUrl]]) {
      const response = await f.request(`/r/${qr.slug}`, { auth: false, headers: { 'user-agent': ua } }); assert.equal(response.headers.get('location'), expected);
    }
  }
});

test('content and upload validation rejects scripts, header injection, fake files, and incompatible modes', async t => {
  const f = await fixture(t);
  for (const body of [
    { contentType: 'phone', type: 'dynamic', payload: { phone: '+1234567890' } },
    { contentType: 'pdf', assetId: 'missing' },
    { contentType: 'email', payload: { email: 'hello@example.com', subject: 'Hello\r\nBcc:spy@example.com' } },
    { contentType: 'vcard', payload: { firstName: 'Name\nURL:javascript:alert(1)' } },
    { contentType: 'youtube', payload: { url: 'https://evil.example/video' } },
    { contentType: 'smart', payload: { fallbackUrl: 'javascript:alert(1)' } },
    { contentType: 'smart', payload: { fallbackUrl: 'http://localhost:8787/r/self' } },
    { contentType: 'wifi', payload: { ssid: 'network', password: 'test', security: 'bad' } },
  ]) assert.equal((await f.request('/api/qrs', { method: 'POST', body: { name: 'Invalid', ...body } })).status, 400, JSON.stringify(body));
  for (const kind of ['pdf', 'pptx', 'image', 'audio']) assert.equal((await f.request(`/api/assets?type=${kind}`, { method: 'POST', raw: Buffer.from('<script>not a file</script>'), headers: { 'content-type': 'application/octet-stream' } })).status, 400);
  const qr = await f.create({ contentType: 'wifi', payload: { ssid: 'My Network', security: 'nopass' } });
  assert.equal((await f.request(`/api/qrs/${qr.id}`, { method: 'PATCH', body: { payload: { ssid: 'Other', security: 'nopass' } } })).status, 400);
});
