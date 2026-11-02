import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isLanAddressStale } from '../shared/network.js';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { openDatabase, openPostgresDatabase, dbGet, dbAll, dbRun, hashPassword, verifyPassword } from './database.js';
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
  const setupToken = options.setupToken ?? process.env.SETUP_TOKEN ?? '';
  const secureCookie = options.secureCookie ?? (process.env.COOKIE_SECURE !== undefined ? process.env.COOKIE_SECURE === 'true' : publicUrl.protocol === 'https:');
  const proxyHops = Number(options.trustProxy ?? process.env.TRUST_PROXY ?? 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) throw new Error('TRUST_PROXY must be an integer from 0 to 5.');
  const usePostgres = Boolean(options.vercel || process.env.VERCEL === '1' || process.env.VERCEL === 'true');
  if (usePostgres && (publicUrl.protocol !== 'https:' || !process.env.BLOB_READ_WRITE_TOKEN)) {
    throw new Error('Vercel requires an HTTPS PUBLIC_BASE_URL and a private Blob store with BLOB_READ_WRITE_TOKEN.');
  }
  const db = options.db || (usePostgres ? openPostgresDatabase() : openDatabase(dbPath));
  if (environment === 'production' && !setupToken && db.driver !== 'postgres' && !db.prepare('SELECT id FROM owner WHERE id = 1').get()) {
    throw new Error('Set a strong SETUP_TOKEN before first production startup. Remove it after creating your owner account.');
  }
  let analyticsSecret = '';
  let startupError;
  const databaseReady = (async () => {
    if (db.ready) await db.ready;
    await dbRun(db, 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', ['analytics_secret', randomBytes(32).toString('hex')]);
    const setting = await dbGet(db, 'SELECT value FROM settings WHERE key = ?', ['analytics_secret']);
    analyticsSecret = setting.value;
    if (environment === 'production' && !setupToken && db.driver === 'postgres' && !(await dbGet(db, 'SELECT id FROM owner WHERE id = 1'))) {
      throw new Error('Set a strong SETUP_TOKEN before first production startup. Remove it after creating your owner account.');
    }
  })().catch(error => { startupError = error; });
  const app = express();
  app.use((req, res, next) => { databaseReady.then(() => next(startupError)); });
  app.disable('x-powered-by');
  if (proxyHops) app.set('trust proxy', proxyHops);
  app.use(helmet({
    contentSecurityPolicy: environment === 'production' ? {
      directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], fontSrc: ["'self'", 'data:'], connectSrc: ["'self'", ...(db.driver === 'postgres' ? ['https://*.blob.vercel-storage.com', 'https://vercel.com/api/blob'] : [])], upgradeInsecureRequests: publicUrl.protocol === 'https:' ? [] : null },
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
      const session = await dbGet(db, 'SELECT owner.* FROM sessions JOIN owner ON sessions.owner_id = owner.id WHERE token_hash = ? AND expires_at > ?', [tokenHash(cookie), Date.now()]);
      if (session) req.user = cleanUser(session);
    }
    next();
  });

  const cookieOptions = { httpOnly: true, secure: secureCookie, sameSite: 'strict', path: '/', maxAge: SESSION_DAYS * 86400000 };
  const startSession = async (res, owner) => {
    await dbRun(db, 'DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
    const token = randomBytes(32).toString('hex');
    await dbRun(db, 'INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)', [tokenHash(token), owner.id, Date.now() + SESSION_DAYS * 86400000]);
    res.cookie(cookieName, token, cookieOptions);
  };
  const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please sign in to continue.' });
  const attempts = new Map();
  const limitAuth = async (req, res, next) => {
    const now = Date.now();
    if (attempts.size > 5000) for (const [key, entry] of attempts) if (entry.reset <= now) attempts.delete(key);
    const key = createHmac('sha256', analyticsSecret).update(req.ip || 'unknown').digest('hex');
    let entry = attempts.get(key);
    if (!entry || entry.reset <= now) entry = { count: 0, reset: now + 15 * 60 * 1000 };
    entry.count++;
    attempts.set(key, entry);
    if (db.driver === 'postgres') {
      await dbRun(db, 'DELETE FROM auth_attempts WHERE reset <= ?', [now]);
      entry = await dbGet(db, `INSERT INTO auth_attempts(key,count,reset) VALUES (?,1,?)
        ON CONFLICT(key) DO UPDATE SET count=auth_attempts.count+1 RETURNING count,reset`, [key, now + 15 * 60 * 1000]);
    }
    if (entry.count > 12) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many sign-in attempts. Please try again in 15 minutes.' });
    }
    next();
  };
  const config = () => ({ publicBaseUrl, environment, version: '1.0.0', database: db.driver === 'postgres' ? 'PostgreSQL' : 'SQLite', blobUploads: db.driver === 'postgres', setupTokenRequired: Boolean(setupToken), localOnly: ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname), lanAddressStale: isLanAddressStale(publicBaseUrl, Object.values(networkInterfaces()).flat().filter(Boolean).map(item => item.address)) });

  app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));
  app.get('/api/auth/session', async (req, res) => {
    const owner = await dbGet(db, 'SELECT id FROM owner WHERE id = 1');
    res.json({ authenticated: Boolean(req.user), setupRequired: !owner, user: req.user || null, config: config() });
  });
  app.post('/api/auth/setup', limitAuth, async (req, res) => {
    if (await dbGet(db, 'SELECT id FROM owner WHERE id = 1')) throw new ValidationError('An owner account already exists. Please sign in.', 409);
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
      await dbRun(db, 'INSERT INTO owner (id, name, email, password_hash, created_at) VALUES (1, ?, ?, ?, ?)', [name, email, passwordHash, new Date().toISOString()]);
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
    const owner = await dbGet(db, 'SELECT * FROM owner WHERE id = 1');
    const stored = owner?.password_hash || 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64);
    const valid = await verifyPassword(password, stored);
    if (!owner || !constantEquals(email, owner.email) || !valid) throw new ValidationError('Email or password is incorrect.', 401);
    await startSession(res, owner);
    const attemptKey = createHmac('sha256', analyticsSecret).update(req.ip || 'unknown').digest('hex');
    attempts.delete(attemptKey);
    if (db.driver === 'postgres') await dbRun(db, 'DELETE FROM auth_attempts WHERE key=?', [attemptKey]);
    res.json({ user: cleanUser(owner) });
  });
  app.post('/api/auth/logout', async (req, res) => {
    const token = parseCookie(req.get('cookie'))[cookieName];
    if (token) await dbRun(db, 'DELETE FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
    res.clearCookie(cookieName, { httpOnly: true, secure: secureCookie, sameSite: 'strict', path: '/' });
    res.json({ ok: true });
  });

  app.use('/api', requireAuth);
  const servePublicAsset = registerAssets(app, db, options.blobStore);
  const getRow = async (id) => {
    const row = await dbGet(db, 'SELECT q.*, (SELECT COUNT(*) FROM scans WHERE qr_id=q.id) AS scan_count FROM qr_codes q WHERE q.id = ?', [id]);
    if (!row) throw new ValidationError('QR code not found.', 404);
    return row;
  };
  const mapQR = async (row) => ({
    id: row.id, name: row.name, type: row.type, contentType: row.category || row.content_type,
    payload: JSON.parse(row.payload_json || '{}'), assetId: row.asset_id || null,
    asset: row.asset_id ? mapAsset(await dbGet(db, 'SELECT id,kind,name,mime,size,created_at FROM assets WHERE id=?', [row.asset_id])) : null,
    destination: row.destination, slug: row.slug, fgColor: row.fg_color, bgColor: row.bg_color,
    logoDataUrl: row.logo_data_url, folderId: row.folder_id, active: Boolean(row.active),
    createdAt: row.created_at, updatedAt: row.updated_at, scanCount: Number(row.scan_count || 0),
    encodedValue: row.encoded_value,
    shortUrl: row.type === 'dynamic' ? row.encoded_value : null,
  });
  const validFolderId = async (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !await dbGet(db, 'SELECT id FROM folders WHERE id = ?', [value])) throw new ValidationError('Choose an existing folder.');
    return value;
  };
  const prepareQR = async (body, current = null, preview = false) => {
    const input = body || {};
    const contentType = input.contentType ?? current?.contentType ?? 'url';
    const meta = getContentType(contentType);
    if (!meta) throw new ValidationError('Choose a supported QR content type.');
    const type = input.type ?? current?.type ?? meta.mode ?? 'dynamic';
    if (!['static', 'dynamic'].includes(type)) throw new ValidationError('Choose a valid QR type.');
    if (meta.mode && type !== meta.mode) throw new ValidationError(`${meta.name} codes use ${meta.mode} mode.`);
    if (current && (type !== current.type || contentType !== current.contentType)) throw new ValidationError('A saved code’s type cannot change. Create a new code instead.');
    const name = preview ? String(input.name || 'Preview') : textField(input.name ?? current?.name, 'Name');
    const resolved = await resolveContent(contentType, input, { publicBaseUrl, current, db });
    const { destination, storageType, payload, assetId } = resolved;
    if (storageType === 'url') {
      const destinationUrl = new URL(destination);
      if (/^\/r(?:\/|$)/i.test(destinationUrl.pathname)) {
        const savedOrigins = await dbAll(db, "SELECT DISTINCT encoded_value FROM qr_codes WHERE type='dynamic'");
        if (savedOrigins.some((row) => new URL(row.encoded_value).origin === destinationUrl.origin)) {
          throw new ValidationError('A QR destination cannot point to this app’s existing redirect origins.');
        }
      }
    }
    if (['app', 'smart'].includes(contentType)) {
      for (const target of [payload.fallbackUrl, payload.iosUrl, payload.androidUrl].filter(Boolean)) {
        const value = new URL(target);
        if (/^\/(?:r|files)(?:\/|$)/i.test(value.pathname)) {
          const ownOrigins = [publicUrl.origin, ...(await dbAll(db, "SELECT encoded_value FROM qr_codes WHERE type='dynamic'")).map(row => new URL(row.encoded_value).origin)];
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
      if (!preview && await dbGet(db, 'SELECT id FROM qr_codes WHERE slug = ? AND id != ?', [slug, current?.id || ''])) throw new ValidationError('This short-link slug is already in use.', 409);
    }
    const fgColor = validColor(input.fgColor ?? current?.fgColor, '#163A35');
    const bgColor = validColor(input.bgColor ?? current?.bgColor, '#FFFFFF');
    validateColors(fgColor, bgColor);
    const logoDataUrl = Object.hasOwn(input, 'logoDataUrl') ? await validLogo(input.logoDataUrl) : current?.logoDataUrl ?? null;
    const folderId = await validFolderId(input.folderId === undefined ? current?.folderId : input.folderId);
    const active = input.active ?? current?.active ?? true;
    if (typeof active !== 'boolean') throw new ValidationError('Active must be true or false.');
    if (type === 'static' && !active) throw new ValidationError('A static QR code points directly to its content and cannot be paused.');
    const qr = { name, type, contentType, storageType, payload, assetId, destination, slug, fgColor, bgColor, logoDataUrl, folderId, active, encodedValue: current?.encodedValue ?? (type === 'dynamic' ? `${publicBaseUrl}/r/${slug}` : destination) };
    await renderQR(qr);
    return qr;
  };
  app.get('/api/qrs', async (req, res) => {
    const qrs = await Promise.all((await dbAll(db, 'SELECT q.*, (SELECT COUNT(*) FROM scans WHERE qr_id=q.id) AS scan_count FROM qr_codes q ORDER BY created_at DESC')).map(mapQR));
    res.json({ qrs });
  });
  app.post('/api/qrs', async (req, res) => {
    const qr = await prepareQR(req.body);
    const id = randomUUID(), now = new Date().toISOString();
    try {
      await dbRun(db, 'INSERT INTO qr_codes (id,name,type,content_type,category,payload_json,asset_id,destination,encoded_value,slug,fg_color,bg_color,logo_data_url,folder_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, qr.name, qr.type, qr.storageType, qr.contentType, JSON.stringify(qr.payload), qr.assetId, qr.destination, qr.encodedValue, qr.slug, qr.fgColor, qr.bgColor, qr.logoDataUrl, qr.folderId, Number(qr.active), now, now]);
    } catch (error) {
      if (error.code === '23505' || String(error.message).includes('UNIQUE')) throw new ValidationError('This short-link slug is already in use.', 409);
      throw error;
    }
    res.status(201).json({ qr: await mapQR(await getRow(id)) });
  });
  app.patch('/api/qrs/:id', async (req, res) => {
    const current = await mapQR(await getRow(req.params.id));
    const qr = await prepareQR(req.body, current);
    await dbRun(db, 'UPDATE qr_codes SET name=?,destination=?,payload_json=?,asset_id=?,fg_color=?,bg_color=?,logo_data_url=?,folder_id=?,active=?,updated_at=? WHERE id=?', [qr.name, qr.destination, JSON.stringify(qr.payload), qr.assetId, qr.fgColor, qr.bgColor, qr.logoDataUrl, qr.folderId, Number(qr.active), new Date().toISOString(), current.id]);
    res.json({ qr: await mapQR(await getRow(current.id)) });
  });
  app.delete('/api/qrs/:id', async (req, res) => {
    await getRow(req.params.id);
    await dbRun(db, 'DELETE FROM qr_codes WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });
  app.post('/api/preview', async (req, res) => {
    if (req.body?.id !== undefined && typeof req.body.id !== 'string') throw new ValidationError('Choose a valid saved QR code for the preview.');
    const current = req.body?.id ? await mapQR(await getRow(req.body.id)) : null;
    const qr = await prepareQR(req.body, current, true);
    res.json({ svg: await renderQR(qr), encodedValue: qr.encodedValue });
  });
  app.get('/api/qrs/:id/download', async (req, res) => {
    const format = req.query.format || 'svg';
    if (!['svg', 'png'].includes(format)) throw new ValidationError('Download format must be svg or png.');
    const qr = await mapQR(await getRow(req.params.id));
    const filename = qr.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'qori-code';
    res.type(format === 'svg' ? 'image/svg+xml' : 'image/png');
    res.attachment(`${filename}.${format}`);
    res.send(await renderQR(qr, format));
  });

  const folderRows = () => dbAll(db, 'SELECT f.*, (SELECT COUNT(*) FROM qr_codes WHERE folder_id = f.id) AS qr_count FROM folders f ORDER BY lower(name)');
  const mapFolder = (row) => ({ id: row.id, name: row.name, color: row.color, qrCount: Number(row.qr_count || 0) });
  app.get('/api/folders', async (req, res) => res.json({ folders: (await folderRows()).map(mapFolder) }));
  app.post('/api/folders', async (req, res) => {
    const name = textField(req.body?.name, 'Folder name', 60), color = validColor(req.body?.color, '#638A78');
    const id = randomUUID();
    try { await dbRun(db, 'INSERT INTO folders (id,name,color,created_at) VALUES (?,?,?,?)', [id, name, color, new Date().toISOString()]); }
    catch (error) { if (error.code === '23505' || String(error.message).includes('UNIQUE')) throw new ValidationError('A folder with this name already exists.', 409); throw error; }
    res.status(201).json({ folder: mapFolder((await folderRows()).find((row) => row.id === id)) });
  });
  app.patch('/api/folders/:id', async (req, res) => {
    const current = await dbGet(db, 'SELECT * FROM folders WHERE id = ?', [req.params.id]);
    if (!current) throw new ValidationError('Folder not found.', 404);
    const name = textField(req.body?.name ?? current.name, 'Folder name', 60), color = validColor(req.body?.color, current.color);
    try { await dbRun(db, 'UPDATE folders SET name=?,color=? WHERE id=?', [name, color, current.id]); }
    catch (error) { if (error.code === '23505' || String(error.message).includes('UNIQUE')) throw new ValidationError('A folder with this name already exists.', 409); throw error; }
    res.json({ folder: mapFolder((await folderRows()).find((row) => row.id === current.id)) });
  });
  app.delete('/api/folders/:id', async (req, res) => {
    const current = await dbGet(db, 'SELECT id FROM folders WHERE id = ?', [req.params.id]);
    if (!current) throw new ValidationError('Folder not found.', 404);
    await dbRun(db, 'DELETE FROM folders WHERE id = ?', [current.id]);
    res.json({ ok: true });
  });

  app.get('/api/analytics', async (req, res) => {
    const days = Number(req.query.days || 30);
    if (![7, 30, 90].includes(days)) throw new ValidationError('Choose a 7, 30, or 90 day analytics window.');
    const qrId = req.query.qrId;
    if (qrId && typeof qrId !== 'string') throw new ValidationError('Choose a valid QR code.');
    if (qrId) await getRow(qrId);
    const today = new Date();
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - days + 1));
    const startIso = start.toISOString();
    const scope = qrId ? ' AND s.qr_id = ?' : '';
    const args = qrId ? [startIso, qrId] : [startIso];
    const totals = await dbGet(db, `SELECT COUNT(*) AS total, COUNT(DISTINCT visitor_hash) AS unique_visitors FROM scans s WHERE s.scanned_at >= ?${scope}`, args);
    const daily = await dbAll(db, `SELECT substr(s.scanned_at,1,10) AS date, COUNT(*) AS scans FROM scans s WHERE s.scanned_at >= ?${scope} GROUP BY date`, args);
    const dailyMap = new Map(daily.map((row) => [row.date, Number(row.scans)]));
    const series = Array.from({ length: days }, (_, i) => {
      const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
      return { date, scans: dailyMap.get(date) || 0 };
    });
    const grouped = async (column) => (await dbAll(db, `SELECT ${column} AS name, COUNT(*) AS count FROM scans s WHERE s.scanned_at >= ?${scope} GROUP BY ${column} ORDER BY count DESC, name ASC`, args)).map((row) => ({ name: row.name, count: Number(row.count) }));
    const recent = await dbAll(db, `SELECT s.id,q.name AS "qrName",s.scanned_at AS "scannedAt",s.device,s.referrer FROM scans s JOIN qr_codes q ON q.id=s.qr_id WHERE s.scanned_at >= ?${scope} ORDER BY s.scanned_at DESC LIMIT 20`, args);
    const topCodes = (await dbAll(db, `SELECT q.id,q.name,COUNT(s.id) AS scans FROM scans s JOIN qr_codes q ON q.id=s.qr_id WHERE s.scanned_at >= ?${scope} GROUP BY q.id ORDER BY scans DESC, q.name LIMIT 5`, args)).map((row) => ({ ...row, scans: Number(row.scans) }));
    const counts = await dbAll(db, `SELECT type,COUNT(*) AS count FROM qr_codes${qrId ? ' WHERE id=?' : ''} GROUP BY type`, qrId ? [qrId] : []);
    res.json({ totalScans: Number(totals.total), uniqueVisitors: Number(totals.unique_visitors), dynamicCount: Number(counts.find((row) => row.type === 'dynamic')?.count || 0), staticCount: Number(counts.find((row) => row.type === 'static')?.count || 0), series, devices: await grouped('s.device'), referrers: await grouped('s.referrer'), recent, topCodes, timezone: 'UTC', visitorMetric: 'Approximate daily unique visitors; repeat visitors on different days count again.' });
  });
  app.get('/api/settings', (req, res) => res.json({ ...config(), sessionDays: SESSION_DAYS, analyticsTimezone: 'UTC' }));
  app.get('/api/export', async (req, res) => {
    const qrs = await Promise.all((await dbAll(db, 'SELECT q.*, (SELECT COUNT(*) FROM scans WHERE qr_id=q.id) AS scan_count FROM qr_codes q ORDER BY created_at')).map(mapQR));
    res.attachment(`qori-library-${new Date().toISOString().slice(0, 10)}.json`);
    res.json({ version: '1.0.0', exportedAt: new Date().toISOString(), publicBaseUrl, folders: (await folderRows()).map(mapFolder), qrs, note: db.driver === 'postgres' ? 'Library export only. Use your database provider backup for scan history and account data.' : 'Library export only. Copy the stopped SQLite database for a full backup including scan history and your account.' });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

  app.get('/r/:slug', async (req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const row = await dbGet(db, "SELECT id,destination,active,category,payload_json FROM qr_codes WHERE slug = ? AND type = 'dynamic'", [req.params.slug]);
    if (!row) return res.status(404).type('text/plain').send('This QR code was not found.');
    if (!row.active) return res.status(410).type('text/plain').send('This QR code is paused. Please contact its owner.');
    if (req.method === 'GET') {
      const now = new Date().toISOString(), ua = String(req.get('user-agent') || '').slice(0, 1000);
      const visitorHash = createHmac('sha256', analyticsSecret).update(`${now.slice(0, 10)}|${req.ip || ''}|${ua}`).digest('hex');
      const device = /bot|crawl|spider|slurp|preview/i.test(ua) ? 'Bot / preview' : /ipad|tablet/i.test(ua) ? 'Tablet' : /mobile|iphone|android/i.test(ua) ? 'Mobile' : ua ? 'Desktop' : 'Unknown';
      let referrer = 'Direct';
      try { const url = new URL(req.get('referer')); if (['http:', 'https:'].includes(url.protocol)) referrer = url.hostname.slice(0, 253); } catch { /* No usable referrer. */ }
      await dbRun(db, 'INSERT INTO scans (id,qr_id,scanned_at,visitor_hash,device,referrer) VALUES (?,?,?,?,?,?)', [randomUUID(), row.id, now, visitorHash, device, referrer]);
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
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  app.locals.db = db;
  app.locals.close = () => db.close();
  app.locals.config = config();
  return app;
}
