import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/database.js';
import { addressScope } from '../shared/network.js';

// Run with the app stopped. Rewrites loopback and this app's previous LAN origin only.
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const address = process.argv[2];
const localAddresses = Object.values(networkInterfaces()).flat().filter(Boolean).filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address);
if (isIP(address || '') !== 4 || !localAddresses.includes(address) || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) {
  console.error('Supply this computer’s private Wi-Fi IPv4 address, for example: npm run share:wifi -- 192.168.1.20');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Wi-Fi setup is for a local development instance. Keep production on its permanent HTTPS hostname.');
  process.exit(1);
}
const port = Number(process.env.PORT || 8787);
const baseUrl = `http://${address}:${port}`;
const previousBase = process.env.PUBLIC_BASE_URL;
const envPath = path.join(appRoot, '.env');
let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(path.join(appRoot, '.env.example'), 'utf8');
const db = openDatabase(path.resolve(appRoot, process.env.DB_PATH || 'data/qori.sqlite'));
try {
  const backupDirectory = path.join(appRoot, 'data', 'backups');
  mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `before-wifi-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`);
  db.prepare('VACUUM INTO ?').run(backupPath);
  const records = db.prepare("SELECT id,slug,encoded_value,destination,asset_id FROM qr_codes WHERE type='dynamic'").all();
  let changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of records) {
      const origin = new URL(row.encoded_value);
      const previousLan = previousBase && addressScope(previousBase) === 'lan' && origin.origin === new URL(previousBase).origin;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && !previousLan) continue;
      if (origin.origin === baseUrl) continue;
      const destination = row.asset_id ? `${baseUrl}/files/${row.asset_id}` : row.destination;
      db.prepare('UPDATE qr_codes SET encoded_value=?,destination=?,updated_at=? WHERE id=?').run(`${baseUrl}/r/${row.slug}`, destination, new Date().toISOString(), row.id);
      changed++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  for (const [key, value] of Object.entries({ HOST: '0.0.0.0', PUBLIC_BASE_URL: baseUrl, COOKIE_SECURE: 'false' })) {
    const expression = new RegExp(`^${key}=.*$`, 'm');
    env = expression.test(env) ? env.replace(expression, `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
  }
  writeFileSync(envPath, env, 'utf8');
  console.log(`Wi-Fi sharing address: ${baseUrl}`);
  console.log(`Updated ${changed} local QR address(es). Download those QR images again before scanning.`);
  console.log('Existing owner, files, folders, slugs, and analytics were preserved. A full database backup was saved in data/backups/.');
  console.log('Start Qori again and keep the computer awake. Phone and computer must use the same Wi-Fi/hotspot.');
} finally { db.close(); }
