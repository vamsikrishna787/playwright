import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite. Separate from backend/src/playwright.runner.config.ts, which
 * the app passes explicitly with --config to run the specs it generates at
 * runtime; that one is not a project test config and does not cover this dir.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
