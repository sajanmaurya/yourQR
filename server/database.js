import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { neon } from '@neondatabase/serverless';

const scrypt = promisify(scryptCallback);

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS owner (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qr_codes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('static','dynamic')),
      content_type TEXT NOT NULL CHECK (content_type IN ('url','text')),
      destination TEXT NOT NULL,
      encoded_value TEXT,
      slug TEXT UNIQUE,
      fg_color TEXT NOT NULL,
      bg_color TEXT NOT NULL,
      logo_data_url TEXT,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((type = 'dynamic' AND slug IS NOT NULL AND content_type = 'url') OR (type = 'static' AND slug IS NULL))
    );
    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      qr_id TEXT NOT NULL REFERENCES qr_codes(id) ON DELETE CASCADE,
      scanned_at TEXT NOT NULL,
      visitor_hash TEXT NOT NULL,
      device TEXT NOT NULL,
      referrer TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scans_qr_time ON scans(qr_id, scanned_at);
    CREATE INDEX IF NOT EXISTS scans_time ON scans(scanned_at);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      bytes BLOB,
      blob_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS user_folders (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,name));
    CREATE TABLE IF NOT EXISTS user_assets (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB, blob_path TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_qr_codes (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('static','dynamic')), content_type TEXT NOT NULL CHECK(content_type IN ('url','text')), destination TEXT NOT NULL, encoded_value TEXT, slug TEXT UNIQUE, fg_color TEXT NOT NULL, bg_color TEXT NOT NULL, logo_data_url TEXT, folder_id TEXT REFERENCES user_folders(id) ON DELETE SET NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, category TEXT, payload_json TEXT NOT NULL DEFAULT '{}', asset_id TEXT REFERENCES user_assets(id) ON DELETE RESTRICT, CHECK((type='dynamic' AND slug IS NOT NULL AND content_type='url') OR (type='static' AND slug IS NULL)));
    CREATE TABLE IF NOT EXISTS user_scans (id TEXT PRIMARY KEY, qr_id TEXT NOT NULL REFERENCES user_qr_codes(id) ON DELETE CASCADE, scanned_at TEXT NOT NULL, visitor_hash TEXT NOT NULL, device TEXT NOT NULL, referrer TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_upload_intents (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, pathname TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, name TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL, status TEXT NOT NULL, payment_url TEXT NOT NULL,
      current_end INTEGER, cancel_scheduled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS billing_subscriptions_by_user ON billing_subscriptions(user_id,created_at);
    CREATE TABLE IF NOT EXISTS billing_webhook_events (
      id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES billing_subscriptions(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL, processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_checkout_locks (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, locked_until INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_sessions_expiry ON user_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS user_scans_qr_time ON user_scans(qr_id,scanned_at);
  `);
  // Upgrade earlier local MVP databases without replacing their contents.
  if (!db.prepare('PRAGMA table_info(qr_codes)').all().some((column) => column.name === 'encoded_value')) {
    db.exec('ALTER TABLE qr_codes ADD COLUMN encoded_value TEXT');
  }
  const columns = new Set(db.prepare('PRAGMA table_info(qr_codes)').all().map(column => column.name));
  if (!columns.has('category')) db.exec('ALTER TABLE qr_codes ADD COLUMN category TEXT');
  if (!columns.has('payload_json')) db.exec("ALTER TABLE qr_codes ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'");
  if (!columns.has('asset_id')) db.exec('ALTER TABLE qr_codes ADD COLUMN asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT');
  const assetColumns = new Set(db.prepare('PRAGMA table_info(assets)').all().map(column => column.name));
  if (!assetColumns.has('blob_path')) db.exec('ALTER TABLE assets ADD COLUMN blob_path TEXT');
  db.exec(`
    INSERT OR IGNORE INTO users(id,name,email,password_hash,created_at) SELECT id,name,email,password_hash,created_at FROM owner;
    INSERT OR IGNORE INTO user_folders(id,user_id,name,color,created_at) SELECT id,1,name,color,created_at FROM folders WHERE EXISTS(SELECT 1 FROM users WHERE id=1);
    INSERT OR IGNORE INTO user_assets(id,user_id,kind,name,mime,size,bytes,blob_path,created_at) SELECT id,1,kind,name,mime,size,bytes,blob_path,created_at FROM assets WHERE EXISTS(SELECT 1 FROM users WHERE id=1);
    INSERT OR IGNORE INTO user_qr_codes(id,user_id,name,type,content_type,destination,encoded_value,slug,fg_color,bg_color,logo_data_url,folder_id,active,created_at,updated_at,category,payload_json,asset_id) SELECT id,1,name,type,content_type,destination,encoded_value,slug,fg_color,bg_color,logo_data_url,folder_id,active,created_at,updated_at,category,payload_json,asset_id FROM qr_codes WHERE EXISTS(SELECT 1 FROM users WHERE id=1);
    INSERT OR IGNORE INTO user_scans(id,qr_id,scanned_at,visitor_hash,device,referrer) SELECT id,qr_id,scanned_at,visitor_hash,device,referrer FROM scans WHERE EXISTS(SELECT 1 FROM user_qr_codes WHERE user_qr_codes.id=scans.qr_id);
  `);
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .run('analytics_secret', randomBytes(32).toString('hex'));
  return db;
}

export const postgresSchema = `
  CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES owner(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS folders_name_nocase ON folders (lower(name));
  CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, bytes BYTEA, blob_path TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS qr_codes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('static','dynamic')),
    content_type TEXT NOT NULL CHECK (content_type IN ('url','text')), destination TEXT NOT NULL,
    encoded_value TEXT, slug TEXT UNIQUE, fg_color TEXT NOT NULL, bg_color TEXT NOT NULL,
    logo_data_url TEXT, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    category TEXT, payload_json TEXT NOT NULL DEFAULT '{}', asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
    CHECK ((type = 'dynamic' AND slug IS NOT NULL AND content_type = 'url') OR (type = 'static' AND slug IS NULL))
  );
  CREATE TABLE IF NOT EXISTS scans (id TEXT PRIMARY KEY, qr_id TEXT NOT NULL REFERENCES qr_codes(id) ON DELETE CASCADE, scanned_at TEXT NOT NULL, visitor_hash TEXT NOT NULL, device TEXT NOT NULL, referrer TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS upload_intents (id TEXT PRIMARY KEY, pathname TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, name TEXT NOT NULL, expires_at BIGINT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS assets_blob_path ON assets(blob_path);
  CREATE INDEX IF NOT EXISTS scans_qr_time ON scans(qr_id, scanned_at);
  CREATE INDEX IF NOT EXISTS scans_time ON scans(scanned_at);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_nocase ON users(lower(email));
  CREATE TABLE IF NOT EXISTS user_sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS user_folders (id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS user_folders_name_nocase ON user_folders(user_id,lower(name));
  CREATE TABLE IF NOT EXISTS user_assets (id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, bytes BYTEA, blob_path TEXT, created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS user_assets_blob_path ON user_assets(blob_path);
  CREATE TABLE IF NOT EXISTS user_qr_codes (id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('static','dynamic')), content_type TEXT NOT NULL CHECK(content_type IN ('url','text')), destination TEXT NOT NULL, encoded_value TEXT, slug TEXT UNIQUE, fg_color TEXT NOT NULL, bg_color TEXT NOT NULL, logo_data_url TEXT, folder_id TEXT REFERENCES user_folders(id) ON DELETE SET NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, category TEXT, payload_json TEXT NOT NULL DEFAULT '{}', asset_id TEXT REFERENCES user_assets(id) ON DELETE RESTRICT, CHECK((type='dynamic' AND slug IS NOT NULL AND content_type='url') OR (type='static' AND slug IS NULL)));
  CREATE TABLE IF NOT EXISTS user_scans (id TEXT PRIMARY KEY, qr_id TEXT NOT NULL REFERENCES user_qr_codes(id) ON DELETE CASCADE, scanned_at TEXT NOT NULL, visitor_hash TEXT NOT NULL, device TEXT NOT NULL, referrer TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS user_upload_intents (id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, pathname TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, name TEXT NOT NULL, expires_at BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL, status TEXT NOT NULL, payment_url TEXT NOT NULL,
    current_end BIGINT, cancel_scheduled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS billing_subscriptions_by_user ON billing_subscriptions(user_id,created_at);
  CREATE TABLE IF NOT EXISTS billing_webhook_events (
    id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES billing_subscriptions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL, processed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS billing_checkout_locks (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, locked_until BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS user_sessions_expiry ON user_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS user_scans_qr_time ON user_scans(qr_id,scanned_at);
`;

export function openPostgresDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required when running yourQR on Vercel.');
  // HTTP queries do not leave WebSocket connections alive between Function invocations.
  const sql = neon(connectionString, { fullResults: true });
  const pool = { query: (text, params = []) => sql.query(text, params) };
  const db = {
    driver: 'postgres',
    pool,
    ready: (async () => {
      // Serialize first-start DDL across simultaneous cold starts, in one transaction.
      await sql.transaction([
        sql.query('SELECT pg_advisory_xact_lock(71504821)'),
        ...postgresSchema.split(';').map(part => part.trim()).filter(Boolean).map(statement => sql.query(statement)),
        sql.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', ['analytics_secret', randomBytes(32).toString('hex')]),
        sql.query('INSERT INTO users(id,name,email,password_hash,created_at) SELECT id,name,email,password_hash,created_at FROM owner ON CONFLICT DO NOTHING'),
        sql.query('SELECT setval(pg_get_serial_sequence(\'users\',\'id\'), COALESCE((SELECT MAX(id) FROM users),1), EXISTS(SELECT 1 FROM users))'),
        sql.query('INSERT INTO user_folders(id,user_id,name,color,created_at) SELECT id,1,name,color,created_at FROM folders WHERE EXISTS(SELECT 1 FROM users WHERE id=1) ON CONFLICT DO NOTHING'),
        sql.query('INSERT INTO user_assets(id,user_id,kind,name,mime,size,bytes,blob_path,created_at) SELECT id,1,kind,name,mime,size,bytes,blob_path,created_at FROM assets WHERE EXISTS(SELECT 1 FROM users WHERE id=1) ON CONFLICT DO NOTHING'),
        sql.query("INSERT INTO user_qr_codes(id,user_id,name,type,content_type,destination,encoded_value,slug,fg_color,bg_color,logo_data_url,folder_id,active,created_at,updated_at,category,payload_json,asset_id) SELECT id,1,name,type,content_type,destination,encoded_value,slug,fg_color,bg_color,logo_data_url,folder_id,active,created_at,updated_at,category,payload_json,asset_id FROM qr_codes WHERE EXISTS(SELECT 1 FROM users WHERE id=1) ON CONFLICT DO NOTHING"),
        sql.query('INSERT INTO user_scans(id,qr_id,scanned_at,visitor_hash,device,referrer) SELECT s.id,s.qr_id,s.scanned_at,s.visitor_hash,s.device,s.referrer FROM scans s JOIN user_qr_codes q ON q.id=s.qr_id ON CONFLICT DO NOTHING'),
      ]);
    })(),
    close: async () => {},
  };
  return db;
}

function postgresQuery(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export async function dbGet(db, sql, params = []) {
  if (db.driver === 'postgres') return (await db.pool.query(postgresQuery(sql), params)).rows[0];
  return db.prepare(sql).get(...params);
}

export async function dbAll(db, sql, params = []) {
  if (db.driver === 'postgres') return (await db.pool.query(postgresQuery(sql), params)).rows;
  return db.prepare(sql).all(...params);
}

export async function dbRun(db, sql, params = []) {
  if (db.driver === 'postgres') {
    const normalized = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i, 'INSERT INTO ');
    const query = /\bON\s+CONFLICT\b/i.test(normalized) ? normalized : /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(sql) ? `${normalized} ON CONFLICT DO NOTHING` : normalized;
    return db.pool.query(postgresQuery(query), params);
  }
  return db.prepare(sql).run(...params);
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algorithm, salt, hex] = String(stored).split(':');
  if (algorithm !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
