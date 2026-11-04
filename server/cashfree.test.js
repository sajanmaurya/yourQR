import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from './app.js';
import { verifyCashfreeWebhook, cashfreeConfig } from './cashfree.js';

test('Cashfree webhook HMAC validates signed raw request bytes', () => {
  const payload = Buffer.from('{"data":{"subscription_id":"yourqr_test_001"}}');
  const timestamp = '1793790000';
  const signature = createHmac('sha256', 'webhook-test-secret').update(timestamp).update(payload).digest('base64');
  assert.equal(verifyCashfreeWebhook(payload, timestamp, signature, 'webhook-test-secret'), true);
  assert.equal(verifyCashfreeWebhook(Buffer.from('different'), timestamp, signature, 'webhook-test-secret'), false);
  assert.equal(verifyCashfreeWebhook(payload, timestamp, 'bad', 'webhook-test-secret'), false);
  assert.equal(verifyCashfreeWebhook(payload, timestamp, signature, 'other-secret'), false);
});
test('billing is disabled by default and never creates paid entitlements', () => {
  assert.equal(cashfreeConfig({}).enabled, false);
});
test('Cashfree checkout, signed webhooks, account isolation, cancellation and plan enforcement', async t => {
  const planId = 'cashfree_plan_test';
  const phone = '9876543210';
  const provider = new Map();
  let createCalls = 0;
  const gateway = {
    async fetchPlan() {
      return { plan_id: planId, plan_name: 'Pro Monthly', plan_type: 'PERIODIC',
        plan_currency: 'INR', plan_status: 'ACTIVE', plan_intervals: 1,
        plan_interval_type: 'MONTH', plan_recurring_amount: 99 };
    },
    async createSubscription(body) {
      createCalls++;
      const sub = { subscription_id: body.subscription_id, subscription_status: 'INITIALIZED',
        authorisation_details: { authorization_status: 'INITIALIZED' },
        subscription_session_id: 'subs_token_test_123', plan_details: { plan_id: planId } };
      assert.equal(body.customer_details.customer_phone, phone);
      provider.set(body.subscription_id, sub);
      return sub;
    },
    async fetchSubscription(id) {
      const sub = provider.get(id);
      if (!sub) throw Error('No subscription found');
      return sub;
    },
    async cancelSubscription(id) {
      const sub = provider.get(id);
      sub.subscription_status = 'CANCELLED';
      return sub;
    },
  };
  const app = createApp({
    dbPath: ':memory:', environment: 'test', publicBaseUrl: 'http://localhost:8787', secureCookie: false,
    cashfreeConfig: { enabled: true, enforce: true, freeLimit: 1, environment: 'sandbox',
      planId, webhookSecret: 'webhook-test-secret' }, cashfreeGateway: gateway,
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); });
  let cookie = '';
  async function request(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
    const response = await fetch(base + path, {
      method, redirect: 'manual',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(auth && cookie ? { cookie } : {}), ...headers,
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  assert.equal((await request('/api/billing', { auth: false })).status, 401);
  let response = await request('/api/auth/register', { method: 'POST', body: {
    name: 'Bill Tester', email: 'bill@example.com', password: 'secure-testing-pass-1234',
  } });
  assert.equal(response.status, 201);
  const billing = await (await request('/api/billing')).json();
  assert.equal(billing.enabled, true);
  assert.equal(billing.plan.amountRupees, 99);
  assert.equal(billing.subscription.tier, 'Free');
  response = await request('/api/billing/checkout', { method: 'POST', body: { phone: '12345' } });
  assert.equal(response.status, 400);
  response = await request('/api/billing/checkout', { method: 'POST', body: { phone } });
  assert.equal(response.status, 201);
  const checkout = await response.json();
  assert.equal(checkout.environment, 'sandbox');
  assert.equal(checkout.sessionId, 'subs_token_test_123');
  const subId = [...provider.keys()][0];
  response = await request('/api/billing/checkout', { method: 'POST', body: { phone } });
  assert.equal(response.status, 200);
  assert.equal(createCalls, 1);
  const qrBody = { name: 'First', type: 'dynamic', contentType: 'url', destination: 'https://example.com/one' };
  response = await request('/api/qrs', { method: 'POST', body: qrBody });
  assert.equal(response.status, 201);
  response = await request('/api/qrs', { method: 'POST', body: { ...qrBody, name: 'Second' } });
  assert.equal(response.status, 403);
  provider.get(subId).subscription_status = 'ACTIVE';
  provider.get(subId).authorisation_details.authorization_status = 'INITIALIZED';
  await request('/api/billing/sync', { method: 'POST' });
  assert.equal((await (await request('/api/billing')).json()).subscription.tier, 'Free');
  provider.get(subId).authorisation_details.authorization_status = 'SUCCESS';
  let event = JSON.stringify({ type: 'SUBSCRIPTION_STATUS_UPDATE', data: { subscription_details: { subscription_id: subId } } });
  response = await request('/api/billing/webhook', { method: 'POST', body: event, auth: false });
  assert.equal(response.status, 401);
  const timestamp = '1793790000';
  const signature = createHmac('sha256', 'webhook-test-secret').update(timestamp).update(Buffer.from(event)).digest('base64');
  response = await request('/api/billing/webhook', { method: 'POST', body: event, auth: false,
    headers: { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature } });
  assert.equal(response.status, 200);
  response = await request('/api/billing/webhook', { method: 'POST', body: event, auth: false,
    headers: { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature } });
  assert.equal(response.status, 200);
  assert.equal((await (await request('/api/billing')).json()).subscription.tier, 'Pro');
  response = await request('/api/qrs', { method: 'POST', body: { ...qrBody, name: 'Second' } });
  assert.equal(response.status, 201);
  response = await request('/api/billing/cancel', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await (await request('/api/billing')).json()).subscription.tier, 'Free');
});
