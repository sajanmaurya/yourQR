import express from 'express';
import sharp from 'sharp';
import { randomUUID, createHash } from 'node:crypto';
import { contentType } from '../shared/content-types.js';
import { ValidationError } from './qr.js';

export const mapAsset = row => row ? ({ id: row.id, kind: row.kind, name: row.name, mime: row.mime, size: row.size, createdAt: row.created_at }) : null;

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

export function registerAssets(app, db) {
  app.post('/api/assets', express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (req, res) => {
    const kind = req.query.type, meta = contentType(kind);
    if (!meta?.file) throw new ValidationError('Choose PDF, image, audio, or PPTX.');
    let bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length < 8) throw new ValidationError('Choose a non-empty file to upload.');
    if (bytes.length > meta.maxMB * 1024 * 1024) throw new ValidationError(`${meta.name} files must be no larger than ${meta.maxMB} MB.`);
    let name;
    try { name = decodeURIComponent(req.get('X-File-Name') || 'file'); } catch { throw new ValidationError('Invalid file name.'); }
    name = name.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180) || 'file';
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
        bytes = await image.rotate().png().toBuffer();
        if (bytes.length > 25 * 1024 * 1024) throw new Error();
        mime = 'image/png'; name = name.replace(/\.[^.]+$/, '') + '.png';
      } catch { throw new ValidationError('Use a readable PNG, JPEG, or WebP image under 20 megapixels.'); }
    } else {
      const header = bytes.subarray(0, 12);
      if (header.subarray(0, 3).toString() === 'ID3' || (header[0] === 255 && (header[1] & 224) === 224)) mime = 'audio/mpeg';
      else if (header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WAVE') mime = 'audio/wav';
      else if (header.subarray(0, 4).toString() === 'OggS') mime = 'audio/ogg';
      else throw new ValidationError('Use an MP3, WAV, or Ogg audio file.');
    }
    const id = randomUUID(), createdAt = new Date().toISOString();
    db.prepare('INSERT INTO assets(id,kind,name,mime,size,bytes,created_at,owner_key) VALUES(?,?,?,?,?,?,?,?)').run(id, kind, name, mime, bytes.length, bytes, createdAt, req.ownerKey);
    // Discard abandoned uploads after a day. Referenced files are never collected.
    db.prepare("DELETE FROM assets WHERE created_at < ? AND id NOT IN (SELECT asset_id FROM qr_codes WHERE asset_id IS NOT NULL)").run(new Date(Date.now() - 86400000).toISOString());
    res.status(201).json({ asset: { id, kind, name, mime, size: bytes.length, createdAt } });
  });
  app.delete('/api/assets/:id', (req, res) => {
    if (db.prepare('SELECT id FROM qr_codes WHERE asset_id=? AND owner_key=?').get(req.params.id, req.ownerKey)) throw new ValidationError('This file is used by a QR code. Replace or delete that code first.', 409);
    db.prepare('DELETE FROM assets WHERE id=? AND owner_key=?').run(req.params.id, req.ownerKey); res.json({ ok: true });
  });
  const send = (req, res, row) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Type': row.mime, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox allow-same-origin allow-downloads; frame-ancestors 'self'" });
    const safe = row.name.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/"/g, '_');
    res.set('Content-Disposition', `${row.kind === 'pptx' || req.query.download === '1' ? 'attachment' : 'inline'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    res.set('ETag', `"${createHash('sha256').update(row.id).digest('hex')}"`);
    res.set('Accept-Ranges', 'bytes');
    const bytes = Buffer.from(row.bytes), range = req.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = 0, end = bytes.length - 1;
      if (match && (match[1] || match[2])) {
        if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      }
      if (!match || !(match[1] || match[2]) || start > end || start >= bytes.length) return res.status(416).set('Content-Range', `bytes */${bytes.length}`).end();
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${bytes.length}`).set('Content-Length', String(end - start + 1));
      return req.method === 'HEAD' ? res.end() : res.end(bytes.subarray(start, end + 1));
    }
    res.set('Content-Length', String(bytes.length)); return req.method === 'HEAD' ? res.end() : res.end(bytes);
  };
  app.get('/api/assets/:id/content', (req, res) => {
    const row = db.prepare('SELECT * FROM assets WHERE id=? AND owner_key=?').get(req.params.id, req.ownerKey);
    if (!row) throw new ValidationError('File not found.', 404); send(req, res, row);
  });
  return (req, res) => {
    const row = db.prepare('SELECT a.* FROM assets a WHERE a.id=? AND EXISTS(SELECT 1 FROM qr_codes q WHERE q.asset_id=a.id AND q.active=1)').get(req.params.id);
    if (!row) return res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('This file is unavailable. Its code may be paused, deleted, or replaced.');
    send(req, res, row);
  };
}
