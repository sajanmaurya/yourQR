import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, hashPassword } from './database.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const email = String(process.env.RESET_EMAIL || '').trim().toLowerCase();
const password = process.env.RESET_PASSWORD || '';
if (!email || password.length < 12 || password.length > 256) {
  console.error('Stop yourQR first. Set RESET_EMAIL to the owner email and RESET_PASSWORD to a new 12–256 character password, then run this command again.');
  process.exit(1);
}
const db = openDatabase(path.resolve(appRoot, process.env.DB_PATH || 'data/qori.sqlite'));
try {
  const owner = db.prepare('SELECT id,email FROM owner WHERE id=1').get();
  if (!owner || owner.email !== email) throw new Error('No owner with that email was found. No account was changed.');
  const passwordHash = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE owner SET password_hash=? WHERE id=1').run(passwordHash);
    db.exec('DELETE FROM sessions');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log('Owner password changed. All sessions were signed out. Clear RESET_PASSWORD from your environment before restarting yourQR.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { db.close(); }
