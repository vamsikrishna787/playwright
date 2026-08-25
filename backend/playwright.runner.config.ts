import { defineConfig } from '@playwright/test';
import path from 'node:path';

/**
 * The config the API passes with --config when it runs a generated spec. It is
 * driven entirely by environment variables the Node runner sets, so every run
 * writes its artifacts into its own directory and nothing collides.
 *
 * The fallbacks keep `npx playwright test --config=playwright.runner.config.ts`
 * working by hand.
 */
const runDir = process.env.PW_RUN_DIR || path.join(process.cwd(), 'runs', 'adhoc');
const testDir = process.env.PW_SCRIPTS_DIR || './scripts';

export default defineConfig({
  testDir,
  outputDir: path.join(runDir, 'artifacts'),
  reporter: [
    // Live progress for the UI. Must come first — it is the one that streams.
    ['./reporters/ndjson.cjs'],
    ['json', { outputFile: path.join(runDir, 'report.json') }],
    ['html', { outputFolder: path.join(runDir, 'html'), open: 'never' }],
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: {
    // Stated rather than left to the default, so a hand-run behaves like an API
    // run. A CLI --headed would still win, but the API builds its own argv and
    // never passes it.
    headless: true,

    // Record at the viewport's own resolution: Playwright otherwise scales video
    // to fit 800x800, which leaves dense pages unreadable in the player.
    viewport: { width: 1280, height: 720 },
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
});
