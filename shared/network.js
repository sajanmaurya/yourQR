export function addressScope(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return 'device';
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every(part => Number(part) <= 255);
    if ((ipv4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) || host.endsWith('.local')) return 'lan';
    return 'public';
  } catch { return 'device'; }
}

export function isLanAddressStale(value, localAddresses) {
  if (addressScope(value) !== 'lan') return false;
  const host = new URL(value).hostname;
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && !localAddresses.includes(host);
}
