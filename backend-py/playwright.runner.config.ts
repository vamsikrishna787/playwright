import { defineConfig } from '@playwright/test';

// The Python API sets PW_SCRIPTS_DIR when it spawns the CLI. The fallback keeps
// `npx playwright test --config=playwright.runner.config.ts` working by hand.
const testDir = process.env.PW_SCRIPTS_DIR || './scripts';

export default defineConfig({
  testDir,
  reporter: [['json'], ['list']],
  timeout: 60_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: {
    // Stated rather than left to Playwright's default, so running these specs by
    // hand behaves the same as running them through the API. Note a CLI --headed
    // still overrides this — Playwright gives flags priority over config — but the
    // API builds its own argv and never passes it, and strips PWDEBUG from the
    // child environment (see services/runner.py). The recorder is the one place a
    // visible browser is wanted, and it launches its own.
    headless: true,

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
