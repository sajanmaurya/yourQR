import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

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
      bytes BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  // Upgrade earlier local MVP databases without replacing their contents.
  if (!db.prepare('PRAGMA table_info(qr_codes)').all().some((column) => column.name === 'encoded_value')) {
    db.exec('ALTER TABLE qr_codes ADD COLUMN encoded_value TEXT');
  }
  const columns = new Set(db.prepare('PRAGMA table_info(qr_codes)').all().map(column => column.name));
  if (!columns.has('category')) db.exec('ALTER TABLE qr_codes ADD COLUMN category TEXT');
  if (!columns.has('payload_json')) db.exec("ALTER TABLE qr_codes ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'");
  if (!columns.has('asset_id')) db.exec('ALTER TABLE qr_codes ADD COLUMN asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .run('analytics_secret', randomBytes(32).toString('hex'));
  return db;
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
