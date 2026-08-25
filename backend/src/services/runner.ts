/**
 * Executes a generated spec and reports it back as it happens.
 *
 * The specs are TypeScript, so they go to the real Playwright Node CLI. What
 * makes the run watchable is the custom reporter in ../../reporters: it prints a
 * line per step, this module folds each line into the run record, and every
 * update is published to whoever is watching over SSE.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BACKEND_ROOT,
  MAX_CONCURRENT_RUNS,
  RUNNER_CONFIG_PATH,
  RUNS_DIR,
  RUN_TIMEOUT_MS,
  SCRIPTS_DIR,
  runDir as runDirFor,
  specFilePath,
  toRelative,
} from '../config.js';
import { patchRun, runs as runStore, tests as testStore } from '../store/index.js';
import type { Run, RunStepResult, RunTestResult, StepStatus, TestCase } from '../types.js';
import { exists, walk } from '../util/fsx.js';
import { newId, nowIso, stripAnsi } from '../util/misc.js';
import { publish } from './events.js';
import * as lighthouse from './lighthouse.js';
import { playwrightCli } from './nodeCli.js';

const MARKER = '@@PWEVT@@';

/** `[S3] Fill the username` -> 3. The tag the generator is told to write. */
const STEP_TAG = /^\s*\[S(\d+)\]\s*/;

const isAccessibilityTest = (title: string) => /accessib|wcag|a11y|axe/i.test(title);

interface PwEvent {
  type: 'begin' | 'testBegin' | 'stepBegin' | 'stepEnd' | 'testEnd' | 'error' | 'end';
  test?: string;
  title?: string;
  status?: string;
  duration?: number;
  error?: string | null;
  total?: number;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_RUNS) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  waiting.shift()?.();
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/** Writes a patch, then tells the watchers. */
async function update(runId: string, patch: Partial<Run>): Promise<Run | null> {
  const updated = await runStore.update((rows) => {
    const next = patchRun(rows, runId, patch);
    return { rows: next, result: next.find((row) => row.id === runId) ?? null };
  });
  if (updated) publish(updated);
  return updated;
}

/** Closes a run out and keeps the owning test's summary badge in step. */
async function finish(runId: string, patch: Partial<Run>): Promise<Run | null> {
  const run = await update(runId, { finishedAt: nowIso(), ...patch });
  if (run) {
    await testStore.update((rows) => ({
      rows: rows.map((row) =>
        row.id === run.testId ? { ...row, lastRunId: run.id, lastRunStatus: run.status } : row,
      ),
      result: null,
    }));
  }
  return run;
}

/**
 * Creates the run and returns it immediately in `queued`; execution continues in
 * the background. The UI opens the SSE stream against the id it gets back.
 */
