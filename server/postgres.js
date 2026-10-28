import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { randomBytes } from 'node:crypto';

const { Pool } = pg;

// Translate SQLite's positional ? placeholders while respecting SQL strings.
// Application SQL always sends user input as bound parameters, never interpolation.
export function postgresSQL(sql) {
  let out = '', n = 0, quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (quote) {
      out += ch;
      if (ch === quote && next === quote) { out += next; i++; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; }
    else if (ch === '?') out += '$' + (++n);
    else out += ch;
  }
  return out.replace(/\bORDER BY name COLLATE NOCASE\b/gi, 'ORDER BY lower(name)')
    .replace(/\bORDER BY f\.name COLLATE NOCASE\b/gi, 'ORDER BY lower(f.name)')
    .replace(/\bINSERT OR IGNORE INTO settings\b/gi, 'INSERT INTO settings');
}

function statement(executor, source) {
  // Certain migrations and utility code use INSERT OR IGNORE and sqlite-only SQL.
  const ignore = /\bINSERT OR IGNORE INTO settings\b/i.test(source);
  let sql = postgresSQL(source);
  if (ignore) sql += ' ON CONFLICT DO NOTHING';
  const query = (...args) => executor(sql, args);
  return {
    async get(...args) { const { rows } = await query(...args); return rows[0]; },
    async all(...args) { const { rows } = await query(...args); return rows; },
    async run(...args) { const result = await query(...args); return { changes: result.rowCount }; },
  };
}

function interfaceFor(executor, transaction, close) {
  return {
    dialect: 'postgres',
    prepare(sql) { return statement(executor, sql); },
    exec(sql) { return executor(sql, []); },
    transaction,
    close,
  };
}

export function openPostgresDatabase(connectionString, options = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required to use PostgreSQL.');
  const pool = new Pool({
    connectionString, max: options.maxConnections ?? 10,
    // Neon compute can be cold on the first invocation. Serverless regions are pinned near Neon.
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? (process.env.VERCEL === '1' ? 25000 : 10000),
    idleTimeoutMillis: 30000,
  });
  const executor = (sql, values) => pool.query(sql, values);
  const transaction = async fn => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = interfaceFor((sql, args) => client.query(sql, args), null, null);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };
  const db = interfaceFor(executor, transaction, () => pool.end());
  db.ready = (async () => {
    const url = new URL('./../db/postgres/schema.sql', import.meta.url);
    // Skip repeated DDL on every Vercel cold start once the schema exists.
    // A new/empty database is still initialized transactionally.
    await transaction(async tx => {
      const existing = await tx.prepare("SELECT to_regclass('public.qr_codes') AS table_name").get();
      if (!existing.table_name) {
        const schema = await readFile(fileURLToPath(url), 'utf8');
        await tx.exec(schema);
      }
      await tx.prepare('INSERT INTO workspaces(id,name,owner_account_id,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .run('legacy', 'Personal legacy workspace', null, new Date().toISOString());
      await tx.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING')
        .run('analytics_secret', randomBytes(32).toString('hex'));
    });
  })();
  // Register an immediate rejection handler, even when a serverless function
  // imports the module before the first request. Consumers still await db.ready.
  db.ready.catch(() => {});
  return db;
}
