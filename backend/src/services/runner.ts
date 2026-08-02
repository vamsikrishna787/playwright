import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BACKEND_ROOT, RUNNER_CONFIG_PATH, runDir, specFileName } from '../config.js';
import type { RunRecord, RunStatus, RunStep, RunTest } from '../types.js';
import { resolveCli } from './resolveCli.js';
import { patchRun, runsStore } from './storage.js';

interface ReportStep {
  title: string;
  duration: number;
  error?: { message?: string };
  steps?: ReportStep[];
}

interface ReportResult {
  status?: string;
  duration?: number;
  steps?: ReportStep[];
  errors?: Array<{ message?: string }>;
  attachments?: Array<{ name: string; path?: string; contentType?: string }>;
}

const relative = (absolute: string) =>
  path.relative(BACKEND_ROOT, absolute).replace(/\\/g, '/');

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

function flattenSteps(steps: ReportStep[] | undefined): RunStep[] {
  if (!steps) return [];
  const named = steps.filter((step) => step.title && !step.title.startsWith('Before Hooks'));
  return named.map((step) => ({
    title: step.title,
    durationMs: step.duration ?? 0,
    ...(step.error?.message ? { error: stripAnsi(step.error.message) } : {}),
  }));
}

/**
 * Collects every spec in the report, not just the first — a generated file now
 * holds a functional test plus an accessibility test, and both must be reported.
 */
function collectResults(report: unknown): Array<{ title: string; result: ReportResult }> {
  const suites = (report as { suites?: unknown[] })?.suites;
  if (!Array.isArray(suites)) return [];

  const found: Array<{ title: string; result: ReportResult }> = [];

  const walk = (suite: any) => {
    for (const spec of suite.specs ?? []) {
      const result = spec.tests?.[0]?.results?.[0];
      if (result) found.push({ title: spec.title ?? 'test', result: result as ReportResult });
    }
    for (const child of suite.suites ?? []) walk(child);
  };

  for (const suite of suites) walk(suite);
  return found;
}

async function readJsonSafe(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function findWebms(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findWebms(full)));
    else if (entry.name.endsWith('.webm')) found.push(full);
  }
  return found;
}

/**
 * A spec file holds several tests, and one test can emit several videos — the
 * accessibility scan leaves a ~2KB clip of a throwaway blank page. Neither
 * report order nor attachment order puts the meaningful recording first, so
 * claim the largest: that is the test that actually drove the page.
 */
async function claimVideo(
  artifactsDir: string,
  runDirectory: string,
  results: ReportResult[],
): Promise<string | null> {
  const fromReport = results.flatMap(
    (r) =>
      r.attachments
        ?.filter((a) => a.name === 'video' && a.path)
        .map((a) => a.path as string) ?? [],
  );
  const candidates = fromReport.length > 0 ? fromReport : await findWebms(artifactsDir);

  const sized = await Promise.all(
    candidates.map(async (file) => ({
      file,
      size: await fs
        .stat(file)
        .then((s) => s.size)
        .catch(() => -1),
    })),
  );

  const source = sized
    .filter((c) => c.size >= 0)
    .sort((a, b) => b.size - a.size)[0]?.file;
  if (!source) return null;

  const target = path.join(runDirectory, 'video.webm');
  if (path.resolve(source) === path.resolve(target)) return target;
  try {
    await fs.rename(source, target);
    return target;
  } catch {
    return source;
  }
}

// Each run is its own Chromium process, so "Run all" over a large suite would
// thrash the machine. Runs beyond this limit sit in `queued` until a slot frees.
const MAX_CONCURRENT_RUNS = 3;
let activeRuns = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeRuns < MAX_CONCURRENT_RUNS) {
    activeRuns += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  // Hand the slot straight to the next waiter instead of decrementing first —
  // otherwise a concurrent acquire could slip in and exceed the limit.
  const next = waiting.shift();
  if (next) next();
  else activeRuns -= 1;
}

