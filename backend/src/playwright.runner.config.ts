import { defineConfig } from '@playwright/test';
import { SCRIPTS_DIR } from './config.js';

export default defineConfig({
  testDir: SCRIPTS_DIR,
  reporter: [['json'], ['list']],
  timeout: 60_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: {
    // Record at the viewport's own resolution. Playwright otherwise scales video
    // down to fit 800x800 — a 1280x720 viewport lands at 800x450 — which leaves
    // dense pages (Amazon) unreadable in the player.
    viewport: { width: 1280, height: 720 },
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
});
