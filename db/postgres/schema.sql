-- PostgreSQL schema for a future Qori SaaS runtime.
-- Phase 2 migration target; the Express application still uses SQLite until the
-- database adapter and production cutover are explicitly completed.
CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  email TEXT NOT NULL, password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_lower_unique ON accounts (lower(email));
CREATE TABLE IF NOT EXISTS password_resets (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_verifications (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  PRIMARY KEY(workspace_id, account_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, color TEXT NOT NULL,
  created_at TEXT NOT NULL,
  owner_key TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS folders_workspace_name_unique ON folders(owner_key, lower(name));
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  name TEXT NOT NULL, mime TEXT NOT NULL,
  size BIGINT NOT NULL CHECK (size >= 0),
  bytes BYTEA NOT NULL,
  created_at TEXT NOT NULL,
  owner_key TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS qr_codes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('static','dynamic')),
  content_type TEXT NOT NULL CHECK (content_type IN ('url','text')),
  destination TEXT NOT NULL,
  encoded_value TEXT,
  slug TEXT UNIQUE,
  fg_color TEXT NOT NULL, bg_color TEXT NOT NULL,
  logo_data_url TEXT,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  category TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  owner_key TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  CHECK ((type='dynamic' AND slug IS NOT NULL AND content_type='url') OR
         (type='static' AND slug IS NULL))
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
CREATE INDEX IF NOT EXISTS qr_codes_owner_key ON qr_codes(owner_key);
CREATE INDEX IF NOT EXISTS assets_owner_key ON assets(owner_key);
CREATE INDEX IF NOT EXISTS folders_owner_key ON folders(owner_key);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);
