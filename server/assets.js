import express from 'express';
import sharp from 'sharp';
import { randomUUID, createHash } from 'node:crypto';
import { handleUpload } from '@vercel/blob/client';
import { del as deleteBlob, get as getBlob } from '@vercel/blob';
import { dbGet, dbRun } from './database.js';
import { contentType } from '../shared/content-types.js';
import { ValidationError } from './qr.js';

export const mapAsset = row => row ? ({ id: row.id, kind: row.kind, name: row.name, mime: row.mime, size: Number(row.size), createdAt: row.created_at }) : null;

function isPptx(bytes) {
  // Inspect the ZIP central directory; do not extract or execute archive entries.
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  let end = bytes.length - 22;
  const lower = Math.max(0, bytes.length - 65557);
  while (end >= lower && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < lower) return false;
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count > 20000 || start + centralSize > end) return false;
  let offset = start;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return false;
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    if (offset + 46 + nameLength + extraLength + commentLength > end) return false;
    names.add(bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names.has('[Content_Types].xml') && names.has('ppt/presentation.xml');
}

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function cleanName(value) {
  return String(value || 'file').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180) || 'file';
}

async function validateFile(kind, bytes, name, cloud = false) {
  const meta = contentType(kind);
  if (!meta?.file) throw new ValidationError('Choose PDF, image, audio, or PPTX.');
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) throw new ValidationError('Choose a non-empty file to upload.');
  if (bytes.length > meta.maxMB * 1024 * 1024) throw new ValidationError('File exceeds the size limit for this content type.');
  let mime;
  if (kind === 'pdf') {
    if (!bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-') || !bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from('%%EOF'))) throw new ValidationError('This is not a recognizable PDF. Upload a complete PDF document.');
    mime = 'application/pdf'; if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
  } else if (kind === 'pptx') {
    if (!isPptx(bytes)) throw new ValidationError('Upload a valid .pptx presentation. Other ZIP and PowerPoint formats are not supported.');
    mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'; if (!name.toLowerCase().endsWith('.pptx')) name += '.pptx';
  } else if (kind === 'image') {
    try {
      const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'error' });
      const info = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(info.format) || (info.pages || 1) > 1) throw new Error();
      if (!cloud) bytes = await image.rotate().png().toBuffer();
      else await image.stats();
      if (bytes.length > 25 * 1024 * 1024) throw new Error();
      const format = cloud ? info.format : 'png';
      mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[format];
      name = name.replace(/\.[^.]+$/, '') + (format === 'jpeg' ? '.jpg' : `.${format}`);
    } catch { throw new ValidationError('Use a readable PNG, JPEG, or WebP image under 20 megapixels.'); }
  } else {
    const header = bytes.subarray(0, 12);
    if (header.subarray(0, 3).toString() === 'ID3' || (header[0] === 255 && (header[1] & 224) === 224)) mime = 'audio/mpeg';
    else if (header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WAVE') mime = 'audio/wav';
    else if (header.subarray(0, 4).toString() === 'OggS') mime = 'audio/ogg';
    else throw new ValidationError('Use an MP3, WAV, or Ogg audio file.');
  }

  return { bytes, name, mime };
}

