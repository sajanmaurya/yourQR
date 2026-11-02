import { test, expect } from '@playwright/test';

test('users can create accounts, log out, and sign back in without a setup token', async ({ page }) => {
  const email = `browser-${Date.now()}@example.com`;
  const password = 'browser-test-password-2026';
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByRole('button', { name: 'New to Qori? Create an account' }).click();
  await page.getByLabel('Your name').fill('Browser User');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create free account' }).click();
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in to Qori' }).click();
  await expect(page.getByRole('heading', { name: 'My QR codes.' })).toBeVisible();
});
