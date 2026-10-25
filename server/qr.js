import QRCode from 'qrcode';
import sharp from 'sharp';

export class ValidationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function textField(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ValidationError(`${label} must contain 1–${max} characters.`);
  }
  return value.trim();
}

export function validColor(value, fallback) {
  const color = value ?? fallback;
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new ValidationError('Use a six-digit hex color such as #163A35.');
  }
  return color.toUpperCase();
}

function luminance(color) {
  const [r, g, b] = color.slice(1).match(/../g).map((v) => {
    const x = parseInt(v, 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function validateColors(fgColor, bgColor) {
  const fg = luminance(fgColor), bg = luminance(bgColor);
  if (bg <= fg || (bg + 0.05) / (fg + 0.05) < 4.5) {
    throw new ValidationError('Use dark QR modules on a lighter background with at least 4.5:1 contrast.');
  }
}

export function validDestination(value, contentType, publicBaseUrl) {
  const destination = textField(value, contentType === 'url' ? 'Destination URL' : 'Text', contentType === 'url' ? 2048 : 1000);
  if (contentType === 'text') {
    if (Buffer.byteLength(value, 'utf8') > 1000) throw new ValidationError('Text must be no larger than 1,000 UTF-8 bytes.');
    return value;
  }
  let url;
  try { url = new URL(destination); } catch { throw new ValidationError('Enter a complete http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\u0000-\u0020\u007f]/.test(destination)) {
    throw new ValidationError('Use an http:// or https:// URL without credentials or spaces.');
  }
  const ownUrl = new URL(publicBaseUrl);
  if (url.origin === ownUrl.origin && /^\/r(?:\/|$)/i.test(url.pathname)) {
    throw new ValidationError('A QR destination cannot point to this app’s redirect links.');
  }
  return url.href;
}

export function validSlug(value, { preview = false } = {}) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,47}$/.test(value)) {
    throw new ValidationError('A short-link slug needs 3–48 letters, numbers, hyphens, or underscores.');
  }
  if (!preview && ['preview', 'api', 'admin', 'login', 'setup', 'logout'].includes(value.toLowerCase())) {
    throw new ValidationError('This short-link slug is reserved. Please choose another.');
  }
  return value;
}

export async function validLogo(value) {
  if (value === null || value === '' || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 280000) throw new ValidationError('Logo must be a PNG or JPEG no larger than 200 KB.');
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new ValidationError('Upload a PNG or JPEG logo. SVG logos are not accepted.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 200 * 1024 || bytes.length < 8) throw new ValidationError('Logo must be no larger than 200 KB.');
  try {
    const image = sharp(bytes, { limitInputPixels: 4_000_000, failOn: 'error' });
    const meta = await image.metadata();
    if (!['png', 'jpeg'].includes(meta.format) || meta.pages > 1) throw new Error('Unsupported image');
    const normalized = await image.rotate().resize(160, 160, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return `data:image/png;base64,${normalized.toString('base64')}`;
  } catch {
    throw new ValidationError('This logo could not be read. Try a smaller, valid PNG or JPEG.');
  }
}

export async function renderQR(qr, format = 'svg') {
  let svg;
  try {
    svg = await QRCode.toString(qr.encodedValue, {
      type: 'svg', errorCorrectionLevel: 'H', margin: 4, width: 1024,
      color: { dark: qr.fgColor, light: qr.bgColor },
    });
  } catch {
    throw new ValidationError('This content is too long for a QR code. Try a shorter value.');
  }
  if (qr.logoDataUrl) {
    const dimension = Number(/viewBox="0 0 (\d+) (\d+)"/.exec(svg)?.[1]);
    const modules = dimension - 8;
    const side = Math.max(3, modules * 0.18), inset = side * 0.11;
    const origin = (dimension - side) / 2;
    svg = svg.replace('</svg>', `<rect x="${origin}" y="${origin}" width="${side}" height="${side}" rx="${side * 0.08}" fill="${qr.bgColor}"/><image x="${origin + inset}" y="${origin + inset}" width="${side - inset * 2}" height="${side - inset * 2}" preserveAspectRatio="xMidYMid meet" href="${qr.logoDataUrl}"/></svg>`);
  }
  if (format === 'png') return sharp(Buffer.from(svg), { density: 96 }).resize(1024, 1024).png().toBuffer();
  return svg;
}
