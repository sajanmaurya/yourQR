import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, hashPassword } from './database.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const email = String(process.env.RESET_EMAIL || '').trim().toLowerCase();
const password = process.env.RESET_PASSWORD || '';
if (!email || password.length < 12 || password.length > 256) {
  console.error('Stop Qori first. Set RESET_EMAIL to the account email and RESET_PASSWORD to a new 12–256 character password, then run this command again.');
  process.exit(1);
}
const db = openDatabase(path.resolve(appRoot, process.env.DB_PATH || 'data/qori.sqlite'));
try {
  const owner = db.prepare('SELECT id,email FROM users WHERE lower(email)=?').get(email);
  if (!owner) throw new Error('No account with that email was found. No account was changed.');
  const passwordHash = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, owner.id);
    db.prepare('DELETE FROM user_sessions WHERE user_id=?').run(owner.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log('Account password changed. All sessions were signed out. Clear RESET_PASSWORD from your environment before restarting Qori.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { db.close(); }
