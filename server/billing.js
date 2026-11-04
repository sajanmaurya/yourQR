import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { dbAll, dbGet, dbRun } from './database.js';
import { ValidationError } from './qr.js';

// Razorpay is the source of truth for subscriptions; no payment credentials reach the browser.
export function billingConfig(override) {
  if (override) return { freeLimit: 10, totalCount: 12, ...override };
  const enabled = process.env.BILLING_ENABLED === 'true' &&
    process.env.BILLING_ENFORCE_LIMITS === 'true' &&
    Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET &&
      process.env.RAZORPAY_PLAN_ID && process.env.RAZORPAY_WEBHOOK_SECRET);
  const totalCount = Number(process.env.RAZORPAY_TOTAL_COUNT || 12);
  const freeLimit = Number(process.env.FREE_QR_LIMIT || 10);
  if (enabled && (!Number.isInteger(totalCount) || totalCount < 1 || totalCount > 120 ||
      !Number.isInteger(freeLimit) || freeLimit < 1 || freeLimit > 10000)) {
    throw new Error('Invalid billing cycle count or free QR limit.');
  }
  return {
    enabled,
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    planId: process.env.RAZORPAY_PLAN_ID,
    totalCount: Number.isInteger(totalCount) ? totalCount : 12,
    freeLimit: Number.isInteger(freeLimit) ? freeLimit : 10,
  };
}

export function createRazorpayGateway(config) {
  const auth = Buffer.from(config.keyId + ':' + config.keySecret).toString('base64');
  async function request(method, route, body) {
    const response = await fetch('https://api.razorpay.com/v1' + route, {
      method,
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('Razorpay returned HTTP ' + response.status + '. Check merchant plan, credentials and Subscriptions access.');
    return response.json();
  }
  return {
    fetchPlan: planId => request('GET', '/plans/' + encodeURIComponent(planId)),
    createSubscription: args => request('POST', '/subscriptions', args),
    fetchSubscription: id => request('GET', '/subscriptions/' + encodeURIComponent(id)),
    cancelSubscription: (id, atCycleEnd) => request('POST', '/subscriptions/' + encodeURIComponent(id) + '/cancel', { cancel_at_cycle_end: atCycleEnd }),
  };
}

const allowedStatuses = new Set(['created', 'authenticated', 'active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired']);
const billableStatuses = new Set(['active']);
function trustedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'rzp.io' || url.hostname === 'razorpay.com' ||
      url.hostname.endsWith('.razorpay.com'));
  } catch { return false; }
}
function compactSubscription(row) {
  if (!row) return { tier: 'Free', status: 'none', renewsAt: null, cancelScheduled: false };
  const paid = billableStatuses.has(row.status) && Number(row.current_end || 0) * 1000 > Date.now();
  return {
    tier: paid ? 'Pro' : 'Free',
    status: row.status,
    renewsAt: row.current_end ? new Date(Number(row.current_end) * 1000).toISOString() : null,
    cancelScheduled: Boolean(row.cancel_scheduled),
    // The link is useful when a payment attempt needs to be resumed.
    checkoutUrl: row.status === 'created' && trustedUrl(row.payment_url) ? row.payment_url : null,
  };
}
async function latest(db, userId) {
  return dbGet(db, 'SELECT * FROM billing_subscriptions WHERE user_id=? ORDER BY created_at DESC LIMIT 1', [userId]);
}
async function persistProviderState(db, row, provider) {
  if (!provider || provider.id !== row.id || provider.plan_id !== row.plan_id ||
      !allowedStatuses.has(provider.status)) throw new Error('Razorpay subscription details did not match the stored billing record.');
  const end = Number.isSafeInteger(provider.current_end) && provider.current_end > 0 ? provider.current_end : null;
  const scheduled = Number(Boolean(provider.has_scheduled_changes && provider.change_scheduled_at === 'cycle_end'));
  await dbRun(db, 'UPDATE billing_subscriptions SET status=?,current_end=?,cancel_scheduled=?,updated_at=? WHERE id=? AND plan_id=?',
    [provider.status, end, scheduled, new Date().toISOString(), row.id, row.plan_id]);
  return latest(db, row.user_id);
}
function verifyWebhook(raw, signature, secret) {
  if (!Buffer.isBuffer(raw) || !secret || !/^[a-f0-9]{64}$/i.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function registerBillingWebhook(app, db, config, gateway) {
  // MUST be registered before express.json() and origin/session middleware.
  app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res, next) => {
    if (!config.enabled) return res.status(503).end();
    if (!verifyWebhook(req.body, req.get('x-razorpay-signature'), config.webhookSecret)) return res.status(400).end();
    const eventId = req.get('x-razorpay-event-id');
    if (!eventId || !/^[a-z0-9_-]{6,128}$/i.test(eventId)) return res.status(400).end();
    let event;
    try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).end(); }
    if (!event || typeof event.event !== 'string') return res.status(400).end();
    if (!event.event.startsWith('subscription.')) return res.status(200).json({ ok: true });
    const subscriptionId = event.payload?.subscription?.entity?.id;
    if (typeof subscriptionId !== 'string' || !/^sub_[a-z0-9]+$/i.test(subscriptionId)) return res.status(400).end();
    try {
      if (await dbGet(db, 'SELECT id FROM billing_webhook_events WHERE id=?', [eventId])) return res.json({ ok: true });
      const row = await dbGet(db, 'SELECT * FROM billing_subscriptions WHERE id=?', [subscriptionId]);
      if (!row) return res.json({ ok: true }); // Another product sharing this merchant account.
      const provider = await gateway.fetchSubscription(subscriptionId); // Current status defeats out-of-order events.
      await persistProviderState(db, row, provider);
      await dbRun(db, 'INSERT INTO billing_webhook_events(id,subscription_id,event_type,processed_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING',
        [eventId, subscriptionId, event.event, new Date().toISOString()]);
      res.json({ ok: true });
    } catch (error) { next(error); } // Non-2xx makes Razorpay retry.
  });
}

