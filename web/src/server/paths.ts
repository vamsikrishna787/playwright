/**
 * Where everything lives — in storage, and on local disk.
 *
 * Two distinct spaces, and keeping them apart is what makes the storage switch
 * possible:
 *
 *   Storage keys are what the platform *saves*. They go to whichever provider is
 *   active, so they are forward-slash strings, never filesystem paths.
 *
 *   Work paths are local scratch. Playwright and Lighthouse are child processes
 *   that write real files, so a run always happens on disk; what it produced is
 *   published to storage when it finishes.
 *
 * A path stored inside runs.json is a storage key, which is why the two forms
 * were already interchangeable before the S3 provider existed: the old on-disk
 * layout used exactly these relative paths.
 */
import path from 'node:path';
import { APP_ROOT, appConfig } from '../config/appConfig';

export const keys = {
  suites: 'data/suites.json',
  tests: 'data/tests.json',
  runs: 'data/runs.json',

  spec: (testId: string) => `scripts/${testId}.spec.ts`,

  /** Everything one run produced: report.json, the HTML report, video, Lighthouse. */
  runDir: (testId: string, runId: string) => `runs/${testId}/${runId}`,
  /** Every run a test ever had, for the cascade delete. */
  testRuns: (testId: string) => `runs/${testId}`,
};

const WORK = appConfig.runs.workDir;

export const work = {
  root: WORK,
  /** The directory handed to Playwright as its testDir. */
  scriptsDir: path.join(WORK, 'scripts'),
  specFile: (testId: string) => path.join(WORK, 'scripts', `${testId}.spec.ts`),
  runDir: (testId: string, runId: string) => path.join(WORK, 'runs', testId, runId),

  /** Stays TypeScript: it is read by the Playwright CLI, not by this build. */
  runnerConfig: path.join(APP_ROOT, 'runtime', 'playwright.runner.config.ts'),
};
