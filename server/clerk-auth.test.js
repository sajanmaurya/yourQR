import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { openDatabase, dbGet, dbRun, hashPassword } from './database.js';

async function fixture(t, environment = 'test') {
  const db = openDatabase(':memory:');
  const profiles = new Map();
  const adapter = {
    middleware(req, res, next) { next(); },
    getAuth: req => ({ userId: req.get('x-test-identity') || null }),
    users: { getUser: async id => profiles.get(id) },
  };
  const app = createApp({ db, environment, authProvider: 'clerk', clerkPublishableKey: `pk_test_${Buffer.from('test.clerk.accounts.dev$').toString('base64')}`, clerkSecretKey: 'test-only-placeholder', clerkAdapter: adapter, publicBaseUrl: 'http://localhost:8787' });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  function profile(id, email, verified = true) { profiles.set(id, { fullName: id, primaryEmailAddressId: 'email', emailAddresses: [{ id: 'email', emailAddress: email, verification: { status: verified ? 'verified' : 'unverified' } }] }); }
  async function request(route, id, method = 'GET', body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { ...(id ? { 'x-test-identity': id } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  return { db, profile, request };
}

test('Clerk provisions separate workspaces, requires verified email, and disables local auth', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/qrs')).status, 401);
  const config = await f.request('/api/auth/config');
  assert.equal(config.data.provider, 'clerk');
  assert.equal('secretKey' in config.data, false);
  for (const route of ['login', 'register', 'setup', 'logout']) assert.equal((await f.request(`/api/auth/${route}`, null, 'POST', {})).status, 409);
  f.profile('user-a', 'a@example.com'); f.profile('user-b', 'b@example.com'); f.profile('unverified', 'pending@example.com', false);
  assert.equal((await f.request('/api/auth/session', 'unverified')).status, 403);
  const a = await f.request('/api/auth/session', 'user-a');
  const b = await f.request('/api/auth/session', 'user-b');
  assert.equal(a.data.authenticated, true);
  assert.notEqual(a.data.user.id, b.data.user.id);
  const folder = await f.request('/api/folders', 'user-a', 'POST', { name: 'Private folder' });
  assert.equal(folder.status, 201);
  assert.equal((await f.request('/api/folders', 'user-b')).data.folders.length, 0);
  assert.equal((await f.request(`/api/folders/${folder.data.folder.id}`, 'user-b', 'DELETE')).status, 404);
  assert.equal((await f.request('/api/folders', 'user-a')).data.folders.length, 1);
});

test('Clerk migration requires the old password and preserves ownership while revoking local sessions', async t => {
  const f = await fixture(t);
  const password = 'previous-yourQR-password';
  const old = await dbGet(f.db, 'INSERT INTO users(name,email,password_hash,created_at) VALUES (?,?,?,?) RETURNING id', ['Existing', 'old@example.com', await hashPassword(password), new Date().toISOString()]);
  await dbRun(f.db, 'INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)', ['old-token', old.id, Date.now() + 60000]);
  await dbRun(f.db, 'INSERT INTO user_folders(id,user_id,name,color,created_at) VALUES (?,?,?,?,?)', ['saved', old.id, 'Saved', '#ffffff', new Date().toISOString()]);
  f.profile('migrating', 'old@example.com');
  const session = await f.request('/api/auth/session', 'migrating');
  assert.equal(session.data.linkRequired, true); assert.equal(session.data.authenticated, false);
  assert.equal((await f.request('/api/folders', 'migrating')).status, 401);
  assert.equal((await f.request('/api/auth/link', 'migrating', 'POST', { password: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/auth/link', 'migrating', 'POST', { password })).data.user.id, Number(old.id));
  assert.equal((await f.request('/api/folders', 'migrating')).data.folders[0].id, 'saved');
  assert.equal(await dbGet(f.db, 'SELECT * FROM user_sessions WHERE user_id=?', [old.id]), undefined);
  f.profile('other-identity', 'old@example.com');
  assert.equal((await f.request('/api/auth/link', 'other-identity', 'POST', { password })).status, 409);
  assert.equal((await f.request('/api/folders', 'other-identity')).status, 401);
});

test('Clerk production CSP permits the configured identity host and challenge widgets', async t => {
  const f = await fixture(t, 'production');
  const { headers } = await f.request('/api/auth/config');
  const csp = headers.get('content-security-policy');
  assert.match(csp, /https:\/\/test\.clerk\.accounts\.dev/);
  assert.match(csp, /https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /worker-src 'self' blob:/);
});
