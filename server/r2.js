import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const KB = 1024;
const MAX_PDF = 20 * 1024 * KB;
const PREFIX = 'QORI-R2-V1:';
const ALLOWED_KEY = /^pdf\/[a-z0-9-]{1,70}\/[0-9a-f-]{36}\.pdf$/;

export function r2Marker(key, pending = false) {
  if (!ALLOWED_KEY.test(key)) throw new Error('Invalid R2 storage key.');
  return Buffer.from(PREFIX + (pending ? 'PENDING:' : 'READY:') + key);
}
export function r2StoredKey(bytes) {
  if (bytes == null) return null;
  let buf;
  if (typeof bytes === 'string' && bytes.startsWith('\\x')) buf = Buffer.from(bytes.slice(2), 'hex');
  else buf = Buffer.from(bytes);
  const str = buf.toString('utf8');
  if (!str.startsWith(PREFIX)) return null;
  const marker = str.slice(PREFIX.length);
  const pending = marker.startsWith('PENDING:');
  const ready = marker.startsWith('READY:');
  const key = marker.slice(pending ? 8 : 6);
  if ((!pending && !ready) || !ALLOWED_KEY.test(key)) throw new Error('Invalid R2 object descriptor.');
  return { key, pending };
}
export function blobBytes(row) {
  if (typeof row.bytes === 'string' && row.bytes.startsWith('\\x')) return Buffer.from(row.bytes.slice(2), 'hex');
  return Buffer.from(row.bytes);
}

export function createR2Storage(env = process.env, backend = {}) {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  if (!keys.some(key => env[key])) return null;
  if (!keys.every(key => env[key])) throw new Error('R2 is partially configured; add all four R2 server-side secrets.');
  if (!/^[0-9a-f]{32}$/i.test(env.R2_ACCOUNT_ID) || !/^[a-z0-9-]{3,63}$/.test(env.R2_BUCKET)) throw new Error('Invalid R2 account or bucket settings.');
  const endpoint = 'https://' + env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com';
  const client = backend.client ?? new S3Client({
    region: 'auto', endpoint, forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    requestHandler: undefined,
  });
  const sign = backend.sign ?? getSignedUrl;
  const bucket = env.R2_BUCKET;
  return {
    async initPdf({ id, ownerKey, name, size }) {
      if (!Number.isSafeInteger(size) || size < 8 || size > MAX_PDF) throw new Error('PDF must be between 8 bytes and 20 MB.');
      const owner = ownerKey === 'legacy' ? 'legacy' : String(ownerKey).toLowerCase();
      if (!/^(legacy|[a-f0-9-]{36})$/.test(owner)) throw new Error('Invalid workspace for R2.');
      const key = `pdf/${owner}/${id}.pdf`;
      if (!ALLOWED_KEY.test(key)) throw new Error('Invalid R2 key.');
      const url = await sign(client, new PutObjectCommand({
        Bucket: bucket, Key: key, ContentType: 'application/pdf',
        ContentDisposition: 'inline; filename="qori-document.pdf"',
      }), { expiresIn: 300 });
      return { key, url, contentType: 'application/pdf' };
    },
    async verifyPdf({ key, size }) {
      if (!ALLOWED_KEY.test(key)) throw new Error('Invalid R2 storage key.');
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (Number(head.ContentLength) !== size || size > MAX_PDF || head.ContentType !== 'application/pdf') throw new Error('Uploaded PDF size or type does not match the original request.');
      const start = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-7' }));
      const first = Buffer.from(await start.Body.transformToByteArray());
      if (!first.toString('ascii').startsWith('%PDF-')) throw new Error('The uploaded file does not contain a PDF header.');
      const end = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=-2048' }));
      const tail = Buffer.from(await end.Body.transformToByteArray());
      if (!tail.includes(Buffer.from('%%EOF'))) throw new Error('The uploaded file does not contain a complete PDF trailer.');
    },
    async downloadUrl(key) {
      if (!ALLOWED_KEY.test(key)) throw new Error('Invalid R2 key.');
      return sign(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 120 });
    },
    async delete(key) {
      if (!ALLOWED_KEY.test(key)) throw new Error('Invalid R2 key.');
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
