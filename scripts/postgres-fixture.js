import { mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { openDatabase, hashPassword } from '../server/database.js';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: node scripts/postgres-fixture.js <new-output-file.sqlite>');
mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
const db = openDatabase(path.resolve(filename));
const now = new Date().toISOString();
const password = await hashPassword('not-a-production-password-12345');
try {
  db.prepare('INSERT INTO owner(id,name,email,password_hash,created_at) VALUES(1,?,?,?,?)').run('Legacy','legacy@example.com',password,now);
  db.prepare('INSERT INTO accounts(id,name,email,password_hash,created_at,verified_at) VALUES(?,?,?,?,?,?)')
    .run('account-a','Alice','alice@example.com',password,now,now);
  db.prepare('INSERT INTO accounts(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)')
    .run('account-b','Bob','bob@example.com',password,now);
  db.prepare('INSERT INTO folders(id,name,color,created_at,owner_key) VALUES(?,?,?,?,?)')
    .run('folder-1','Menus','#FFFFFF',now,'account-a');
  db.prepare('INSERT INTO assets(id,kind,name,mime,size,bytes,created_at,owner_key) VALUES(?,?,?,?,?,?,?,?)')
    .run('asset-1','pdf','Menu "small".pdf','application/pdf',8,Buffer.from([0,1,2,3,4,5,255,10]),now,'account-a');
  db.prepare('INSERT INTO qr_codes(id,name,type,content_type,destination,encoded_value,slug,fg_color,bg_color,folder_id,active,created_at,updated_at,category,payload_json,asset_id,owner_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('qr-1','Menu','dynamic','url','https://example.org/menu','https://qori.example/r/menu','menu','#000000','#FFFFFF','folder-1',1,now,now,'pdf','{}','asset-1','account-a');
  db.prepare('INSERT INTO scans(id,qr_id,scanned_at,visitor_hash,device,referrer) VALUES(?,?,?,?,?,?)')
    .run('scan-1','qr-1',now,'hash-1','Mobile','Direct');
  db.prepare('INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES(?,?,?)').run('legacy-token',1,Date.now()+86400000);
  db.prepare('INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES(?,?,?)').run('account-token','account-a',Date.now()+86400000);
  db.prepare('INSERT INTO email_verifications(account_id,token_hash,expires_at) VALUES(?,?,?)')
    .run('account-b','verification-hash',Date.now()+86400000);
} finally { db.close(); }
console.log('Created isolated SQLite fixture:',filename);