export function registerAssets(app, db, blobStore = { get: getBlob, del: deleteBlob, handleUpload }) {
  if (db.driver === 'postgres') {
    app.post('/api/assets/upload-intent', async (req, res) => {
      const meta = contentType(req.body?.type);
      if (!meta?.file) throw new ValidationError('Choose PDF, image, audio, or PPTX.');
      const id = randomUUID(), name = cleanName(req.body?.name);
      const pathname = 'assets/user-' + req.user.id + '/' + id + '/' + name.replace(/[^a-zA-Z0-9._ -]/g, '_');
      await dbRun(db, 'INSERT INTO user_upload_intents(id,user_id,pathname,kind,name,expires_at) VALUES(?,?,?,?,?,?)', [id, req.user.id, pathname, meta.id, name, Date.now() + 3600000]);
      res.status(201).json({ pathname });
    });
    app.post('/api/assets/upload-token', async (req, res) => {
      const result = await blobStore.handleUpload({ body: req.body, request: req, onBeforeGenerateToken: async pathname => {
        const intent = await dbGet(db, 'SELECT * FROM user_upload_intents WHERE pathname=? AND user_id=? AND expires_at>?', [pathname, req.user.id, Date.now()]);
        if (!intent || await dbGet(db, 'SELECT id FROM user_assets WHERE blob_path=?', [pathname])) throw new ValidationError('Start a new upload. This upload permission has expired or was already used.');
        const meta = contentType(intent.kind);
        return {
          allowedContentTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream'],
          maximumSizeInBytes: meta.maxMB * 1024 * 1024,
          addRandomSuffix: false, allowOverwrite: false, validUntil: Number(intent.expires_at),
        };
      } });
      res.json(result);
    });
    app.post('/api/assets/finalize', async (req, res) => {
      const pathname = req.body?.pathname;
      if (typeof pathname !== 'string') throw new ValidationError('This upload could not be verified.');
      const existing = await dbGet(db, 'SELECT * FROM user_assets WHERE blob_path=? AND user_id=?', [pathname, req.user.id]);
      if (existing) return res.json({ asset: mapAsset(existing) });
      const intent = await dbGet(db, 'SELECT * FROM user_upload_intents WHERE pathname=? AND user_id=? AND expires_at>?', [pathname, req.user.id, Date.now()]);
      if (!intent) throw new ValidationError('Start a new upload. This upload permission has expired.');
      const blob = await blobStore.get(pathname, { access: 'private' });
      if (!blob) throw new ValidationError('Uploaded file not found. Please upload it again.', 404);
      const parts = [];
      let length = 0;
      for await (const part of blob.stream) {
        length += part.length;
        if (length > contentType(intent.kind).maxMB * 1024 * 1024) throw new ValidationError('File exceeds the size limit for this content type.');
        parts.push(Buffer.from(part));
      }
      const file = await validateFile(intent.kind, Buffer.concat(parts), intent.name, true);
      // The intent ID and unique blob path make retries and simultaneous finalizations safe.
      await dbRun(db, 'INSERT INTO user_assets(id,user_id,kind,name,mime,size,bytes,blob_path,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        [intent.id, req.user.id, intent.kind, file.name, file.mime, file.bytes.length, null, pathname, new Date().toISOString()]);
      res.status(201).json({ asset: mapAsset(await dbGet(db, 'SELECT * FROM user_assets WHERE id=? AND user_id=?', [intent.id, req.user.id])) });
    });
  }
  app.post('/api/assets', (req, res, next) => {
    if (db.driver === 'postgres') return res.status(400).json({ error: 'Use the direct file upload flow on this hosted workspace.' });
    next();
  }, express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (req, res) => {
    let name;
    try { name = cleanName(decodeURIComponent(req.get('X-File-Name') || 'file')); } catch { throw new ValidationError('Invalid file name.'); }
    const kind = req.query.type;
    const file = await validateFile(kind, req.body, name);
    const id = randomUUID(), createdAt = new Date().toISOString();
    await dbRun(db, 'INSERT INTO user_assets(id,user_id,kind,name,mime,size,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)', [id, req.user.id, kind, file.name, file.mime, file.bytes.length, file.bytes, createdAt]);
    await dbRun(db, 'DELETE FROM user_assets WHERE user_id=? AND created_at < ? AND id NOT IN (SELECT asset_id FROM user_qr_codes WHERE asset_id IS NOT NULL)', [req.user.id, new Date(Date.now() - 86400000).toISOString()]);
    res.status(201).json({ asset: { id, kind, name: file.name, mime: file.mime, size: file.bytes.length, createdAt } });
  });
  app.delete('/api/assets/:id', async (req, res) => {
    if (await dbGet(db, 'SELECT id FROM user_qr_codes WHERE asset_id=? AND user_id=?', [req.params.id, req.user.id])) throw new ValidationError('This file is used by a QR code. Replace or delete that code first.', 409);
    let row;
    try { row = await dbGet(db, 'DELETE FROM user_assets WHERE id=? AND user_id=? RETURNING blob_path', [req.params.id, req.user.id]); }
    catch (error) { if (error.code === '23503' || String(error.message).includes('FOREIGN KEY')) throw new ValidationError('This file is used by a QR code.', 409); throw error; }
    // Remove the DB reference first: its foreign key prevents a concurrent QR save from referencing a deleted file.
    if (row?.blob_path) {
      try { await blobStore.del(row.blob_path); }
      catch (error) { console.error('Unused Blob needs cleanup:', row.blob_path, error.message); }
    }
    res.json({ ok: true });
  });
  const send = async (req, res, row) => {
    const size = Number(row.size);
    const range = req.get('range');
    let start = 0, end = size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      }
      if (!match || !(match[1] || match[2]) || start > end || start >= size) return res.status(416).set('Content-Range', 'bytes */' + size).end();
    }
    // Fetch before sending headers so a missing object produces a complete, honest 404.
    const blob = row.blob_path ? await blobStore.get(row.blob_path, { access: 'private' }) : null;
    if (row.blob_path && !blob) throw new ValidationError('File not found.', 404);
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Type': row.mime, 'Accept-Ranges': 'bytes', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox allow-same-origin allow-downloads; frame-ancestors 'self'" });
    const safe = row.name.replace(/[^a-zA-Z0-9._ -]/g, '_');
    res.set('Content-Disposition', (row.kind === 'pptx' || req.query.download === '1' ? 'attachment' : 'inline') + '; filename="' + safe + '"; filename*=UTF-8\'\'' + encodeURIComponent(row.name));
    res.set('ETag', '"' + createHash('sha256').update(row.id).digest('hex') + '"');
    if (range) res.status(206).set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
    res.set('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') { if (blob) await blob.stream.cancel(); return res.end(); }
    if (!blob) return res.end(Buffer.from(row.bytes).subarray(start, end + 1));
    // Await the pipeline; cancellation/backpressure and Function lifetime are handled together.
    async function* chunks() {
      let offset = 0;
      for await (const chunk of blob.stream) {
        const nextOffset = offset + chunk.length;
        if (nextOffset > start && offset <= end) yield Buffer.from(chunk).subarray(Math.max(0, start - offset), Math.min(chunk.length, end + 1 - offset));
        offset = nextOffset;
        if (offset > end) break;
      }
    }
    await pipeline(Readable.from(chunks()), res);
  };
  app.get('/api/assets/:id/content', async (req, res) => {
    const row = await dbGet(db, 'SELECT * FROM user_assets WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!row) throw new ValidationError('File not found.', 404);
    return send(req, res, row);
  });
  return async (req, res) => {
    const row = await dbGet(db, 'SELECT a.* FROM user_assets a WHERE a.id=? AND EXISTS(SELECT 1 FROM user_qr_codes q WHERE q.asset_id=a.id AND q.active=1)', [req.params.id]);
    if (!row) return res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('This file is unavailable. Its code may be paused, deleted, or replaced.');
    return send(req, res, row);
  };
}
