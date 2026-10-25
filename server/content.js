import { contentType } from '../shared/content-types.js';
import { ValidationError, validDestination } from './qr.js';

function field(payload, key, label, { optional = false, max = 300, preserve = false } = {}) {
  const raw = payload?.[key];
  if ((raw === undefined || raw === '') && optional) return '';
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw)) throw new ValidationError(`${label} must contain 1–${max} characters.`);
  return preserve ? raw : raw.trim();
}
function single(payload, key, label, options) {
  const value = field(payload, key, label, options);
  if (/[\r\n]/.test(value)) throw new ValidationError(`${label} must be a single line.`);
  return value;
}
function phone(payload, key, optional = false) {
  const value = single(payload, key, 'Phone number', { optional, max: 40 });
  if (!value && optional) return '';
  if (!/^\+?[\d\s().-]{5,30}$/.test(value)) throw new ValidationError('Enter a phone number including its country code.');
  return value.replace(/[\s().-]/g, '');
}
function email(payload, key, optional = false) {
  const value = single(payload, key, 'Email address', { optional, max: 254 });
  if (!value && optional) return '';
  if (!/^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(value)) throw new ValidationError('Enter a valid email address.');
  return value;
}
const escapeWifi = value => value.replace(/[\\;,:\"]/g, char => `\\${char}`);
const escapeVcard = value => value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');

export function resolveContent(category, input, context) {
  const meta = contentType(category);
  if (!meta) throw new ValidationError('Choose a supported QR content type.');
  const { publicBaseUrl, current, db } = context;
  const payload = input.payload ?? current?.payload ?? {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 12000) throw new ValidationError('Content details are invalid or too long.');
  const url = value => validDestination(value, 'url', publicBaseUrl);
  if (category === 'url' || category === 'text') return { destination: validDestination(input.destination ?? current?.destination, category, publicBaseUrl), storageType: category, payload: {}, assetId: null };
  if (meta.file) {
    const assetId = input.assetId ?? current?.assetId;
    if (typeof assetId !== 'string') throw new ValidationError(`Upload a ${meta.name} file first.`);
    const asset = db.prepare('SELECT id,kind FROM assets WHERE id=?').get(assetId);
    if (!asset || asset.kind !== category) throw new ValidationError(`Choose an uploaded ${meta.name} file.`);
    const origin = current ? new URL(current.encodedValue).origin : publicBaseUrl;
    return { destination: `${origin}/files/${asset.id}`, storageType: 'url', payload: {}, assetId };
  }
  let destination, normalized;
  if (['youtube', 'instagram', 'facebook', 'booking'].includes(category)) {
    destination = url(payload.url);
    const host = new URL(destination).hostname.toLowerCase().replace(/^www\./, '');
    const allowed = { youtube: ['youtube.com', 'youtu.be', 'm.youtube.com'], instagram: ['instagram.com'], facebook: ['facebook.com', 'fb.com', 'm.facebook.com'] }[category];
    if (allowed && !allowed.includes(host)) throw new ValidationError(`Enter a ${meta.name} website URL.`);
    normalized = { url: destination };
  } else if (category === 'telegram') {
    const username = single(payload, 'username', 'Telegram username', { max: 64 }).replace(/^@/, '');
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(username)) throw new ValidationError('Use a Telegram username with 5–32 letters, numbers, or underscores.');
    destination = `https://t.me/${username}`; normalized = { username };
  } else if (category === 'whatsapp') {
    const number = phone(payload, 'phone').replace(/^\+/, '');
    if (!/^[1-9]\d{6,14}$/.test(number)) throw new ValidationError('Use your international WhatsApp number, including country code.');
    const message = field(payload, 'message', 'Message', { optional: true, max: 600 });
    destination = `https://wa.me/${number}${message ? `?text=${encodeURIComponent(message)}` : ''}`; normalized = { phone: `+${number}`, message };
  } else if (category === 'map') {
    const address = single(payload, 'address', 'Address or coordinates', { max: 500 });
    destination = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`; normalized = { address };
  } else if (category === 'phone') {
    const number = phone(payload, 'phone'); destination = `tel:${number}`; normalized = { phone: number };
  } else if (category === 'email') {
    const recipient = email(payload, 'email');
    const subject = single(payload, 'subject', 'Subject', { optional: true, max: 200 });
    const body = field(payload, 'body', 'Email message', { optional: true, max: 600 });
    const params = [subject && `subject=${encodeURIComponent(subject)}`, body && `body=${encodeURIComponent(body)}`].filter(Boolean).join('&');
    destination = `mailto:${recipient}${params ? `?${params}` : ''}`; normalized = { email: recipient, subject, body };
  } else if (category === 'wifi') {
    const ssid = single(payload, 'ssid', 'Network name', { max: 32, preserve: true });
    if (Buffer.byteLength(ssid) > 32) throw new ValidationError('Network name must be at most 32 UTF-8 bytes.');
    const security = payload.security || 'WPA';
    if (!['WPA', 'WEP', 'nopass'].includes(security)) throw new ValidationError('Choose WPA/WPA2, WEP, or an open network.');
    const password = security === 'nopass' ? '' : field(payload, 'password', 'Wi-Fi password', { max: 128, preserve: true });
    if (payload.hidden !== undefined && typeof payload.hidden !== 'boolean') throw new ValidationError('Hidden network must be true or false.');
    destination = `WIFI:T:${security};S:${escapeWifi(ssid)};P:${escapeWifi(password)};H:${Boolean(payload.hidden)};;`;
    normalized = { ssid, security, password, hidden: Boolean(payload.hidden) };
  } else if (category === 'vcard') {
    const firstName = single(payload, 'firstName', 'First name', { max: 80 });
    const lastName = single(payload, 'lastName', 'Last name', { optional: true, max: 80 });
    const organization = single(payload, 'organization', 'Organization', { optional: true, max: 120 });
    const number = phone(payload, 'phone', true), address = single(payload, 'address', 'Address', { optional: true, max: 200 });
    const mail = email(payload, 'email', true), website = payload.website ? url(payload.website) : '';
    const v = escapeVcard;
    destination = ['BEGIN:VCARD', 'VERSION:3.0', `N:${v(lastName)};${v(firstName)};;;`, `FN:${v(`${firstName} ${lastName}`.trim())}`, organization && `ORG:${v(organization)}`, number && `TEL;TYPE=CELL:${number}`, mail && `EMAIL:${v(mail)}`, website && `URL:${v(website)}`, address && `ADR;TYPE=WORK:;;${v(address)};;;;`, 'END:VCARD'].filter(Boolean).join('\r\n');
    normalized = { firstName, lastName, organization, phone: number, email: mail, website, address };
  } else if (category === 'app' || category === 'smart') {
    const fallbackUrl = url(payload.fallbackUrl);
    const iosUrl = payload.iosUrl ? url(payload.iosUrl) : '';
    const androidUrl = payload.androidUrl ? url(payload.androidUrl) : '';
    if (category === 'app' && (!iosUrl || !androidUrl)) throw new ValidationError('Add both App Store and Google Play URLs, plus a default website.');
    if (category === 'app' && (new URL(iosUrl).hostname !== 'apps.apple.com' || new URL(androidUrl).hostname !== 'play.google.com')) throw new ValidationError('Use apps.apple.com and play.google.com store URLs.');
    destination = fallbackUrl; normalized = { fallbackUrl, iosUrl, androidUrl };
  }
  if (!destination) throw new ValidationError('This QR content type is not supported.');
  if (Buffer.byteLength(destination, 'utf8') > 1800) throw new ValidationError('These details are too long. Shorten the message or contact details.');
  return { destination, storageType: meta.mode === 'static' ? 'text' : 'url', payload: normalized, assetId: null };
}
