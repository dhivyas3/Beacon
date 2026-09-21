import { defineConfig, devices } from '@playwright/test';

const WEB_URL = 'http://127.0.0.1:4301';

export default defineConfig({
  testDir: './tests',
  globalSetup: './src/global-setup.ts',
  // The specs build on each other: the first registers a website that the rest use.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
