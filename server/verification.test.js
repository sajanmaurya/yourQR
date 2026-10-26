import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';

test('verification is one-time, required before login, and prevents legacy setup in SaaS', async t => {
  const sent = [];
  const app = createApp({
    dbPath: ':memory:', publicBaseUrl: 'http://localhost:8787',
    saasMode: true, environment: 'test', secureCookie: false,
    requireEmailVerification: true,
    emailSender: async message => { sent.push(message); },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = async (endpoint, data) => {
    const response = await fetch(origin + endpoint, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data) });
    return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json() };
  };
  const account = { name: 'Jamie', email: 'jamie@example.com', password: 'long-unique-secret-1234' };
  const created = await post('/api/auth/register', account);
  assert.equal(created.status, 201);
  assert.equal(created.cookie, null);
  assert.equal(created.body.requiresVerification, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, account.email);
  assert.equal((await post('/api/auth/setup', account)).status, 403);
  assert.equal((await post('/api/auth/login', account)).status, 403);
  assert.equal((await post('/api/auth/verify-email', { token: 'nope' })).status, 400);
  const first = new URL(sent[0].url).searchParams.get('verify');
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal((await post('/api/auth/resend-verification', { email: account.email })).status, 200);
  assert.equal(sent.length, 2);
  const second = new URL(sent[1].url).searchParams.get('verify');
  assert.notEqual(first, second);
  assert.equal((await post('/api/auth/verify-email', { token: first })).status, 400);
  assert.equal((await post('/api/auth/verify-email', { token: second })).status, 200);
  assert.equal((await post('/api/auth/verify-email', { token: second })).status, 400);
  const login = await post('/api/auth/login', account);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.match(login.cookie, /HttpOnly/);
  assert.equal((await post('/api/auth/resend-verification', { email: 'unknown@example.com' })).status, 200);
});
