import { defineConfig } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, mkdtempSync } from 'node:fs';

const testDirectory = process.env.QORI_E2E_DIR || mkdtempSync(path.join(os.tmpdir(), 'qori-browser-'));
mkdirSync(testDirectory, { recursive: true });

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: path.join(testDirectory, 'results'),
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8797',
    viewport: { width: 1440, height: 1000 },
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server/index.js',
    url: 'http://127.0.0.1:8797/api/health',
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '8797',
      DB_PATH: path.join(testDirectory, 'test.sqlite'),
      PUBLIC_BASE_URL: 'http://127.0.0.1:8797',
      COOKIE_SECURE: 'false',
      SETUP_TOKEN: '',
      TRUST_PROXY: '0',
    },
  },
});
