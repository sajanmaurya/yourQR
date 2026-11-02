import { test, expect } from '@playwright/test';

test('users can create accounts, log out, and sign back in without a setup token', async ({ page }) => {
  const email = `browser-${Date.now()}@example.com`;
  const password = 'browser-test-password-2026';
  await page.goto('/');
  await expect(page).toHaveTitle('yourQR — Your QR workspace');
  await page.screenshot({ path: 'design-login.png', fullPage: true });
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByRole('button', { name: 'New to yourQR? Create an account' }).click();
  await page.getByLabel('Your name').fill('Browser User');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create free account' }).click();
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await page.screenshot({ path: 'design-dashboard.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
  await page.screenshot({ path: 'design-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in to yourQR' }).click();
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
});