export async function startRun(scriptId: string): Promise<RunRecord> {
  const runId = randomUUID();
  const dir = runDir(scriptId, runId);
  await fs.mkdir(dir, { recursive: true });

  const record: RunRecord = {
    id: runId,
    scriptId,
    status: 'queued',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    videoPath: null,
    reportPath: relative(path.join(dir, 'report.json')),
    tests: [],
    steps: [],
    error: null,
  };

  await runsStore.update((runs) => [record, ...runs]);
  void schedule(scriptId, runId, dir);
  return record;
}

async function schedule(scriptId: string, runId: string, dir: string): Promise<void> {
  await acquireSlot();
  try {
    await runsStore.update((runs) =>
      patchRun(runs, runId, { status: 'running', startedAt: new Date().toISOString() }),
    );
    await execute(scriptId, runId, dir);
  } finally {
    releaseSlot();
  }
}

async function execute(scriptId: string, runId: string, dir: string): Promise<void> {
  const reportFile = path.join(dir, 'report.json');
  const logFile = path.join(dir, 'stdout.log');
  // Playwright wipes --output at startup, so it gets its own subdirectory and our
  // report/log files stay outside of it.
  const artifactsDir = path.join(dir, 'artifacts');
  const log = createWriteStream(logFile);

  try {
    const child = spawn(
      process.execPath,
      [
        resolveCli('@playwright/test'),
        'test',
        specFileName(scriptId),
        `--config=${RUNNER_CONFIG_PATH}`,
        `--output=${artifactsDir}`,
      ],
      {
        cwd: BACKEND_ROOT,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, FORCE_COLOR: '0' },
        windowsHide: true,
      },
    );

    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });

    const exitCode: number = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code ?? -1));
      child.on('error', () => resolve(-1));
    });

    await finalize(runId, dir, artifactsDir, reportFile, logFile, exitCode);
  } catch (err) {
    await runsStore.update((runs) =>
      patchRun(runs, runId, {
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  } finally {
    log.end();
  }
}

async function finalize(
  runId: string,
  dir: string,
  artifactsDir: string,
  reportFile: string,
  logFile: string,
  exitCode: number,
): Promise<void> {
  const report = (await readJsonSafe(reportFile)) as { errors?: Array<{ message?: string }> } | null;
  const collected = report ? collectResults(report) : [];
  const result = collected[0]?.result;

  if (!result) {
    const configError = report?.errors?.[0]?.message;
    const tail = stripAnsi(await fs.readFile(logFile, 'utf-8').catch(() => '')).slice(-4000);
    await runsStore.update((runs) =>
      patchRun(runs, runId, {
        status: 'error',
        finishedAt: new Date().toISOString(),
        error:
          stripAnsi(configError ?? '').trim() ||
          tail.trim() ||
          `Playwright exited with code ${exitCode} and produced no report.`,
      }),
    );
    return;
  }

  const tests: RunTest[] = collected.map(({ title, result: r }) => ({
    title,
    status: r.status === 'passed' ? 'passed' : 'failed',
    durationMs: r.duration ?? 0,
    steps: flattenSteps(r.steps),
    error: r.errors?.[0]?.message ? stripAnsi(r.errors[0].message!) : null,
  }));

  // The run passes only if every test in the file passed.
  const status: RunStatus = tests.every((t) => t.status === 'passed') ? 'passed' : 'failed';
  const firstFailure = tests.find((t) => t.status === 'failed');

  // Any test in the file may own the recording, so weigh them all.
  const videoPath = await claimVideo(artifactsDir, dir, collected.map((c) => c.result));

  await runsStore.update((runs) =>
    patchRun(runs, runId, {
      status,
      finishedAt: new Date().toISOString(),
      durationMs: tests.reduce((sum, t) => sum + t.durationMs, 0) || (result.duration ?? null),
      videoPath: videoPath ? relative(videoPath) : null,
      tests,
      steps: tests.flatMap((t) => t.steps),
      error: firstFailure?.error ?? null,
    }),
  );
}
