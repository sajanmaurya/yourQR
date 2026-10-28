import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';

test('SaaS accounts cannot cross workspace boundaries', async t => {
  const app = createApp({ dbPath: ':memory:', publicBaseUrl: 'http://localhost:8787', environment: 'test', secureCookie: false, saasMode: true });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const send = async (path, { method='GET', body, cookie, raw=false } = {}) => {
    const result = await fetch(origin + path, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(raw ? { 'content-type': 'application/octet-stream', 'X-File-Name': 'menu.pdf' } : body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) });
    let data = null;
    if ((result.headers.get('content-type') || '').includes('application/json')) data = await result.json();
    return { status: result.status, body: data, cookie: result.headers.get('set-cookie')?.split(';')[0] };
  };
  const password = 'a-very-long-and-unique-test-password';
  const a = await send('/api/auth/register', { method: 'POST', body: {name:'Alice', email:'alice@example.com', password} });
  const b = await send('/api/auth/register', { method: 'POST', body: {name:'Bob', email:'bob@example.com', password} });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.notEqual(a.body.user.id, b.body.user.id);
  assert.equal((await send('/api/auth/register', { method:'POST', body:{name:'Another Alice',email:'ALICE@example.com',password} })).status, 409);
  const A = a.cookie, B = b.cookie;
  const folder = await send('/api/folders', {method:'POST',cookie:A,body:{name:'Menus'}});
  assert.equal(folder.status,201,JSON.stringify(folder.body));
  assert.equal((await send('/api/folders', {method:'POST',cookie:B,body:{name:'Menus'}})).status,201);
  assert.equal((await send('/api/folders',{cookie:B})).body.folders.length,1);
  const qr = await send('/api/qrs',{method:'POST',cookie:A,body:{name:'Alice Menu',type:'dynamic',contentType:'url',slug:'alice-menu',folderId:folder.body.folder.id,destination:'https://example.com/menu'}});
  assert.equal(qr.status,201,JSON.stringify(qr.body));
  const id = qr.body.qr.id;
  assert.equal((await send('/api/qrs',{cookie:B})).body.qrs.length,0);
  assert.equal((await send('/api/qrs/' + id, {method:'PATCH',cookie:B,body:{name:'Stolen'}})).status,404);
  assert.equal((await send('/api/qrs/' + id, {method:'DELETE',cookie:B})).status,404);
  assert.equal((await send('/api/qrs/' + id + '/download?format=png',{cookie:B})).status,404);
  assert.equal((await send('/api/preview',{method:'POST',cookie:B,body:{id,name:'Preview'}})).status,404);
  assert.equal((await send('/api/analytics?qrId=' + id,{cookie:B})).status,404);
  assert.equal((await send('/api/folders/' + folder.body.folder.id,{method:'DELETE',cookie:B})).status,404);
  assert.equal((await send('/api/qrs',{method:'POST',cookie:B,body:{name:'Invalid',contentType:'url',type:'dynamic',destination:'https://example.org',folderId:folder.body.folder.id}})).status,400);

  const pdf = Buffer.from('%PDF-1.4\\n1 0 obj\\n<<>>\\nendobj\\n%%EOF\\n');
  const upload = await send('/api/assets?type=pdf',{method:'POST',cookie:A,body:pdf,raw:true});
  assert.equal(upload.status,201,JSON.stringify(upload.body));
  const assetId=upload.body.asset.id;
  assert.equal((await send('/api/assets/' + assetId + '/content',{cookie:B})).status,404);
  assert.equal((await send('/api/assets/' + assetId,{method:'DELETE',cookie:B})).status,200);
  assert.equal((await send('/api/assets/' + assetId + '/content',{cookie:A})).status,200);
  assert.equal((await send('/api/qrs',{method:'POST',cookie:B,body:{name:'Steal PDF',type:'dynamic',contentType:'pdf',assetId}})).status,400);

  const redirect = await send('/r/alice-menu');
  assert.equal(redirect.status,302);
  assert.equal((await send('/api/analytics?days=7',{cookie:B})).body.totalScans,0);
  assert.equal((await send('/api/analytics?days=7',{cookie:A})).body.totalScans,1);
  assert.equal((await send('/api/export',{cookie:B})).body.qrs.length,0);
  assert.equal((await send('/api/export',{cookie:A})).body.qrs.length,1);
  const logout=await send('/api/auth/logout',{method:'POST',cookie:A});
  assert.equal(logout.status,200);
  assert.equal((await send('/api/qrs',{cookie:A})).status,401);
  const login=await send('/api/auth/login',{method:'POST',body:{email:'alice@example.com',password}});
  assert.equal(login.status,200);
  assert.equal((await send('/api/qrs',{cookie:login.cookie})).body.qrs.length,1);
});

test('SaaS registration cannot run in legacy private mode',async t=>{
  const app=createApp({dbPath:':memory:',environment:'test',saasMode:false});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.locals.close();});
  const result=await fetch('http://127.0.0.1:'+server.address().port+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'test',email:'test@example.com',password:'more-than-twelve-chars'})});
  assert.equal(result.status,403);
});
