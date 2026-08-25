/**
 * A Lighthouse audit of the page a test exercises.
 *
 * Runs *after* the run has already been graded, never as part of it: an audit
 * takes about half a minute, and a pass/fail must not wait on a performance
 * measurement to be reported.
 *
 * One at a time, globally. Lighthouse measures how fast a page loads on this
 * machine, so two audits racing each other would each report the other's CPU
 * contention as the page being slow.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { LIGHTHOUSE_ENABLED, LIGHTHOUSE_TIMEOUT_MS, toRelative } from '../config.js';
import type { LighthouseReport } from '../types.js';
import { exists, readJson } from '../util/fsx.js';
import { nowIso } from '../util/misc.js';
import { chromiumPath, lighthouseCli } from './nodeCli.js';

/** Lighthouse category id -> the camelCase key the wire format uses. */
const CATEGORIES: Record<string, string> = {
  performance: 'performance',
  accessibility: 'accessibility',
  'best-practices': 'bestPractices',
  seo: 'seo',
};

/** The metrics worth showing someone who is not reading the full report. */
const METRICS: Record<string, string> = {
  'first-contentful-paint': 'firstContentfulPaint',
  'largest-contentful-paint': 'largestContentfulPaint',
  'total-blocking-time': 'totalBlockingTime',
  'cumulative-layout-shift': 'cumulativeLayoutShift',
  'speed-index': 'speedIndex',
};

interface RawReport {
  categories?: Record<string, { score?: number | null }>;
  audits?: Record<string, { displayValue?: string }>;
  finalDisplayedUrl?: string;
  finalUrl?: string;
  lighthouseVersion?: string;
  runtimeError?: { message?: string };
}

/** Lighthouse scores are 0–1 floats, or null for a category it could not grade. */
const score = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw * 100) : null;

const failed = (url: string, error: string): LighthouseReport => ({
  status: 'error',
  url,
  scores: {},
  metrics: {},
  reportPath: null,
  jsonPath: null,
  version: '',
  error,
  finishedAt: nowIso(),
});

export const isAvailable = () => LIGHTHOUSE_ENABLED && lighthouseCli() !== null;

/** Serialises audits across the whole process. */
let queue: Promise<unknown> = Promise.resolve();

export function audit(url: string, directory: string): Promise<LighthouseReport> {
  const next = queue.then(() => run(url, directory));
  queue = next.catch(() => undefined);
  return next;
}

async function run(url: string, directory: string): Promise<LighthouseReport> {
  const cli = lighthouseCli();
  if (!cli) return failed(url, 'Lighthouse is not installed. Run: npm install -D lighthouse');

  // Lighthouse writes <base>.report.json and <base>.report.html from one base path.
  const base = path.join(directory, 'lighthouse');
  const argv = [
    cli,
    url,
    '--output=json',
    '--output=html',
    `--output-path=${base}`,
    `--only-categories=${Object.keys(CATEGORIES).join(',')}`,
    // A fresh headless Chrome, isolated from any profile on the machine, so an
    // extension or a warm cache cannot colour the numbers.
    '--chrome-flags=--headless=new --no-sandbox --disable-gpu',
    '--quiet',
  ];

  const chrome = chromiumPath();
  const exitCode = await new Promise<number | string>((resolve) => {
    const child = spawn(process.execPath, argv, {
      cwd: directory,
      env: { ...process.env, ...(chrome ? { CHROME_PATH: chrome } : {}) },
      windowsHide: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(`Lighthouse did not finish within ${LIGHTHOUSE_TIMEOUT_MS / 1000}s.`);
    }, LIGHTHOUSE_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(error.message);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  if (typeof exitCode === 'string') return failed(url, exitCode);

  const jsonPath = `${base}.report.json`;
  const htmlPath = `${base}.report.html`;
  const payload = await readJson<RawReport | null>(jsonPath, null);

  if (!payload) return failed(url, `Lighthouse exited with code ${exitCode} and wrote no report.`);
  if (payload.runtimeError?.message) return failed(url, payload.runtimeError.message);

  const categories = payload.categories ?? {};
  const audits = payload.audits ?? {};

  return {
    status: 'done',
    url: payload.finalDisplayedUrl || payload.finalUrl || url,
    scores: Object.fromEntries(
      Object.entries(CATEGORIES).map(([id, key]) => [key, score(categories[id]?.score)]),
    ),
    metrics: Object.fromEntries(
      Object.entries(METRICS).map(([id, key]) => [key, audits[id]?.displayValue || '']),
    ),
    reportPath: (await exists(htmlPath)) ? toRelative(htmlPath) : null,
    jsonPath: toRelative(jsonPath),
    version: payload.lighthouseVersion || '',
    error: null,
    finishedAt: nowIso(),
  };
}
