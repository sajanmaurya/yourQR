import test from 'node:test';
import assert from 'node:assert/strict';
import { openNeonHttpDatabase } from './neon-http.js';

function mockSql() {
  const statements = [], transactions = [];
  const sql = {
    query(source, params = []) {
      const item = { source, params };
      return Object.assign(Promise.resolve({ rows: /to_regclass/i.test(source) ? [{ table_name: 'qr_codes' }] : [{ ok: true }], rowCount: 1 }), { item });
    },
    async transaction(queries) { transactions.push(queries.map(q => q.item)); return queries.map(() => ({ rows: [], rowCount: 1 })); },
  };
  const orig = sql.query.bind(sql);
  sql.query = (...args) => { const q = orig(...args); statements.push(q.item); return q; };
  return { sql, statements, transactions };
}

test('Neon HTTPS adapter loads schema status and seeds using parameterized queries', async () => {
  const mock = mockSql();
  const db = openNeonHttpDatabase('postgresql://invalid.example/test', { sql: mock.sql });
  await db.ready;
  assert.equal(db.dialect, 'postgres');
  assert.ok(mock.statements.some(x => x.source.includes('to_regclass')));
  assert.ok(mock.statements.some(x => x.source.includes('INSERT INTO workspaces')));
  assert.ok(mock.statements.some(x => x.source.includes('INSERT INTO settings')));
  assert.deepEqual(await db.prepare('SELECT ? AS ok').get(12), { ok: true });
  assert.ok(mock.statements.some(x => x.source === 'SELECT $1 AS ok' && x.params[0] === 12));
});

test('Neon HTTPS transactions batch writes and never issue partial statements', async () => {
  const mock = mockSql();
  const db = openNeonHttpDatabase('postgresql://invalid.example/test', { sql: mock.sql });
  await db.ready;
  await db.transaction(async tx => {
    await tx.prepare('INSERT INTO accounts(id,name) VALUES(?,?)').run('a', 'Alice');
    await tx.prepare('DELETE FROM password_resets WHERE account_id=?').run('a');
  });
  assert.equal(mock.transactions.length, 1);
  assert.equal(mock.transactions[0].length, 2);
  assert.equal(mock.transactions[0][0].source, 'INSERT INTO accounts(id,name) VALUES($1,$2)');
  await assert.rejects(db.transaction(tx => tx.prepare('SELECT 1').get()), /Interactive transaction reads/);
});
