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
  // SaaS migration: preserve the original single-owner workspace as "legacy".
  for (const table of ['qr_codes', 'folders', 'assets']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'owner_key')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN owner_key TEXT NOT NULL DEFAULT 'legacy'`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_verifications (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS qr_codes_owner_key ON qr_codes(owner_key);
    CREATE INDEX IF NOT EXISTS assets_owner_key ON assets(owner_key);
  `);
  // Previous versions had a global UNIQUE folder-name constraint. Replace it
  // with a per-workspace index without deleting anyone's folders or codes.
  const folderDDL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='folders'").get()?.sql || '';
  if (/name\s+TEXT\s+NOT\s+NULL\s+COLLATE\s+NOCASE\s+UNIQUE/i.test(folderDDL)) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE folders_tenant_migration (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL COLLATE NOCASE,
          color TEXT NOT NULL,
          created_at TEXT NOT NULL,
          owner_key TEXT NOT NULL DEFAULT 'legacy'
        );
        INSERT INTO folders_tenant_migration(id,name,color,created_at,owner_key)
          SELECT id,name,color,created_at,owner_key FROM folders;
        DROP TABLE folders;
        ALTER TABLE folders_tenant_migration RENAME TO folders;
        COMMIT;
      `);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  if (!db.prepare('PRAGMA table_info(accounts)').all().some(c => c.name === 'verified_at')) {
    db.exec('ALTER TABLE accounts ADD COLUMN verified_at TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS folders_owner_name ON folders(owner_key, name COLLATE NOCASE)');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key migration verification failed');
  db.dialect = 'sqlite';
  db.ready = Promise.resolve();
  db.transaction = async fn => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
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
