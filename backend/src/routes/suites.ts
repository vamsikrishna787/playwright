/**
 * Suites, and the tests filed under them.
 *
 * A suite is the unit the home page lists and the unit "run everything" acts on.
 */
import { asyncRouter } from '../util/asyncRouter.js';
import { runs as runStore, suites as suiteStore, tests as testStore } from '../store/index.js';
import type { Run, Suite, TestCase } from '../types.js';
import { ApiError, badRequest, newId, notFound, nowIso, str } from '../util/misc.js';
import { startRun } from '../services/runner.js';
import { deleteTest, parseDataFields } from './testHelpers.js';

export const suitesRouter = asyncRouter();

/** A suite plus the counts the home page shows without opening it. */
async function summarise(suite: Suite, tests: TestCase[], latest: Map<string, Run>) {
  const own = tests.filter((test) => test.suiteId === suite.id);
  const statuses = own.map((test) => latest.get(test.id)?.status ?? test.lastRunStatus ?? null);

  return {
    ...suite,
    testCount: own.length,
    dataCount: suite.dataFields.length,
    scriptCount: own.filter((test) => test.scriptPath).length,
    passed: statuses.filter((status) => status === 'passed').length,
    failed: statuses.filter((status) => status === 'failed' || status === 'error').length,
    lastRunAt: own.reduce<string | null>((latestAt, test) => {
      const at = test.lastRunId ? (latest.get(test.id)?.startedAt ?? null) : null;
      return at && (!latestAt || at > latestAt) ? at : latestAt;
    }, null),
  };
}

/** Most recent run per test, so a list render costs one pass over runs.json. */
async function latestRuns(): Promise<Map<string, Run>> {
  const rows = await runStore.read();
  const latest = new Map<string, Run>();
  for (const run of rows) {
    const held = latest.get(run.testId);
    if (!held || run.startedAt > held.startedAt) latest.set(run.testId, run);
  }
  return latest;
}

suitesRouter.get('/', async (_request, response) => {
  const [rows, tests, latest] = await Promise.all([
    suiteStore.read(),
    testStore.read(),
    latestRuns(),
  ]);
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  response.json(await Promise.all(sorted.map((suite) => summarise(suite, tests, latest))));
});

suitesRouter.post('/', async (request, response) => {
  const name = str(request.body?.name, 120);
  if (!name) throw badRequest('A suite needs a name.');

  const suite: Suite = {
    id: newId(),
    name,
    description: str(request.body?.description, 2000),
    baseUrl: str(request.body?.baseUrl, 500),
    dataFields: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await suiteStore.update((rows) => ({ rows: [...rows, suite], result: null }));
  response.status(201).json(suite);
});

suitesRouter.get('/:id', async (request, response) => {
  const suite = await suiteStore.find((row) => row.id === request.params.id);
  if (!suite) throw notFound('Suite');

  const [tests, latest] = await Promise.all([testStore.read(), latestRuns()]);
  const own = tests
    .filter((test) => test.suiteId === suite.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((test) => ({
      ...test,
      stepCount: test.steps.length,
      // How much of the suite's shared pool this test actually draws on.
      dataUsed: new Set(test.steps.flatMap((step) => step.dataFieldIds)).size,
      lastRun: latest.get(test.id) ?? null,
    }));

  response.json({ ...(await summarise(suite, tests, latest)), tests: own });
});

suitesRouter.patch('/:id', async (request, response) => {
  const updated = await suiteStore.update((rows) => {
    const suite = rows.find((row) => row.id === request.params.id);
    if (!suite) return { rows, result: null };

    const next: Suite = {
      ...suite,
      name: request.body?.name !== undefined ? str(request.body.name, 120) || suite.name : suite.name,
      description:
        request.body?.description !== undefined
          ? str(request.body.description, 2000)
          : suite.description,
      baseUrl:
        request.body?.baseUrl !== undefined ? str(request.body.baseUrl, 500) : suite.baseUrl,
      updatedAt: nowIso(),
    };
    return { rows: rows.map((row) => (row.id === next.id ? next : row)), result: next };
  });

  if (!updated) throw notFound('Suite');
  response.json(updated);
});

suitesRouter.delete('/:id', async (request, response) => {
  const suite = await suiteStore.find((row) => row.id === request.params.id);
  if (!suite) throw notFound('Suite');

  // Deleting the suite has to take its tests with it, or their scripts and runs
  // are stranded on disk with nothing left pointing at them.
  const owned = (await testStore.read()).filter((test) => test.suiteId === suite.id);
  for (const test of owned) await deleteTest(test.id);

  await suiteStore.update((rows) => ({
    rows: rows.filter((row) => row.id !== suite.id),
    result: null,
  }));
  response.status(204).end();
});

// --- The shared data pool ---------------------------------------------------

/**
 * Saves the suite's data pool.
 *
 * Deleting a field has to reach into every test in the suite: a step still
 * pointing at it would generate a reference to nothing. That cascade is why
 * this lives on the suite route rather than being a plain field patch.
 */
suitesRouter.put('/:id/data', async (request, response) => {
  const suite = await suiteStore.find((row) => row.id === request.params.id);
  if (!suite) throw notFound('Suite');

  const fields = parseDataFields(request.body?.dataFields);
  const kept = new Set(fields.map((field) => field.id));

  const updated = await suiteStore.update((rows) => {
    const next = rows.map((row) =>
      row.id === suite.id ? { ...row, dataFields: fields, updatedAt: nowIso() } : row,
    );
    return { rows: next, result: next.find((row) => row.id === suite.id)! };
  });

  await testStore.update((rows) => ({
    rows: rows.map((test) =>
      test.suiteId === suite.id
        ? {
            ...test,
            steps: test.steps.map((step) => ({
              ...step,
              dataFieldIds: step.dataFieldIds.filter((id) => kept.has(id)),
            })),
          }
        : test,
    ),
    result: null,
  }));

  response.json(updated);
});

// --- Tests within a suite ---------------------------------------------------

suitesRouter.post('/:id/tests', async (request, response) => {
  const suite = await suiteStore.find((row) => row.id === request.params.id);
  if (!suite) throw notFound('Suite');

  const name = str(request.body?.name, 160);
  if (!name) throw badRequest('A test needs a name.');

  const test: TestCase = {
    id: newId(),
    suiteId: suite.id,
    name,
    description: str(request.body?.description, 4000),
    // Falls back to the suite's base URL, which is why one is worth setting.
    url: str(request.body?.url, 500) || suite.baseUrl,
    steps: [],
    scriptPath: null,
    scriptUpdatedAt: null,
    scriptOrigin: null,
    includeAda: request.body?.includeAda === false ? false : true,
    lastRunId: null,
    lastRunStatus: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await testStore.update((rows) => ({ rows: [...rows, test], result: null }));
  response.status(201).json(test);
});

/** Runs every test in the suite that has a script. */
suitesRouter.post('/:id/runs', async (request, response) => {
  const suite = await suiteStore.find((row) => row.id === request.params.id);
  if (!suite) throw notFound('Suite');

  const runnable = (await testStore.read()).filter(
    (test) => test.suiteId === suite.id && test.scriptPath,
  );
  if (runnable.length === 0) {
    throw new ApiError(400, 'No test in this suite has a script yet. Generate one first.');
  }

  // Started in order; the runner's own limit decides how many actually go at once.
  const started = [];
  for (const test of runnable) started.push(await startRun(test));
  response.status(202).json(started);
});