export async function startRun(test: TestCase): Promise<Run> {
  const run: Run = {
    id: newId(),
    testId: test.id,
    suiteId: test.suiteId,
    testName: test.name,
    status: 'queued',
    startedAt: nowIso(),
    finishedAt: null,
    durationMs: null,
    // Seeded from the authored steps so the UI can show the whole list greyed
    // out and light it up as the runner reaches each one.
    steps: test.steps.map((step) => ({
      stepId: step.id,
      index: step.index,
      title: step.action,
      status: 'pending' as StepStatus,
      durationMs: 0,
      error: null,
      test: '',
    })),
    tests: [],
    videoPath: null,
    reportPath: null,
    error: null,
    lighthouse: null,
  };

  // Capped so a long-lived install cannot grow runs.json without bound.
  await runStore.update((rows) => ({ rows: [run, ...rows].slice(0, 500), result: null }));
  await testStore.update((rows) => ({
    rows: rows.map((row) =>
      row.id === test.id ? { ...row, lastRunId: run.id, lastRunStatus: 'queued' as const } : row,
    ),
    result: null,
  }));

  void execute(run, test).catch(async (error) => {
    await finish(run.id, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return run;
}

async function execute(run: Run, test: TestCase): Promise<void> {
  const specPath = specFilePath(test.id);
  if (!(await exists(specPath))) {
    await finish(run.id, {
      status: 'error',
      error: 'This test has no script yet. Generate one before running it.',
    });
    return;
  }

  await acquire();
  const startedAt = Date.now();
  try {
    const directory = runDirFor(test.id, run.id);
    await fs.mkdir(directory, { recursive: true });

    // Positional fallback: when the spec carries no [Sn] tags at all - an older
    // script, or a model that forgot - steps are matched to authored steps by
    // order of appearance instead. Decided once, up front, so the mapping rule
    // cannot change halfway through a run.
    const source = await fs.readFile(specPath, 'utf8');
    const tagged = /\[S\d+\]/.test(source);

    await update(run.id, { status: 'running', startedAt: nowIso() });

    const result = await spawnPlaywright(specPath, directory, run.id, tagged, run.steps);

    const reportPath = path.join(directory, 'report.json');
    const video = await findVideo(directory);

    const status: Run['status'] =
      result.crashed || result.tests.length === 0
        ? 'error'
        : result.tests.some((entry) => entry.status === 'failed')
          ? 'failed'
          : 'passed';

    const finished = await finish(run.id, {
      status,
      durationMs: Date.now() - startedAt,
      tests: result.tests,
      steps: result.steps,
      videoPath: video ? toRelative(video) : null,
      reportPath: (await exists(reportPath)) ? toRelative(reportPath) : null,
      error: result.error,
      lighthouse:
        lighthouse.isAvailable() && test.url
          ? {
              status: 'running',
              url: test.url,
              scores: {},
              metrics: {},
              reportPath: null,
              jsonPath: null,
              version: '',
              error: null,
              finishedAt: null,
            }
          : null,
    });

    // Deliberately after the verdict: an audit takes far longer than the test,
    // and nobody should wait on a performance number to learn their test failed.
    if (finished && lighthouse.isAvailable() && test.url) {
      const report = await lighthouse.audit(test.url, directory);
      await update(run.id, { lighthouse: report });
    }
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// The child process
// ---------------------------------------------------------------------------

interface SpawnResult {
  steps: RunStepResult[];
  tests: RunTestResult[];
  error: string | null;
  crashed: boolean;
}

/**
 * Playwright's positional argument is a REGEX matched against the test file
 * path, not a filename - and it matches against a forward-slash path even on
 * Windows. Handing it `C:\e2e\playwright\backend\scripts\x.spec.ts` therefore
 * matches nothing, because `\e`, `\p` and `\b` are regex escapes; Playwright
 * then reports "no tests found" and exits 1 with nothing on stderr.
 *
 * Anchored at the end so one spec can never be selected by another whose id
 * happens to contain it.
 */
function specFilter(specPath: string): string {
  const posix = specPath.split(path.sep).join('/');
  return `${posix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

function spawnPlaywright(
  specPath: string,
  directory: string,
  runId: string,
  tagged: boolean,
  seed: RunStepResult[],
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [playwrightCli(), 'test', specFilter(specPath), `--config=${RUNNER_CONFIG_PATH}`],
      {
        cwd: BACKEND_ROOT,
        windowsHide: true,
        env: {
          ...process.env,
          PW_RUN_DIR: directory,
          PW_SCRIPTS_DIR: SCRIPTS_DIR,
          // A visible browser or an inspector would hang a headless server run.
          PWDEBUG: '',
          PW_TEST_HTML_REPORT_OPEN: 'never',
          FORCE_COLOR: '0',
        },
      },
    );

    const state = new RunState(runId, tagged, seed);
    let stderr = '';
    /**
     * Non-marker stdout, kept for diagnostics.
     *
     * Playwright reports "no tests found" and other startup failures on stdout,
     * not stderr. Discarding everything that is not a reporter event once cost
     * an afternoon: the run failed with an empty error and the one line saying
     * why had been thrown away.
     */
    let noise = '';
    let buffer = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // The trailing fragment may be a partial line; hold it for the next chunk.
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const marked = line.indexOf(MARKER);
        if (marked === -1) {
          if (noise.length < 8000) noise += `${line}
`;
          continue;
        }
        try {
          state.apply(JSON.parse(line.slice(marked + MARKER.length)) as PwEvent);
        } catch {
          /* a torn line is not worth failing a run over */
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ steps: state.steps, tests: state.tests, error: error.message, crashed: true });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      void state.flush().then(() => {
        const noTests = state.tests.length === 0;
        const message = timedOut
          ? `The run exceeded ${RUN_TIMEOUT_MS / 1000}s and was stopped.`
          : noTests && code !== 0
            ? stripAnsi(stderr).trim().slice(-3000) ||
              stripAnsi(noise).trim().slice(-3000) ||
              `Playwright exited with code ${code} without running any test.`
            : state.fatal;

        resolve({
          steps: state.steps,
          tests: state.tests,
          error: message || null,
          crashed: timedOut || (noTests && code !== 0),
        });
      });
    });
  });
}

/**
 * Folds the reporter's event stream into a run record.
 *
 * Updates are coalesced: a fast spec can emit dozens of events a second, and
 * writing runs.json for every one would spend the whole run in the filesystem.
 */
class RunState {
  /**
   * Starts as the authored steps, all pending, so the UI shows the whole list
   * from the first frame and lights each one up as the runner reaches it.
   * Replacing this with an empty list would blank the step view the moment the
   * first event arrived.
   */
  readonly steps: RunStepResult[];
  readonly tests: RunTestResult[] = [];
  fatal: string | null = null;

  private currentTest = '';
  /** How many authored steps the positional fallback has consumed. */
  private claimed = 0;
  private pending: NodeJS.Timeout | null = null;

  constructor(
    private readonly runId: string,
    private readonly tagged: boolean,
    seed: RunStepResult[],
  ) {
    this.steps = seed.map((step) => ({ ...step }));
  }

  apply(event: PwEvent): void {
    switch (event.type) {
      case 'testBegin':
        this.currentTest = event.test ?? '';
        this.tests.push({
          title: this.currentTest,
          status: 'running',
          durationMs: 0,
          error: null,
          accessibility: isAccessibilityTest(this.currentTest),
        });
        break;

      case 'stepBegin':
        this.mark(event, 'running');
        break;

      case 'stepEnd':
        this.mark(event, event.error ? 'failed' : 'passed');
        break;

      case 'testEnd': {
        const entry = this.tests.find(
          (row) => row.title === event.test && row.status === 'running',
        );
        if (entry) {
          entry.status =
            event.status === 'passed' ? 'passed' : event.status === 'skipped' ? 'skipped' : 'failed';
          entry.durationMs = event.duration ?? 0;
          entry.error = event.error ?? null;
        }
        // A step still open when its test ended is where the test died; one
        // never reached was skipped. This is what "passed up to step N" reads.
        for (const step of this.steps) {
          if (step.test !== event.test) continue;
          if (step.status === 'running') step.status = 'failed';
          else if (step.status === 'pending') step.status = 'skipped';
        }
        break;
      }

      case 'error':
        this.fatal = event.error ?? null;
        break;

      default:
        break;
    }
    this.schedule();
  }

  /** Resolves an event to a row in `steps`, adding one if the agent wrote its own. */
  private mark(event: PwEvent, status: StepStatus): void {
    const rawTitle = event.title ?? '';
    const tag = STEP_TAG.exec(rawTitle);
    const title = rawTitle.replace(STEP_TAG, '').trim() || rawTitle;

    let row: RunStepResult | undefined;

    if (tag) {
      const index = Number(tag[1]);
      row = this.steps.find((step) => step.index === index && step.stepId !== null);
    } else if (!this.tagged && !isAccessibilityTest(this.currentTest)) {
      // No tags anywhere in this spec: match in order instead.
      row = this.steps.filter((step) => step.stepId !== null)[this.claimed];
      if (row && status === 'running') this.claimed += 1;
    }

    if (!row) {
      // A step the agent wrote that the user never authored - setup, an extra
      // assertion, the accessibility scan. Shown, but tied to no authored step.
      const existing = this.steps.find(
        (step) => step.stepId === null && step.title === title && step.test === this.currentTest,
      );
      if (existing) {
        row = existing;
      } else {
        row = {
          stepId: null,
          index: this.steps.length + 1,
          title,
          status: 'pending',
          durationMs: 0,
          error: null,
          test: this.currentTest,
        };
        this.steps.push(row);
      }
    }

    row.status = status;
    row.test = this.currentTest;
    if (title) row.title = title;
    if (event.duration !== undefined) row.durationMs = event.duration;
    if (event.error !== undefined) row.error = event.error;
  }

  /**
   * At most one write in flight - enough to feel live without turning the run
   * into a write loop.
   */
  private schedule(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.write();
    }, 250);
  }

  async flush(): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    await this.write();
  }

  private write(): Promise<unknown> {
    return update(this.runId, {
      steps: this.steps.map((step) => ({ ...step })),
      tests: this.tests.map((entry) => ({ ...entry })),
    });
  }
}

/**
 * The video worth showing. A spec records one per page per test, so the
 * functional test's own recording is preferred over the accessibility scan's.
 */
async function findVideo(directory: string): Promise<string | null> {
  const videos = await walk(path.join(directory, 'artifacts'), '.webm');
  if (videos.length === 0) return null;

  return videos.find((file) => !isAccessibilityTest(file)) ?? videos[0] ?? null;
}

/** Removes a test's whole run history, on disk and in the index. */
export async function deleteRunsFor(testId: string): Promise<void> {
  await fs.rm(path.join(RUNS_DIR, testId), { recursive: true, force: true });
  await runStore.update((rows) => ({
    rows: rows.filter((row) => row.testId !== testId),
    result: null,
  }));
}
