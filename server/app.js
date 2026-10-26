import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isLanAddressStale } from '../shared/network.js';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { openDatabase, hashPassword, verifyPassword } from './database.js';
import { openPostgresDatabase } from './postgres.js';
import { contentType as getContentType } from '../shared/content-types.js';
import { resolveContent } from './content.js';
import { registerAssets, mapAsset } from './assets.js';
import { ValidationError, textField, validColor, validateColors, validDestination, validSlug, validLogo, renderQR } from './qr.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_DAYS = 7;
const cookieName = 'qori_session';
const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const isLoopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const cleanUser = (owner) => owner ? { id: owner.id, name: owner.name, email: owner.email } : null;

function constantEquals(a, b) {
  const left = createHash('sha256').update(String(a || '')).digest();
  const right = createHash('sha256').update(String(b || '')).digest();
  return timingSafeEqual(left, right);
}

function parseCookie(value) {
  const cookies = {};
  for (const part of String(value || '').split(';')) {
    const position = part.indexOf('=');
    if (position < 0) continue;
    try { cookies[part.slice(0, position).trim()] = decodeURIComponent(part.slice(position + 1).trim()); } catch { /* Ignore malformed cookies. */ }
  }
  return cookies;
}

export function createApp(options = {}) {
  const dbPath = options.dbPath ?? path.resolve(appRoot, process.env.DB_PATH || 'data/qori.sqlite');
  const publicBaseUrl = String(options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
  let publicUrl;
  try { publicUrl = new URL(publicBaseUrl); } catch { throw new Error('PUBLIC_BASE_URL must be a complete http(s) URL.'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') {
    throw new Error('PUBLIC_BASE_URL must be an http(s) origin without a path, credentials, query, or fragment.');
  }
  const environment = options.environment ?? process.env.NODE_ENV ?? 'development';
  const saasMode = options.saasMode ?? (process.env.SAAS_MODE === 'true');
  const verificationRequired = saasMode && (environment === 'production' || options.requireEmailVerification === true);
  const emailSender = options.emailSender || (async ({ to, url, purpose = 'verify' }) => {
    if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) throw new Error('Email service is not configured.');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM, to: [to], subject: purpose === 'reset' ? 'Reset your Qori password' : 'Verify your Qori email',
        text: purpose === 'reset' ? 'Reset your Qori password using this link: ' + url + '\n\nThis link expires in 30 minutes.' : 'Verify your email to activate Qori: ' + url + '\n\nThis link expires in 24 hours.',
      }),
    });
    if (!response.ok) throw new Error('Email provider rejected verification request.');
  });
  if (verificationRequired && !options.emailSender && (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM)) {
    throw new Error('Production SaaS requires RESEND_API_KEY and MAIL_FROM for email verification.');
  }
  const setupToken = options.setupToken ?? process.env.SETUP_TOKEN ?? '';
  const secureCookie = options.secureCookie ?? (process.env.COOKIE_SECURE !== undefined ? process.env.COOKIE_SECURE === 'true' : publicUrl.protocol === 'https:');
  if (environment === 'production' && saasMode && (publicUrl.protocol !== 'https:' || !secureCookie)) {
    throw new Error('Production SaaS requires a permanent HTTPS PUBLIC_BASE_URL and secure session cookies.');
  }
  const proxyHops = Number(options.trustProxy ?? process.env.TRUST_PROXY ?? 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) throw new Error('TRUST_PROXY must be an integer from 0 to 5.');
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const db = databaseUrl ? openPostgresDatabase(databaseUrl, { maxConnections: process.env.VERCEL === '1' ? 2 : 10 }) : openDatabase(dbPath);
  // Preserve fail-fast setup checks for the existing synchronous SQLite mode.
  if (!databaseUrl && environment === 'production' && !saasMode && !setupToken && !db.prepare('SELECT id FROM owner WHERE id = 1').get()) {
    db.close();
    throw new Error('Set a strong SETUP_TOKEN before first production startup. Remove it after creating your owner account.');
  }
  let analyticsSecret;
  const ready = (async () => {
    await db.ready;
    await db.prepare("UPDATE qr_codes SET encoded_value = CASE WHEN type = 'dynamic' THEN ? || '/r/' || slug ELSE destination END WHERE encoded_value IS NULL")
      .run(publicBaseUrl);
    if (databaseUrl && environment === 'production' && !saasMode && !setupToken && !await db.prepare('SELECT id FROM owner WHERE id = 1').get()) {
      await db.close();
      throw new Error('Set a strong SETUP_TOKEN before first production startup. Remove it after creating your owner account.');
    }
    analyticsSecret = (await db.prepare('SELECT value FROM settings WHERE key = ?').get('analytics_secret')).value;
    // Old printed QR codes linking to large files must not silently break
    // after moving to Vercel's 4.5MB Function response ceiling.
    if (process.env.VERCEL === '1') {
      const oversized = await db.prepare('SELECT COUNT(*) AS count FROM assets a WHERE a.size > ? AND EXISTS (SELECT 1 FROM qr_codes q WHERE q.asset_id=a.id AND q.active=1)').get(4000000);
      if (Number(oversized.count) > 0) {
        throw new Error('Vercel cannot serve existing QR-linked files larger than 4MB. Migrate those assets to object storage before deployment.');
      }
    }
  })();
  ready.catch(() => {}); // Prevent unhandled-rejection process termination before the first request.
  const app = express();
  // Startup is fail-closed: all routes await schema initialization and secret loading.
  app.use(async (req, res, next) => { try { await ready; next(); } catch (error) { next(error); } });
  app.disable('x-powered-by');
  if (proxyHops) app.set('trust proxy', proxyHops);
  app.use(helmet({
    contentSecurityPolicy: environment === 'production' ? {
      directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], fontSrc: ["'self'", 'data:'], connectSrc: ["'self'"], upgradeInsecureRequests: publicUrl.protocol === 'https:' ? [] : null },
    } : false,
    strictTransportSecurity: publicUrl.protocol === 'https:' ? undefined : false,
  }));
  app.use(express.json({ limit: '350kb' }));
  app.use('/api', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      const allowed = [publicUrl.origin];
      if (environment !== 'production') allowed.push('http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8787', 'http://127.0.0.1:8787');
      if (req.get('sec-fetch-site') === 'cross-site' || (origin && !allowed.includes(origin))) {
        return res.status(403).json({ error: 'This request came from an untrusted site.' });
      }
    }
    const cookie = parseCookie(req.get('cookie'))[cookieName];
    if (cookie && /^[a-f0-9]{64}$/.test(cookie)) {
      const session = await db.prepare('SELECT owner.* FROM sessions JOIN owner ON sessions.owner_id = owner.id WHERE token_hash = ? AND expires_at > ?')
        .get(tokenHash(cookie), Date.now());
      if (session) { req.user = cleanUser(session); req.ownerKey = 'legacy'; }
      else if (saasMode) {
        const account = await db.prepare('SELECT accounts.* FROM account_sessions JOIN accounts ON account_sessions.account_id=accounts.id WHERE token_hash=? AND expires_at>?').get(tokenHash(cookie), Date.now());
        if (account) { req.user = cleanUser(account); req.ownerKey = account.id; }
      }
    }
    next();
  });

  const cookieOptions = { httpOnly: true, secure: secureCookie, sameSite: 'strict', path: '/', maxAge: SESSION_DAYS * 86400000 };
  const startSession = async (res, owner) => {
    await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    await db.prepare('DELETE FROM account_sessions WHERE expires_at <= ?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    if (typeof owner.id === 'string') await db.prepare('INSERT INTO account_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), owner.id, Date.now() + SESSION_DAYS * 86400000);
    else await db.prepare('INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), owner.id, Date.now() + SESSION_DAYS * 86400000);
    res.cookie(cookieName, token, cookieOptions);
  };
  const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please sign in to continue.' });
  const attempts = new Map();
  const limitAuth = (req, res, next) => {
    const now = Date.now();
    if (attempts.size > 5000) for (const [key, entry] of attempts) if (entry.reset <= now) attempts.delete(key);
    const key = req.ip || 'unknown';
    let entry = attempts.get(key);
    if (!entry || entry.reset <= now) entry = { count: 0, reset: now + 15 * 60 * 1000 };
    entry.count++;
    attempts.set(key, entry);
    if (entry.count > 12) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many sign-in attempts. Please try again in 15 minutes.' });
    }
    next();
  };
  const config = () => ({ publicBaseUrl, environment, version: '1.0.0', setupTokenRequired: Boolean(setupToken), localOnly: ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname), registrationEnabled: saasMode, emailVerificationRequired: verificationRequired, lanAddressStale: isLanAddressStale(publicBaseUrl, Object.values(networkInterfaces()).flat().filter(Boolean).map(item => item.address)) });

  app.get('/api/health', async (req, res) => res.json({ status: 'ok', version: '1.0.0' }));
  app.get('/api/auth/session', async (req, res) => {
    const owner = await db.prepare('SELECT id FROM owner WHERE id = 1').get();
    res.json({ authenticated: Boolean(req.user), setupRequired: !saasMode && !owner, user: req.user || null, config: config() });
  });
  app.post('/api/auth/register', limitAuth, async (req, res) => {
    if (!saasMode) throw new ValidationError('Public registration is not enabled.', 403);
    const name = textField(req.body?.name, 'Name', 80);
    const email = textField(req.body?.email, 'Email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Enter a valid email address.');
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new ValidationError('Choose a password with 12–256 characters.');
    if (await db.prepare('SELECT id FROM owner WHERE email=?').get(email)) throw new ValidationError('An account already uses this email.', 409);
    const hash = await hashPassword(password);
    const user = { id: randomUUID(), name, email };
    try {
      await db.transaction(async tx => {
        await tx.prepare('INSERT INTO accounts(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)').run(user.id, name, email, hash, new Date().toISOString());
        if (db.dialect === 'postgres') {
          await tx.prepare('INSERT INTO workspaces(id,name,owner_account_id,created_at) VALUES(?,?,?,?)').run(user.id, name + ' workspace', user.id, new Date().toISOString());
          await tx.prepare('INSERT INTO workspace_memberships(workspace_id,account_id,role) VALUES(?,?,?)').run(user.id, user.id, 'owner');
        }
      });
    } catch (error) {
      if (error.code === '23505' || String(error.message).includes('UNIQUE')) throw new ValidationError('An account already uses this email.', 409);
      throw error;
    }
    if (verificationRequired) {
      const token = randomBytes(32).toString('hex');
      await db.prepare('INSERT INTO email_verifications(account_id,token_hash,expires_at) VALUES(?,?,?)')
        .run(user.id, tokenHash(token), Date.now() + 86400000);
      try { await emailSender({ to: email, url: publicBaseUrl + '/?verify=' + token }); }
      catch {
        await db.transaction(async tx => {
          if (db.dialect === 'postgres') {
            await tx.prepare('DELETE FROM workspace_memberships WHERE account_id=?').run(user.id);
            await tx.prepare('DELETE FROM workspaces WHERE id=?').run(user.id);
          }
          await tx.prepare('DELETE FROM accounts WHERE id=?').run(user.id);
        });
        throw new ValidationError('Verification email could not be sent. Please try again.', 503);
      }
      return res.status(201).json({ requiresVerification: true, message: 'Check your email for the verification link.' });
    }
    await startSession(res, user);
    res.status(201).json({ user });
  });
  app.post('/api/auth/verify-email', limitAuth, async (req, res) => {
    if (!saasMode) throw new ValidationError('Email verification is disabled.', 403);
    const token = req.body?.token;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new ValidationError('Invalid or expired verification link.');
    const record = await db.prepare('SELECT account_id FROM email_verifications WHERE token_hash=? AND expires_at>?').get(tokenHash(token), Date.now());
    if (!record) throw new ValidationError('Invalid or expired verification link.');
    await db.transaction(async tx => {
      await tx.prepare('UPDATE accounts SET verified_at=? WHERE id=?').run(new Date().toISOString(), record.account_id);
      await tx.prepare('DELETE FROM email_verifications WHERE account_id=?').run(record.account_id);
    });
    res.json({ verified: true });
  });
  app.post('/api/auth/resend-verification', limitAuth, async (req, res) => {
    if (!verificationRequired) throw new ValidationError('Email verification is disabled.', 403);
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (email && email.length <= 254) {
      const account = await db.prepare('SELECT id FROM accounts WHERE email=? AND verified_at IS NULL').get(email);
      if (account) {
        const token = randomBytes(32).toString('hex');
        await db.prepare('INSERT INTO email_verifications(account_id,token_hash,expires_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET token_hash=excluded.token_hash, expires_at=excluded.expires_at')
          .run(account.id, tokenHash(token), Date.now() + 86400000);
        try { await emailSender({ to: email, url: publicBaseUrl + '/?verify=' + token }); }
        catch { console.error('Qori verification resend delivery failed.'); }
      }
    }
    res.json({ message: 'If verification is required, a fresh link has been sent.' });
  });
  app.post('/api/auth/request-password-reset', limitAuth, async (req, res) => {
    if (!saasMode) throw new ValidationError('Account recovery is disabled.', 403);
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const result = { message: 'If the account exists, an email with a reset link has been sent.' };
    if (!email || email.length > 254) return res.json(result);
    const account = await db.prepare('SELECT id,verified_at FROM accounts WHERE email=?').get(email);
    if (account && (!verificationRequired || account.verified_at)) {
      const token = randomBytes(32).toString('hex');
      await db.prepare('INSERT INTO password_resets(account_id,token_hash,expires_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at')
        .run(account.id, tokenHash(token), Date.now() + 30 * 60000);
      try { await emailSender({ to: email, url: publicBaseUrl + '/?reset=' + token, purpose: 'reset' }); }
      catch {
        await db.prepare('DELETE FROM password_resets WHERE account_id=?').run(account.id);
        // Do not disclose whether a particular address belongs to an account.
        console.error('Qori password reset email delivery failed.');
      }
    }
    res.json(result);
  });
  app.post('/api/auth/reset-password', limitAuth, async (req, res) => {
    if (!saasMode) throw new ValidationError('Account recovery is disabled.', 403);
    const token = req.body?.token;
    const password = req.body?.password;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new ValidationError('Invalid or expired password-reset link.');
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new ValidationError('Choose a password with 12–256 characters.');
    const record = await db.prepare('SELECT account_id FROM password_resets WHERE token_hash=? AND expires_at>?').get(tokenHash(token), Date.now());
    if (!record) throw new ValidationError('Invalid or expired password-reset link.');
    const hashed = await hashPassword(password);
    await db.transaction(async tx => {
      await tx.prepare('UPDATE accounts SET password_hash=? WHERE id=?').run(hashed, record.account_id);
      await tx.prepare('DELETE FROM account_sessions WHERE account_id=?').run(record.account_id);
      await tx.prepare('DELETE FROM password_resets WHERE account_id=?').run(record.account_id);
    });
    res.json({ updated: true });
  });
  app.post('/api/auth/setup', limitAuth, async (req, res) => {
    if (saasMode) throw new ValidationError('Legacy owner setup is disabled in SaaS mode.', 403);
    if (await db.prepare('SELECT id FROM owner WHERE id = 1').get()) throw new ValidationError('An owner account already exists. Please sign in.', 409);
    if (setupToken ? !constantEquals(req.body?.setupToken, setupToken) : !isLoopback(req.ip)) {
      throw new ValidationError(setupToken ? 'The setup token is incorrect.' : 'Create the first owner on this computer, or configure SETUP_TOKEN for remote setup.', 403);
    }
    const name = textField(req.body?.name, 'Name', 80);
    const email = textField(req.body?.email, 'Email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Enter a valid email address.');
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new ValidationError('Choose a password with 12–256 characters.');
    const passwordHash = await hashPassword(password);
    try {
      await db.prepare('INSERT INTO owner (id, name, email, password_hash, created_at) VALUES (1, ?, ?, ?, ?)').run(name, email, passwordHash, new Date().toISOString());
    } catch (error) {
      if (error.code === '23505' || String(error.message).includes('UNIQUE') || String(error.message).includes('PRIMARY KEY')) throw new ValidationError('An owner account already exists. Please sign in.', 409);
      throw error;
    }
    const user = { id: 1, name, email };
    await startSession(res, user);
    res.status(201).json({ user });
  });
  app.post('/api/auth/login', limitAuth, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || email.length > 254 || password.length > 256) throw new ValidationError('Email or password is incorrect.', 401);
    const owner = await db.prepare('SELECT * FROM owner WHERE email=?').get(email);
    const account = saasMode ? await db.prepare('SELECT * FROM accounts WHERE email=?').get(email) : null;
    const candidate = account || owner;
    const stored = candidate?.password_hash || 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64);
    const valid = await verifyPassword(password, stored);
    if (!candidate || !valid) throw new ValidationError('Email or password is incorrect.', 401);
    if (verificationRequired && account && !account.verified_at) throw new ValidationError('Verify your email before signing in.', 403);
    await startSession(res, candidate);
    attempts.delete(req.ip || 'unknown');
    res.json({ user: cleanUser(candidate) });
  });
  app.post('/api/auth/logout', async (req, res) => {
    const token = parseCookie(req.get('cookie'))[cookieName];
    if (token) { await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)); await db.prepare('DELETE FROM account_sessions WHERE token_hash = ?').run(tokenHash(token)); }
    res.clearCookie(cookieName, { httpOnly: true, secure: secureCookie, sameSite: 'strict', path: '/' });
    res.json({ ok: true });
  });

  app.use('/api', requireAuth);
  const servePublicAsset = registerAssets(app, db);
  const getRow = async (id, ownerKey) => {
    const row = await db.prepare('SELECT q.*, (SELECT COUNT(*) FROM scans WHERE qr_id=q.id) AS scan_count FROM qr_codes q WHERE q.id = ? AND q.owner_key=?').get(id, ownerKey);
    if (!row) throw new ValidationError('QR code not found.', 404);
    return row;
  };
  const mapQR = async (row) => ({
    id: row.id, name: row.name, type: row.type, contentType: row.category || row.content_type,
    payload: JSON.parse(row.payload_json || '{}'), assetId: row.asset_id || null,
    asset: row.asset_id ? mapAsset(await db.prepare('SELECT id,kind,name,mime,size,created_at FROM assets WHERE id=? AND owner_key=?').get(row.asset_id, row.owner_key)) : null,
    destination: row.destination, slug: row.slug, fgColor: row.fg_color, bgColor: row.bg_color,
    logoDataUrl: row.logo_data_url, folderId: row.folder_id, active: Boolean(row.active),
    createdAt: row.created_at, updatedAt: row.updated_at, scanCount: Number(row.scan_count || 0),
    encodedValue: row.encoded_value,
    shortUrl: row.type === 'dynamic' ? row.encoded_value : null,
  });
  const validFolderId = async (value, ownerKey) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !await db.prepare('SELECT id FROM folders WHERE id = ? AND owner_key=?').get(value, ownerKey)) throw new ValidationError('Choose an existing folder.');
    return value;
  };
  const prepareQR = async (body, current = null, preview = false, ownerKey) => {
    const input = body || {};
    const contentType = input.contentType ?? current?.contentType ?? 'url';
    const meta = getContentType(contentType);
    if (!meta) throw new ValidationError('Choose a supported QR content type.');
    const type = input.type ?? current?.type ?? meta.mode ?? 'dynamic';
    if (!['static', 'dynamic'].includes(type)) throw new ValidationError('Choose a valid QR type.');
    if (meta.mode && type !== meta.mode) throw new ValidationError(`${meta.name} codes use ${meta.mode} mode.`);
    if (current && (type !== current.type || contentType !== current.contentType)) throw new ValidationError('A saved code’s type cannot change. Create a new code instead.');
    const name = preview ? String(input.name || 'Preview') : textField(input.name ?? current?.name, 'Name');
    const resolved = await resolveContent(contentType, input, { publicBaseUrl, current, db, ownerKey });
    const { destination, storageType, payload, assetId } = resolved;
    if (storageType === 'url') {
      const destinationUrl = new URL(destination);
      if (/^\/r(?:\/|$)/i.test(destinationUrl.pathname)) {
        const savedOrigins = await db.prepare("SELECT DISTINCT encoded_value FROM qr_codes WHERE type='dynamic'").all();
        if (savedOrigins.some((row) => new URL(row.encoded_value).origin === destinationUrl.origin)) {
          throw new ValidationError('A QR destination cannot point to this app’s existing redirect origins.');
        }
      }
    }
    if (['app', 'smart'].includes(contentType)) {
      for (const target of [payload.fallbackUrl, payload.iosUrl, payload.androidUrl].filter(Boolean)) {
        const value = new URL(target);
        if (/^\/(?:r|files)(?:\/|$)/i.test(value.pathname)) {
          const ownOrigins = [publicUrl.origin, ...(await db.prepare("SELECT encoded_value FROM qr_codes WHERE type='dynamic'").all()).map(row => new URL(row.encoded_value).origin)];
          if (ownOrigins.includes(value.origin)) throw new ValidationError('Device routes cannot point to this app’s redirect or file endpoints.');
        }
      }
    }
    if (current?.type === 'static' && destination !== current.destination) throw new ValidationError('A static QR destination is permanent. Create a new code to use different content.');
    let slug = null;
    if (type === 'dynamic') {
      slug = input.slug ?? current?.slug ?? (preview ? 'preview' : randomBytes(5).toString('hex'));
      slug = validSlug(slug, { preview });
      if (current && slug !== current.slug) throw new ValidationError('The printed redirect slug is permanent. Edit its destination instead.');
      if (!preview && await db.prepare('SELECT id FROM qr_codes WHERE slug = ? AND id != ?').get(slug, current?.id || '')) throw new ValidationError('This short-link slug is already in use.', 409);
    }
    const fgColor = validColor(input.fgColor ?? current?.fgColor, '#163A35');
    const bgColor = validColor(input.bgColor ?? current?.bgColor, '#FFFFFF');
    validateColors(fgColor, bgColor);
    const logoDataUrl = Object.hasOwn(input, 'logoDataUrl') ? await validLogo(input.logoDataUrl) : current?.logoDataUrl ?? null;
    const folderId = await validFolderId(input.folderId === undefined ? current?.folderId : input.folderId, ownerKey);
    const active = input.active ?? current?.active ?? true;
    if (typeof active !== 'boolean') throw new ValidationError('Active must be true or false.');
    if (type === 'static' && !active) throw new ValidationError('A static QR code points directly to its content and cannot be paused.');
    const qr = { name, type, contentType, storageType, payload, assetId, destination, slug, fgColor, bgColor, logoDataUrl, folderId, active, encodedValue: current?.encodedValue ?? (type === 'dynamic' ? `${publicBaseUrl}/r/${slug}` : destination) };
    await renderQR(qr);
    return qr;
  };
  app.get('/api/qrs', async (req, res) => {
    const qrs = await Promise.all((await db.prepare('SELECT q.*, (SELECT COUNT(*) FROM scans WHERE qr_id=q.id) AS scan_count FROM qr_codes q WHERE q.owner_key=? ORDER BY created_at DESC').all(req.ownerKey)).map(mapQR));
    res.json({ qrs });
  });
  app.post('/api/qrs', async (req, res) => {
    const qr = await prepareQR(req.body, null, false, req.ownerKey);
    const id = randomUUID(), now = new Date().toISOString();
    try {
      await db.prepare('INSERT INTO qr_codes (id,name,type,content_type,category,payload_json,asset_id,destination,encoded_value,slug,fg_color,bg_color,logo_data_url,folder_id,active,created_at,updated_at,owner_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, qr.name, qr.type, qr.storageType, qr.contentType, JSON.stringify(qr.payload), qr.assetId, qr.destination, qr.encodedValue, qr.slug, qr.fgColor, qr.bgColor, qr.logoDataUrl, qr.folderId, Number(qr.active), now, now, req.ownerKey);
    } catch (error) {
      if (error.code === '23505' || String(error.message).includes('UNIQUE')) throw new ValidationError('This short-link slug is already in use.', 409);
      throw error;
    }
    res.status(201).json({ qr: await mapQR(await getRow(id, req.ownerKey)) });
  });
  app.patch('/api/qrs/:id', async (req, res) => {
    const current = await mapQR(await getRow(req.params.id, req.ownerKey));
    const qr = await prepareQR(req.body, current, false, req.ownerKey);
    await db.prepare('UPDATE qr_codes SET name=?,destination=?,payload_json=?,asset_id=?,fg_color=?,bg_color=?,logo_data_url=?,folder_id=?,active=?,updated_at=? WHERE id=?')
      .run(qr.name, qr.destination, JSON.stringify(qr.payload), qr.assetId, qr.fgColor, qr.bgColor, qr.logoDataUrl, qr.folderId, Number(qr.active), new Date().toISOString(), current.id);
    res.json({ qr: await mapQR(await getRow(current.id, req.ownerKey)) });
  });
  app.delete('/api/qrs/:id', async (req, res) => {
    await getRow(req.params.id, req.ownerKey);
    await db.prepare('DELETE FROM qr_codes WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/preview', async (req, res) => {
    if (req.body?.id !== undefined && typeof req.body.id !== 'string') throw new ValidationError('Choose a valid saved QR code for the preview.');
    const current = req.body?.id ? await mapQR(await getRow(req.body.id, req.ownerKey)) : null;
    const qr = await prepareQR(req.body, current, true, req.ownerKey);
    res.json({ svg: await renderQR(qr), encodedValue: qr.encodedValue });
  });
  app.get('/api/qrs/:id/download', async (req, res) => {
    const format = req.query.format || 'svg';
    if (!['svg', 'png'].includes(format)) throw new ValidationError('Download format must be svg or png.');
    const qr = await mapQR(await getRow(req.params.id, req.ownerKey));
    const filename = qr.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'qori-code';
    res.type(format === 'svg' ? 'image/svg+xml' : 'image/png');
    res.attachment(`${filename}.${format}`);
    res.send(await renderQR(qr, format));
  });

  const folderRows = async (ownerKey) => await db.prepare('SELECT f.*, (SELECT COUNT(*) FROM qr_codes WHERE folder_id = f.id) AS qr_count FROM folders f WHERE f.owner_key=? ORDER BY name COLLATE NOCASE').all(ownerKey);
  const mapFolder = (row) => ({ id: row.id, name: row.name, color: row.color, qrCount: Number(row.qr_count || 0) });
  app.get('/api/folders', async (req, res) => res.json({ folders: (await folderRows(req.ownerKey)).map(mapFolder) }));
  app.post('/api/folders', async (req, res) => {
    const name = textField(req.body?.name, 'Folder name', 60), color = validColor(req.body?.color, '#638A78');
    const id = randomUUID();
    try { await db.prepare('INSERT INTO folders (id,name,color,created_at,owner_key) VALUES (?,?,?,?,?)').run(id, name, color, new Date().toISOString(), req.ownerKey); }
    catch (error) { if (error.code === '23505' || String(error.message).includes('UNIQUE')) throw new ValidationError('A folder with this name already exists.', 409); throw error; }
    res.status(201).json({ folder: mapFolder((await folderRows(req.ownerKey)).find((row) => row.id === id)) });
  });
  app.patch('/api/folders/:id', async (req, res) => {
    const current = await db.prepare('SELECT * FROM folders WHERE id = ? AND owner_key=?').get(req.params.id, req.ownerKey);
    if (!current) throw new ValidationError('Folder not found.', 404);
    const name = textField(req.body?.name ?? current.name, 'Folder name', 60), color = validColor(req.body?.color, current.color);
    try { await db.prepare('UPDATE folders SET name=?,color=? WHERE id=?').run(name, color, current.id); }
    catch (error) { if (error.code === '23505' || String(error.message).includes('UNIQUE')) throw new ValidationError('A folder with this name already exists.', 409); throw error; }
    res.json({ folder: mapFolder((await folderRows(req.ownerKey)).find((row) => row.id === current.id)) });
  });
  app.delete('/api/folders/:id', async (req, res) => {
    const current = await db.prepare('SELECT id FROM folders WHERE id = ? AND owner_key=?').get(req.params.id, req.ownerKey);
    if (!current) throw new ValidationError('Folder not found.', 404);
    await db.prepare('DELETE FROM folders WHERE id = ?').run(current.id);
    res.json({ ok: true });
  });

  app.get('/api/analytics', async (req, res) => {
    const days = Number(req.query.days || 30);
    if (![7, 30, 90].includes(days)) throw new ValidationError('Choose a 7, 30, or 90 day analytics window.');
    const qrId = req.query.qrId;
    if (qrId && typeof qrId !== 'string') throw new ValidationError('Choose a valid QR code.');
    if (qrId) await getRow(qrId, req.ownerKey);
    const today = new Date();
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - days + 1));
    const startIso = start.toISOString();
    const scope = qrId ? ' AND s.qr_id = ?' : '';
    const args = qrId ? [startIso, req.ownerKey, qrId] : [startIso, req.ownerKey];
    const totals = await db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT visitor_hash) AS unique_visitors FROM scans s JOIN qr_codes q ON q.id=s.qr_id WHERE s.scanned_at >= ? AND q.owner_key=?${scope}`).get(...args);
    const daily = await db.prepare(`SELECT substr(s.scanned_at,1,10) AS date, COUNT(*) AS scans FROM scans s JOIN qr_codes q ON q.id=s.qr_id WHERE s.scanned_at >= ? AND q.owner_key=?${scope} GROUP BY date`).all(...args);
    const dailyMap = new Map(daily.map((row) => [row.date, Number(row.scans)]));
    const series = Array.from({ length: days }, (_, i) => {
      const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
      return { date, scans: dailyMap.get(date) || 0 };
    });
    const grouped = async (column) => (await db.prepare(`SELECT ${column} AS name, COUNT(*) AS count FROM scans s JOIN qr_codes q ON q.id=s.qr_id WHERE s.scanned_at >= ? AND q.owner_key=?${scope} GROUP BY ${column} ORDER BY count DESC, name ASC`).all(...args)).map((row) => ({ name: row.name, count: Number(row.count) }));
    const recent = await db.prepare(`SELECT s.id,q.name AS "qrName",s.scanned_at AS "scannedAt",s.device,s.referrer FROM scans s JOIN qr_codes q ON q.id=s.qr_id WHERE s.scanned_at >= ? AND q.owner_key=?${scope} ORDER BY s.scanned_at DESC LIMIT 20`).all(...args);
    const topCodes = (await db.prepare(`SELECT q.id,q.name,COUNT(s.id) AS scans FROM scans s JOIN qr_codes q ON q.id=s.qr_id WHERE s.scanned_at >= ? AND q.owner_key=?${scope} GROUP BY q.id ORDER BY scans DESC, q.name LIMIT 5`).all(...args)).map((row) => ({ ...row, scans: Number(row.scans) }));
    const counts = await db.prepare(`SELECT type,COUNT(*) AS count FROM qr_codes WHERE owner_key=?${qrId ? ' AND id=?' : ''} GROUP BY type`).all(...(qrId ? [req.ownerKey, qrId] : [req.ownerKey]));
    res.json({ totalScans: Number(totals.total), uniqueVisitors: Number(totals.unique_visitors), dynamicCount: Number(counts.find((row) => row.type === 'dynamic')?.count || 0), staticCount: Number(counts.find((row) => row.type === 'static')?.count || 0), series, devices: await grouped('s.device'), referrers: await grouped('s.referrer'), recent, topCodes, timezone: 'UTC', visitorMetric: 'Approximate daily unique visitors; repeat visitors on different days count again.' });
  });
  app.get('/api/settings', async (req, res) => res.json({ ...config(), database: db.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite', sessionDays: SESSION_DAYS, analyticsTimezone: 'UTC' }));
  app.get('/api/export', async (req, res) => {
    const qrs = await Promise.all((await db.prepare('SELECT q.*, (SELECT COUNT(*) FROM scans WHERE qr_id=q.id) AS scan_count FROM qr_codes q WHERE q.owner_key=? ORDER BY created_at').all(req.ownerKey)).map(mapQR));
    res.attachment(`qori-library-${new Date().toISOString().slice(0, 10)}.json`);
    res.json({ version: '1.0.0', exportedAt: new Date().toISOString(), publicBaseUrl, folders: (await folderRows(req.ownerKey)).map(mapFolder), qrs, note: 'Library export only. Copy the stopped SQLite database for a full backup including scan history and your account.' });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

  app.get('/r/:slug', async (req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const row = await db.prepare("SELECT id,destination,active,category,payload_json FROM qr_codes WHERE slug = ? AND type = 'dynamic'").get(req.params.slug);
    if (!row) return res.status(404).type('text/plain').send('This QR code was not found.');
    if (!row.active) return res.status(410).type('text/plain').send('This QR code is paused. Please contact its owner.');
    if (req.method === 'GET') {
      const now = new Date().toISOString(), ua = String(req.get('user-agent') || '').slice(0, 1000);
      const visitorHash = createHmac('sha256', analyticsSecret).update(`${now.slice(0, 10)}|${req.ip || ''}|${ua}`).digest('hex');
      const device = /bot|crawl|spider|slurp|preview/i.test(ua) ? 'Bot / preview' : /ipad|tablet/i.test(ua) ? 'Tablet' : /mobile|iphone|android/i.test(ua) ? 'Mobile' : ua ? 'Desktop' : 'Unknown';
      let referrer = 'Direct';
      try { const url = new URL(req.get('referer')); if (['http:', 'https:'].includes(url.protocol)) referrer = url.hostname.slice(0, 253); } catch { /* No usable referrer. */ }
      await db.prepare('INSERT INTO scans (id,qr_id,scanned_at,visitor_hash,device,referrer) VALUES (?,?,?,?,?,?)').run(randomUUID(), row.id, now, visitorHash, device, referrer);
    }
    let destination = row.destination;
    if (['app', 'smart'].includes(row.category)) {
      const routes = JSON.parse(row.payload_json || '{}'), ua = req.get('user-agent') || '';
      const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && /mobile/i.test(ua));
      destination = (ios ? routes.iosUrl : /android/i.test(ua) ? routes.androidUrl : '') || routes.fallbackUrl || destination;
    }
    res.redirect(302, destination);
  });
  app.get('/files/:id', servePublicAsset);
  app.use('/files', (req, res) => res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('File not found.'));
  app.use('/r', (req, res) => res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('This QR code was not found.'));

  const distPath = options.distPath ?? path.join(appRoot, 'dist');
  if (existsSync(path.join(distPath, 'index.html'))) {
    app.use(express.static(distPath, { index: false, maxAge: environment === 'production' ? '1h' : 0 }));
    app.use((req, res, next) => {
      if (req.method === 'GET' && req.accepts('html')) return res.sendFile(path.join(distPath, 'index.html'));
      next();
    });
  }
  app.use((req, res) => res.status(404).type('text/plain').send('Not found.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ValidationError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: req.path === '/api/assets' ? 'File uploads must be no larger than 25 MB. PDF/PPTX limits are 20 MB; images are 10 MB.' : 'Request is too large. Use a logo smaller than 200 KB.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must contain valid JSON.' });
    console.error('Qori request failed:', error.message);
    if (databaseUrl && /connection timeout|connection terminated|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN/i.test(error.message || '')) {
      res.set('Retry-After', '30');
      return res.status(503).json({ error: 'The database is temporarily unavailable. Please retry shortly.' });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  app.locals.ready = ready;
  app.locals.db = db;
  app.locals.close = () => db.close();
  app.locals.config = config();
  return app;
}