export function registerBillingApi(app, db, config, gateway) {
  const requireBilling = (req, res, next) => config.enabled ? next() :
    res.status(503).json({ error: 'Paid subscriptions are not enabled yet.' });
  const getVerifiedPlan = async () => {
    const plan = await gateway.fetchPlan(config.planId);
    const amount = Number(plan?.item?.amount);
    if (plan.id !== config.planId || plan.item?.currency !== 'INR' || !Number.isSafeInteger(amount) ||
      amount < 100 || !Number.isInteger(Number(plan.interval)) || Number(plan.interval) < 1) {
      throw new Error('Configured Razorpay plan was not valid. Use an INR recurring plan.');
    }
    return { name: 'Pro', amountPaise: amount, currency: 'INR', period: plan.period, interval: Number(plan.interval) };
  };
  app.get('/api/billing', async (req, res) => {
    const row = await latest(db, req.user.id);
    res.json({
      enabled: Boolean(config.enabled),
      freeLimit: config.enabled ? config.freeLimit : null,
      plan: config.enabled ? await getVerifiedPlan() : null,
      subscription: compactSubscription(row),
    });
  });
  app.post('/api/billing/sync', requireBilling, async (req, res) => {
    const row = await latest(db, req.user.id);
    if (!row) return res.json({ subscription: compactSubscription(null) });
    const remote = await gateway.fetchSubscription(row.id);
    const updated = await persistProviderState(db, row, remote);
    res.json({ subscription: compactSubscription(updated) });
  });
  app.post('/api/billing/checkout', requireBilling, async (req, res) => {
    // An atomic per-user lock prevents duplicate subscriptions from double-clicks
    // or requests racing across different serverless instances.
    const lock = await dbGet(db, `INSERT INTO billing_checkout_locks(user_id,locked_until) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET locked_until=excluded.locked_until
      WHERE billing_checkout_locks.locked_until < ? RETURNING user_id`,
      [req.user.id, Date.now() + 30000, Date.now()]);
    if (!lock) throw new ValidationError('A checkout is already being prepared. Try again shortly.', 409);
    try {
      let row = await latest(db, req.user.id);
      if (row && ['created', 'authenticated', 'pending', 'halted', 'paused', 'active'].includes(row.status)) {
        const fresh = await gateway.fetchSubscription(row.id);
        row = await persistProviderState(db, row, fresh);
        if (compactSubscription(row).tier === 'Pro') throw new ValidationError('You already have an active Pro subscription.', 409);
        if (row.status === 'created' && trustedUrl(row.payment_url)) return res.json({ checkoutUrl: row.payment_url });
        if (['authenticated', 'pending', 'halted', 'paused', 'active'].includes(row.status))
          throw new ValidationError('You already have a subscription. Check its status or contact support before starting another.', 409);
      }
      await getVerifiedPlan(); // Do not create a checkout for an invalid merchant plan.
      const created = await gateway.createSubscription({
        plan_id: config.planId, total_count: config.totalCount, quantity: 1,
        customer_notify: true, notify_info: { notify_email: req.user.email },
        notes: { app: 'yourQR', user_id: String(req.user.id) },
      });
      if (!/^sub_[a-z0-9]+$/i.test(created?.id || '') || created.plan_id !== config.planId ||
          created.status !== 'created' || !trustedUrl(created.short_url)) {
        throw new Error('Razorpay did not return a valid subscription link.');
      }
      await dbRun(db, 'INSERT INTO billing_subscriptions(id,user_id,plan_id,status,payment_url,current_end,cancel_scheduled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [created.id, req.user.id, config.planId, 'created', created.short_url, null, 0, new Date().toISOString(), new Date().toISOString()]);
      res.status(201).json({ checkoutUrl: created.short_url });
    } finally {
      await dbRun(db, 'DELETE FROM billing_checkout_locks WHERE user_id=?', [req.user.id]);
    }
  });
  app.post('/api/billing/cancel', requireBilling, async (req, res) => {
    const row = await latest(db, req.user.id);
    if (!row || !['active', 'authenticated', 'created'].includes(row.status))
      throw new ValidationError('There is no cancellable subscription.', 409);
    const provider = await gateway.cancelSubscription(row.id, row.status === 'active');
    const updated = await persistProviderState(db, row, provider);
    res.json({ subscription: compactSubscription(updated) });
  });
  // Enforce only when explicitly activated with a complete merchant setup.
  return {
    enabled: Boolean(config.enabled),
    async canCreateCode(userId) {
      if (!config.enabled) return true;
      const row = await latest(db, userId);
      if (compactSubscription(row).tier === 'Pro') return true;
      const count = await dbGet(db, 'SELECT COUNT(*) AS total FROM user_qr_codes WHERE user_id=?', [userId]);
      return Number(count.total) < config.freeLimit;
    },
  };
}
