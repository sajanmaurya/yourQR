import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { pdfFile } from './fixtures.js';

async function decode(bytes) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  expect(result, 'The actual exported image must decode as a QR code').toBeTruthy();
  return result.data;
}

async function menu(page, name, action) {
  await page.locator(`summary[aria-label="Actions for ${name}"]`).click();
  await page.locator('details[open]').getByRole('button', { name: action, exact: true }).click();
}

test('personal workspace: setup, design, exports, redirects, folders, analytics, and mobile', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create your workspace.' })).toBeVisible();
  await page.getByLabel('Your name').fill('Local Tester');
  await page.getByLabel('Email address').fill('tester@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-for-yourQR-2026');
  await page.getByRole('button', { name: 'Create my workspace' }).click();
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
  await expect(page.locator('.host-status')).toHaveText('Local workspace');
  await expect(page.getByText('Your first connection starts here.')).toBeVisible();

  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Folder name').fill('Personal projects');
  await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'Create QR code', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByTestId('content-type-url').click();
  await dialog.getByLabel('QR code name').fill('Portfolio');
  await dialog.getByLabel('Destination URL').fill('https://example.com/portfolio');
  await dialog.getByLabel('Short link', { exact: false }).fill('portfolio');
  await dialog.getByLabel('Folder', { exact: false }).selectOption({ label: 'Personal projects' });
  await expect(dialog.getByAltText('Live QR code preview')).toBeVisible();
  await dialog.getByRole('tab', { name: 'Design' }).click();
  await dialog.getByLabel('Foreground', { exact: true }).fill('#493a8a');
  const logo = await sharp({ create: { width: 80, height: 80, channels: 4, background: '#493a8a' } }).png().toBuffer();
  await dialog.getByLabel('Upload logo image').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo });
  await expect(dialog.getByAltText('Uploaded center logo')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create QR code', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let qrs = (await (await page.request.get('/api/qrs')).json()).qrs;
  const dynamic = qrs.find(qr => qr.name === 'Portfolio');
  expect(dynamic).toBeTruthy();
  expect(dynamic.logoDataUrl).toMatch(/^data:image\/png/);
  expect(dynamic.fgColor).toBe('#493A8A');

  for (const format of ['PNG', 'SVG']) {
    const download = page.waitForEvent('download');
    await menu(page, 'Portfolio', `Download ${format}`);
    const file = await download;
    expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${format.toLowerCase()}$`));
    expect(await decode(await readFile(await file.path()))).toBe(dynamic.encodedValue);
  }

  await page.getByRole('button', { name: 'Edit Portfolio', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Short link')).toBeDisabled();
  await dialog.getByLabel('Destination URL').fill('https://example.com/new-portfolio');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  let redirect = await page.request.get('/r/portfolio', { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  expect(redirect.headers().location).toBe('https://example.com/new-portfolio');
  const updated = (await (await page.request.get('/api/qrs')).json()).qrs.find(qr => qr.id === dynamic.id);
  expect(updated.encodedValue).toBe(dynamic.encodedValue);
  expect(updated.scanCount).toBe(1);
  await menu(page, 'Portfolio', 'Pause link');
  await expect(page.locator('.qr-card').filter({ hasText: 'Portfolio' }).getByText('Paused', { exact: true })).toBeVisible();
  redirect = await page.request.get('/r/portfolio', { maxRedirects: 0 });
  expect(redirect.status()).toBe(410);
  await menu(page, 'Portfolio', 'Resume link');
  await expect(page.locator('.qr-card').filter({ hasText: 'Portfolio' }).getByText('Dynamic', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create QR code', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByTestId('content-type-text').click();
  await dialog.getByLabel('QR code name').fill('Welcome note');
  await dialog.getByRole('combobox', { name: 'Content', exact: true }).selectOption('text');
  await dialog.getByLabel('Your text').fill('Welcome to my workspace — नमस्ते!');
  await dialog.getByRole('button', { name: 'Create QR code', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  qrs = (await (await page.request.get('/api/qrs')).json()).qrs;
  const staticCode = qrs.find(qr => qr.name === 'Welcome note');
  const staticPng = await page.request.get(`/api/qrs/${staticCode.id}/download?format=png`);
  expect(await decode(await staticPng.body())).toBe('Welcome to my workspace — नमस्ते!');
  await page.getByRole('button', { name: 'Edit Welcome note', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Your text')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByLabel('Search QR codes').fill('welcome');
  await expect(page.locator('.qr-card')).toHaveCount(1);
  await expect(page.locator('.qr-card')).toContainText('Welcome note');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: 'Static', exact: true }).click();
  await expect(page.locator('.qr-card')).toHaveCount(1);
  await page.getByRole('button', { name: /^All codes/ }).click();
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.qr-list tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Grid view' }).click();

  await menu(page, 'Portfolio', 'View analytics');
  await expect(page.getByRole('heading', { name: 'Every scan tells a story.' })).toBeVisible();
  await expect(page.locator('.activity-table')).toContainText('Portfolio');
  await expect(page.getByRole('img', { name: 'Scan chart: 1 visits over 30 days' })).toBeVisible();
  await page.getByLabel('Analytics date range').selectOption('7');
  await expect(page.getByRole('img', { name: 'Scan chart: 1 visits over 7 days' })).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const exportEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export data' }).click();
  const exported = JSON.parse(await readFile(await (await exportEvent).path(), 'utf8'));
  expect(exported.qrs).toHaveLength(2);
  expect(exported.folders).toHaveLength(1);
  expect(exported).not.toHaveProperty('owner');

  await page.getByRole('button', { name: 'Folders', exact: true }).click();
  await page.locator('summary[aria-label="Actions for folder Personal projects"]').click();
  await page.locator('details[open]').getByRole('button', { name: 'Edit folder', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Folder name').fill('My projects');
  await dialog.getByRole('button', { name: 'Save folder' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open My projects', exact: true })).toBeVisible();
  await page.locator('summary[aria-label="Actions for folder My projects"]').click();
  await page.locator('details[open]').getByRole('button', { name: 'Delete folder', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await (await page.request.get('/api/qrs')).json()).qrs.every(qr => !qr.folderId)).toBe(true);

  await page.getByRole('button', { name: /^All QR codes/ }).click();
  await expect(page.locator('.qr-card')).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath('desktop-dashboard.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Edit Portfolio', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('mobile-editor.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect((await page.request.get('/api/qrs')).status()).toBe(401);
  await page.getByLabel('Email address').fill('tester@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-for-yourQR-2026');
  await page.getByRole('button', { name: 'Sign in to yourQR' }).click();
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
  await expect(page.locator('.qr-card')).toHaveCount(2);

  await menu(page, 'Welcome note', 'Delete code');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete QR code', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await menu(page, 'Portfolio', 'Delete code');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete QR code', exact: true }).click();
  await expect(page.getByText('Your first connection starts here.')).toBeVisible();
  expect((await page.request.get('/r/portfolio', { maxRedirects: 0 })).status()).toBe(404);
  expect(errors, 'No uncaught browser errors').toEqual([]);
});

test('PDF QR uploads and replaces documents; all types are selectable and Wi-Fi works', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email address').fill('tester@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-for-yourQR-2026');
  await page.getByRole('button', { name: 'Sign in to yourQR' }).click();
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
  await page.getByRole('button', { name: 'Create QR code', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.locator('.content-type-card')).toHaveCount(19);
  await page.screenshot({ path: test.info().outputPath('all-qr-types.png'), fullPage: true });
  await dialog.getByLabel('Search QR types').fill('pdf');
  await expect(dialog.locator('.content-type-card')).toHaveCount(1);
  await dialog.getByTestId('content-type-pdf').click();
  const original = pdfFile('Original PDF document');
  await dialog.getByLabel('Upload PDF file').setInputFiles({ name: 'Original guide.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(dialog.getByText('Original guide.pdf', { exact: true })).toBeVisible();
  await expect(dialog.getByAltText('Live QR code preview')).toBeVisible();
  await dialog.getByLabel('QR code name').fill('Research paper');
  await dialog.getByLabel('Short link').fill('research-paper');
  await page.screenshot({ path: test.info().outputPath('pdf-editor.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Create QR code', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let code = (await (await page.request.get('/api/qrs')).json()).qrs.find(qr => qr.name === 'Research paper');
  expect(code.contentType).toBe('pdf');
  const qrLink = code.encodedValue;
  const redirect = await page.request.get('/r/research-paper', { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  expect(redirect.headers().location).toBe(code.destination);
  const response = await page.request.get(`/files/${code.assetId}`);
  expect(response.headers()['content-type']).toBe('application/pdf');
  expect(await response.body()).toEqual(original);
  const qrDownload = page.waitForEvent('download');
  await menu(page, 'Research paper', 'Download PNG');
  expect(await decode(await readFile(await (await qrDownload).path()))).toBe(qrLink);

  await page.getByRole('button', { name: 'Edit Research paper', exact: true }).click();
  dialog = page.getByRole('dialog');
  const replacement = pdfFile('Updated PDF document');
  await dialog.getByLabel('Upload PDF file').setInputFiles({ name: 'Updated guide.pdf', mimeType: 'application/pdf', buffer: replacement });
  await expect(dialog.getByText('Updated guide.pdf', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  const oldId = code.assetId;
  code = (await (await page.request.get('/api/qrs')).json()).qrs.find(qr => qr.name === 'Research paper');
  expect(code.encodedValue).toBe(qrLink);
  expect(code.assetId).not.toBe(oldId);
  expect((await page.request.get(`/files/${oldId}`)).status()).toBe(404);
  expect(await (await page.request.get(`/files/${code.assetId}`)).body()).toEqual(replacement);
  await menu(page, 'Research paper', 'Pause link');
  await expect(page.locator('.qr-card').filter({ hasText: 'Research paper' }).getByText('Paused', { exact: true })).toBeVisible();
  expect((await page.request.get(`/files/${code.assetId}`)).status()).toBe(404);
  await menu(page, 'Research paper', 'Resume link');
  await expect(page.locator('.qr-card').filter({ hasText: 'Research paper' }).getByText('Dynamic', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create QR code', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByTestId('content-type-wifi').click();
  await dialog.getByLabel('QR code name').fill('Studio Wi-Fi');
  await dialog.getByLabel('Network name (SSID)').fill('Studio Network');
  await dialog.getByLabel('Wi-Fi password').fill('test-wifi-pass');
  await dialog.getByRole('button', { name: 'Create QR code', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const wifi = (await (await page.request.get('/api/qrs')).json()).qrs.find(qr => qr.name === 'Studio Wi-Fi');
  expect(wifi.encodedValue).toBe('WIFI:T:WPA;S:Studio Network;P:test-wifi-pass;H:false;;');
  await page.getByRole('button', { name: 'Edit Studio Wi-Fi', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Network name (SSID)')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Create QR code', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(page.locator('.toast')).toHaveCount(0);
  await dialog.getByLabel('Search QR types').fill('pdf');
  await dialog.getByTestId('content-type-pdf').click();
  await dialog.getByLabel('Upload PDF file').setInputFiles({ name: 'Mobile.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(dialog.getByText('Mobile.pdf', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('mobile-pdf-editor.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close dialog' }).click();
});

test('review improvements: mobile PDF entry, share/download, clipboard fallback, keyboard access', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Email address').fill('tester@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-for-yourQR-2026');
  await page.getByRole('button', { name: 'Sign in to yourQR' }).click();
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const cards = page.locator('.qr-card');
  await expect(cards).toHaveCount(2);
  const firstBox = await cards.nth(0).boundingBox(), secondBox = await cards.nth(1).boundingBox();
  expect(Math.abs(firstBox.x - secondBox.x)).toBeLessThan(2);
  expect(firstBox.width).toBeGreaterThan(300);
  await page.getByRole('button', { name: 'Create QR code', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByTestId('content-type-pdf').click();
  await expect(dialog.getByText('Upload a PDF file to see your preview.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create QR code', exact: true })).toBeDisabled();
  const uploadBox = await dialog.getByRole('button', { name: 'Choose a PDF file', exact: false }).boundingBox();
  expect(uploadBox.y + uploadBox.height).toBeLessThan(750);
  const longName = 'A'.repeat(140) + '.pdf';
  await dialog.getByLabel('Upload PDF file').setInputFiles({ name: longName, mimeType: 'application/pdf', buffer: pdfFile('Review document') });
  await expect(dialog.getByText(longName, { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('QR code name')).toHaveValue('A'.repeat(100));
  await expect(dialog.getByText(/KB · Click to replace|B · Click to replace/)).toBeVisible();
  await expect(dialog.getByText('Preview only. Save your code before scanning or downloading.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await menu(page, 'Research paper', 'Share or test link');
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Permanent QR link')).toHaveValue(/\/r\/research-paper$/);
  // Simulate a browser without the secure clipboard API on a plain HTTP Wi-Fi address.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download PDF', exact: true }).click();
  const file = await downloadEvent;
  expect(file.suggestedFilename()).toBe('Updated guide.pdf');
  expect((await readFile(await file.path())).subarray(0, 5).toString()).toBe('%PDF-');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('unexpected view errors show a recovery screen and can be reloaded', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email address').fill('tester@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-for-yourQR-2026');
  await page.getByRole('button', { name: 'Sign in to yourQR' }).click();
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
  await page.route('**/api/qrs', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ qrs: null }) }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'This view couldn’t load.' })).toBeVisible();
  await page.unroute('**/api/qrs');
  await page.getByRole('button', { name: 'Reload workspace' }).click();
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
});

test('a changed Wi-Fi address gives a visible warning without breaking the dashboard', async ({ page }) => {
  const setup = await page.request.post('/api/auth/setup', { data: { name: 'Network test', email: 'network@example.test', password: 'network-test-password-2026' } });
  if (setup.status() === 409) {
    // The full suite already has an owner; each browser context needs its own session.
    const login = await page.request.post('/api/auth/login', { data: { email: 'tester@example.com', password: 'test-password-for-yourQR-2026' } });
    expect(login.status()).toBe(200);
  } else {
    expect(setup.status()).toBe(201);
  }
  await page.route('**/api/auth/session', async route => {
    const response = await route.fetch();
    const state = await response.json();
    state.config.lanAddressStale = true;
    await route.fulfill({ response, json: state });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Wi-Fi address has changed');
  await expect(page.getByRole('button', { name: 'Create QR code', exact: true })).toBeEnabled();
});
