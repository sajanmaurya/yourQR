import { neon } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';
import { postgresSQL } from './postgres.js';
import { randomBytes } from 'node:crypto';

// Native Postgres TCP connections can stall during Vercel Function cold starts.
// Neon's HTTP protocol uses standard HTTPS and supports atomic, non-interactive
// transactions while retaining the same prepare/get/all/run API as our adapter.
export function openNeonHttpDatabase(connectionString, options = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required for Neon.');
  const sql = options.sql || neon(connectionString, { fullResults: true });
  const execute = (source, args) => sql.query(postgresSQL(source), args, { fullResults: true });
  const statement = (source) => ({
    async get(...args) { const result = await execute(source, args); return result.rows?.[0]; },
    async all(...args) { const result = await execute(source, args); return result.rows || []; },
    async run(...args) { const result = await execute(source, args); return { changes: result.rowCount ?? 0 }; },
  });
  const transaction = async (fn) => {
    const queries = [];
    const tx = {
      dialect: 'postgres',
      prepare(source) {
        return {
          async run(...args) {
            // All application transactions consist of INSERT/UPDATE/DELETE
            // statements; reads inside these callbacks are explicitly rejected.
            if (!/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(source)) throw new Error('Neon HTTP transactions only support queued writes.');
            queries.push(sql.query(postgresSQL(source), args, { fullResults: true }));
            return { changes: 0 };
          },
          async get() { throw new Error('Interactive transaction reads require a dedicated Postgres connection.'); },
          async all() { throw new Error('Interactive transaction reads require a dedicated Postgres connection.'); },
        };
      },
      async exec() { throw new Error('Neon HTTP transaction exec must be handled via explicit schema migration.'); },
    };
    const output = await fn(tx);
    if (queries.length) await sql.transaction(queries, { fullResults: true });
    return output;
  };
  const db = {
    dialect: 'postgres',
    prepare: statement,
    exec: async (source) => { throw new Error('Use an explicit, audited SQL migration instead of arbitrary db.exec: ' + source.length); },
    transaction,
    close: async () => {},
  };
  db.ready = (async () => {
    const existing = await statement("SELECT to_regclass('public.qr_codes') AS table_name").get();
    if (!existing?.table_name) {
      // Neon HTTP handles a batch of statements atomically without TCP or WS.
      const schema = await readFile(new URL('../db/postgres/schema.sql', import.meta.url), 'utf8');
      const ddl = schema.split(';').map(part => part.trim()).filter(Boolean);
      await sql.transaction(ddl.map(source => sql.query(source, [], { fullResults: true })), { fullResults: true });
    }
    await statement('INSERT INTO workspaces(id,name,owner_account_id,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run('legacy', 'Personal legacy workspace', null, new Date().toISOString());
    await statement('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING')
      .run('analytics_secret', randomBytes(32).toString('hex'));
  })();
  db.ready.catch(() => {}); // Leave rejection for request middleware while preventing crash.
  return db;
}
