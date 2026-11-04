import express from 'express';
import { createHmac, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { dbAll, dbGet, dbRun } from './database.js';
import { ValidationError } from './qr.js';

export function cashfreeConfig(override) {
  if (override) return { enabled: false, enforce: false, freeLimit: 10, environment: 'sandbox', ...override };
  const enabled = process.env.CASHFREE_SUBSCRIPTIONS_ENABLED === 'true';
  const config = {
    enabled,
    enforce: enabled && process.env.CASHFREE_ENFORCE_LIMITS === 'true',
    freeLimit: Number(process.env.FREE_QR_LIMIT || 10),
    environment: process.env.CASHFREE_ENVIRONMENT || 'sandbox',
    clientId: process.env.CASHFREE_CLIENT_ID,
    secretKey: process.env.CASHFREE_SECRET_KEY,
    webhookSecret: process.env.CASHFREE_WEBHOOK_SECRET || process.env.CASHFREE_SECRET_KEY,
    planId: process.env.CASHFREE_PLAN_ID,
  };
  if (enabled && (!['sandbox', 'production'].includes(config.environment) ||
      !config.clientId || !config.secretKey || !config.webhookSecret || !config.planId ||
      !Number.isInteger(config.freeLimit) || config.freeLimit < 1 || config.freeLimit > 10000)) {
    throw new Error('Cashfree setup is incomplete. Check environment, credentials, INR periodic plan, and FREE_QR_LIMIT.');
  }
  return config;
}

export function createCashfreeGateway(config) {
  const base = config.environment === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
  async function request(method, path, body) {
    const response = await fetch(base + '/pg' + path, {
      method,
      headers: {
        'x-client-id': config.clientId,
        'x-client-secret': config.secretKey,
        'x-api-version': '2026-01-01',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Cashfree API returned HTTP ' + response.status + '. Please check your merchant configuration.');
    return response.json();
  }
  return {
    fetchPlan: id => request('GET', '/plans/' + encodeURIComponent(id)),
    createSubscription: body => request('POST', '/subscriptions', body),
    fetchSubscription: id => request('GET', '/subscriptions/' + encodeURIComponent(id)),
    cancelSubscription: id => request('POST', '/subscriptions/' + encodeURIComponent(id) + '/manage', { subscription_id: id, action: 'CANCEL' }),
  };
}

export function verifyCashfreeWebhook(body, timestamp, signature, secret) {
  if (!Buffer.isBuffer(body) || typeof timestamp !== 'string' || !/^\d{10,16}$/.test(timestamp) ||
      !secret || typeof signature !== 'string') return false;
  const expected = createHmac('sha256', secret).update(timestamp).update(body).digest();
  let received;
  try { received = Buffer.from(signature, 'base64'); } catch { return false; }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function validatedPlan(plan, expectedId) {
  const price = Number(plan?.plan_recurring_amount);
  if (plan?.plan_id !== expectedId || plan.plan_type !== 'PERIODIC' || plan.plan_currency !== 'INR' ||
      plan.plan_status !== 'ACTIVE' || !Number.isFinite(price) || price <= 0 ||
      !Number.isInteger(Number(plan.plan_intervals)) || Number(plan.plan_intervals) < 1) {
    throw new Error('The Cashfree plan must be an ACTIVE periodic INR plan.');
  }
  return {
    id: plan.plan_id,
    name: plan.plan_name,
    amountRupees: price,
    interval: Number(plan.plan_intervals),
    intervalType: plan.plan_interval_type,
  };
}
const statusAllowlist = new Set([
  'INITIALIZED', 'PENDING', 'ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED',
  'FAILED', 'COMPLETED', 'ON_HOLD', 'BANK_APPROVAL_PENDING',
]);
async function newest(db, userId) {
  return dbGet(db, 'SELECT * FROM cashfree_subscriptions WHERE user_id=? ORDER BY created_at DESC LIMIT 1', [userId]);
}
function presentation(row) {
  const active = row?.status === 'ACTIVE' && row.authorization_status === 'SUCCESS';
  return { tier: active ? 'Pro' : 'Free', status: row?.status || 'NONE', subscriptionId: row?.id || null };
}
async function reconcile(db, row, remote) {
  if (remote?.subscription_id !== row.id || remote.plan_details?.plan_id !== row.plan_id ||
      !statusAllowlist.has(remote.subscription_status)) {
    throw new Error('Cashfree subscription response did not match the stored account and plan.');
  }
  const authorization = remote.authorisation_details || remote.authorization_details || {};
  const authStatus = authorization.authorization_status || 'INITIALIZED';
  await dbRun(db, 'UPDATE cashfree_subscriptions SET status=?,authorization_status=?,session_id=?,updated_at=? WHERE id=? AND user_id=?',
    [remote.subscription_status, authStatus, remote.subscription_session_id || row.session_id,
      new Date().toISOString(), row.id, row.user_id]);
  return dbGet(db, 'SELECT * FROM cashfree_subscriptions WHERE id=? AND user_id=?', [row.id, row.user_id]);
}

export function registerCashfreeWebhook(app, db, config, gateway) {
  // Raw body MUST be read before express.json(), and webhooks must not require a browser session.
  app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res, next) => {
    if (!config.enabled) return res.status(503).end();
    if (!verifyCashfreeWebhook(req.body, req.get('x-webhook-timestamp'), req.get('x-webhook-signature'), config.webhookSecret)) {
      return res.status(401).end();
    }
    let event;
    try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).end(); }
    const eventId = createHash('sha256').update(req.body).digest('hex');
    try {
      if (await dbGet(db, 'SELECT id FROM cashfree_webhook_events WHERE id=?', [eventId])) return res.json({ ok: true });
      // Different Cashfree subscription events nest their subscription IDs in different locations.
      const subscriptionId = event?.data?.subscription_details?.subscription_id ||
        event?.data?.subscription?.subscription_id || event?.data?.subscription_id;
      if (typeof subscriptionId !== 'string' || !/^[a-zA-Z0-9_-]{6,128}$/.test(subscriptionId)) return res.json({ ok: true });
      const row = await dbGet(db, 'SELECT * FROM cashfree_subscriptions WHERE id=?', [subscriptionId]);
      if (!row) return res.json({ ok: true });
      // Always use a fresh server-to-server fetch; an event's claimed status is not an entitlement.
      await reconcile(db, row, await gateway.fetchSubscription(row.id));
      await dbRun(db, 'INSERT INTO cashfree_webhook_events(id,subscription_id,processed_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
        [eventId, row.id, new Date().toISOString()]);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
}

export function registerCashfreeApi(app, db, config, gateway, publicBaseUrl) {
  const requireActive = (req, res, next) => config.enabled ? next() : res.status(503).json({ error: 'Payments are not enabled yet.' });
  const fetchPlan = async () => validatedPlan(await gateway.fetchPlan(config.planId), config.planId);
  app.get('/api/billing', async (req, res) => {
    res.json({
      enabled: Boolean(config.enabled),
      environment: config.enabled ? config.environment : null,
      freeLimit: config.enabled && config.enforce ? config.freeLimit : null,
      plan: config.enabled ? await fetchPlan() : null,
      subscription: presentation(await newest(db, req.user.id)),
    });
  });
  app.post('/api/billing/sync', requireActive, async (req, res) => {
    const row = await newest(db, req.user.id);
    if (!row) return res.json({ subscription: presentation(null) });
    res.json({ subscription: presentation(await reconcile(db, row, await gateway.fetchSubscription(row.id))) });
  });
  app.post('/api/billing/checkout', requireActive, async (req, res) => {
    const phone = String(req.body?.phone || '').trim();
    if (!/^[6-9]\d{9}$/.test(phone)) throw new ValidationError('Enter a valid 10-digit Indian mobile number.', 400);
    const locked = await dbGet(db, `INSERT INTO cashfree_checkout_locks(user_id,locked_until) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET locked_until=excluded.locked_until
      WHERE cashfree_checkout_locks.locked_until < ? RETURNING user_id`,
    [req.user.id, Date.now() + 30000, Date.now()]);
    if (!locked) throw new ValidationError('A checkout is already starting. Please retry shortly.', 409);
    try {
      let existing = await newest(db, req.user.id);
      if (existing && !['CANCELLED', 'EXPIRED', 'COMPLETED', 'FAILED'].includes(existing.status)) {
        existing = await reconcile(db, existing, await gateway.fetchSubscription(existing.id));
        if (presentation(existing).tier === 'Pro') throw new ValidationError('You already have an active Pro subscription.', 409);
        if (existing.session_id && ['INITIALIZED', 'PENDING'].includes(existing.status)) {
          return res.json({ sessionId: existing.session_id, environment: config.environment });
        }
        throw new ValidationError('An existing mandate is pending. Contact support before starting another.', 409);
      }
      const plan = await fetchPlan();
      const id = 'yourqr_' + randomUUID().replace(/-/g, '');
      const date = new Date().toISOString();
      // Reserve ID before calling the gateway, so a network timeout cannot create a duplicate subscription.
      await dbRun(db, 'INSERT INTO cashfree_subscriptions(id,user_id,plan_id,status,authorization_status,session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        [id, req.user.id, plan.id, 'INITIALIZED', 'INITIALIZED', null, date, date]);
      const created = await gateway.createSubscription({
        subscription_id: id,
        customer_details: { customer_name: req.user.name, customer_email: req.user.email, customer_phone: phone },
        plan_details: { plan_id: plan.id, plan_name: plan.name, plan_type: 'PERIODIC' },
        subscription_meta: { return_url: publicBaseUrl + '/?billing=return', notification_channel: ['EMAIL', 'SMS'] },
        subscription_expiry_time: new Date(Date.now() + 3 * 365 * 86400000).toISOString(),
      });
      if (created?.subscription_id !== id || created.plan_details?.plan_id !== plan.id ||
          typeof created.subscription_session_id !== 'string' || !created.subscription_session_id) {
        throw new Error('Cashfree did not return an expected subscription session. Contact support before retrying.');
      }
      await dbRun(db, 'UPDATE cashfree_subscriptions SET session_id=?,status=?,updated_at=? WHERE id=? AND user_id=?',
        [created.subscription_session_id, created.subscription_status || 'INITIALIZED', new Date().toISOString(), id, req.user.id]);
      res.status(201).json({ sessionId: created.subscription_session_id, environment: config.environment });
    } finally {
      await dbRun(db, 'DELETE FROM cashfree_checkout_locks WHERE user_id=?', [req.user.id]);
    }
  });
  app.post('/api/billing/cancel', requireActive, async (req, res) => {
    const row = await newest(db, req.user.id);
    if (!row || ['CANCELLED', 'EXPIRED', 'COMPLETED'].includes(row.status)) throw new ValidationError('No active mandate to cancel.', 409);
    await gateway.cancelSubscription(row.id);
    res.json({ subscription: presentation(await reconcile(db, row, await gateway.fetchSubscription(row.id))) });
  });
  return {
    async canCreateCode(userId) {
      if (!config.enforce) return true;
      if (presentation(await newest(db, userId)).tier === 'Pro') return true;
      const result = await dbGet(db, 'SELECT COUNT(*) AS total FROM user_qr_codes WHERE user_id=?', [userId]);
      return Number(result.total) < config.freeLimit;
    },
  };
}
