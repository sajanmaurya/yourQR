export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}). Please try again.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function formatNumber(number = 0) { return new Intl.NumberFormat().format(number); }
export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* Try the local-network browser fallback below. */ }
  const selection = document.getSelection();
  const previousRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const previousFocus = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text; field.readOnly = true;
  field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(field); field.focus(); field.select();
  let copied = false;
  try { copied = Boolean(document.execCommand('copy')); } catch { /* Manual copy is available in the share dialog. */ }
  field.remove(); previousFocus?.focus?.();
  if (selection && previousRange) { selection.removeAllRanges(); selection.addRange(previousRange); }
  return copied;
}
export function dateLabel(value, options = {}) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: 'UTC' } : {}), ...options });
}
export function destinationLabel(value) {
  try { const url = new URL(value); return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}${url.search}`; }
  catch { return value; }
}

export async function downloadCode(id, format) {
  const response = await fetch(`/api/qrs/${id}/download?format=${format}`, { credentials: 'same-origin' });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Download failed. Please try again.'); }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const header = response.headers.get('content-disposition') || '';
  anchor.download = /filename="?([^";]+)"?/.exec(header)?.[1] || `yourQR-${id}.${format}`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadBackup() {
  const response = await fetch('/api/export', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Backup export failed. Please try again.');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `yourQR-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
