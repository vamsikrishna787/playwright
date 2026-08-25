/**
 * Paths, ports and tunables for the orchestration tier.
 *
 * This process owns the disk: suites, tests, test data, generated specs and run
 * artifacts all live under `backend/`. The Python tier owns no state at all — it
 * is called, it answers, it forgets.
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKEND_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

loadEnv({ path: path.join(BACKEND_ROOT, '.env') });

export const PORT = Number(process.env.PORT || 4000);

/** The Python agent API. Node never calls a model directly. */
export const AGENT_API_URL = (process.env.AGENT_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 180_000);

export const DATA_DIR = path.join(BACKEND_ROOT, 'data');
export const SCRIPTS_DIR = path.join(BACKEND_ROOT, 'scripts');
export const RUNS_DIR = path.join(BACKEND_ROOT, 'runs');

export const SUITES_JSON = path.join(DATA_DIR, 'suites.json');
export const TESTS_JSON = path.join(DATA_DIR, 'tests.json');
export const RUNS_JSON = path.join(DATA_DIR, 'runs.json');

/** Read by the Playwright Node CLI, so it stays TypeScript rather than compiled. */
export const RUNNER_CONFIG_PATH = path.join(BACKEND_ROOT, 'playwright.runner.config.ts');

/**
 * Each run is its own Chromium, so "run suite" over a large suite would thrash the
 * machine. Runs past this limit sit in `queued` until a slot frees.
 */
export const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS || 2);
export const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 10 * 60_000);

/**
 * A Lighthouse audit runs after the verdict is already in, never as part of it —
 * it takes ~30s and says nothing about whether the test passed. LIGHTHOUSE=0 disables.
 */
export const LIGHTHOUSE_ENABLED = !['0', 'false', 'no'].includes(
  (process.env.LIGHTHOUSE || '1').trim().toLowerCase(),
);
export const LIGHTHOUSE_TIMEOUT_MS = Number(process.env.LIGHTHOUSE_TIMEOUT_MS || 180_000);

export const MAX_BODY = '4mb';

export const specFileName = (testId: string) => `${testId}.spec.ts`;
export const specFilePath = (testId: string) => path.join(SCRIPTS_DIR, specFileName(testId));
export const runDir = (testId: string, runId: string) => path.join(RUNS_DIR, testId, runId);

/** Backend-root-relative POSIX path — the form stored in runs.json. */
export const toRelative = (absolute: string) =>
  path.relative(BACKEND_ROOT, absolute).split(path.sep).join('/');
