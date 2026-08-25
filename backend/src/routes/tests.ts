/**
 * A single test: its identity, its data fields, and its steps.
 *
 * Data and steps are saved as whole lists rather than row at a time. The editor
 * is a form, not a spreadsheet - one save per screen keeps the client simple and
 * makes renumbering steps a server-side detail.
 */
import { asyncRouter } from '../util/asyncRouter.js';
import { specFilePath, toRelative } from '../config.js';
import { runs as runStore, tests as testStore } from '../store/index.js';
import { startRun } from '../services/runner.js';
import { exists } from '../util/fsx.js';
import { bool, newId, nowIso, str } from '../util/misc.js';
import { deleteTest, loadTest, loadTestWithSuite, parseSteps, patchTest } from './testHelpers.js';
import fs from 'node:fs/promises';

export const testsRouter = asyncRouter();

testsRouter.get('/', async (request, response) => {
  const suiteId = str(request.query?.suiteId, 60);
  const rows = await testStore.read();
  response.json(suiteId ? rows.filter((test) => test.suiteId === suiteId) : rows);
});

testsRouter.get('/:id', async (request, response) => {
  const test = await loadTest(request.params.id);
  const specPath = specFilePath(test.id);

  response.json({
    ...test,
    // The editor always opens with the script in hand, so switching to the
    // Script tab never costs a second round trip.
    code: (await exists(specPath)) ? await fs.readFile(specPath, 'utf8') : '',
  });
});

testsRouter.patch('/:id', async (request, response) => {
  const test = await patchTest(request.params.id, (current) => ({
    ...current,
    name: request.body?.name !== undefined ? str(request.body.name, 160) || current.name : current.name,
    description:
      request.body?.description !== undefined
        ? str(request.body.description, 4000)
        : current.description,
    url: request.body?.url !== undefined ? str(request.body.url, 500) : current.url,
    includeAda: bool(request.body?.includeAda, current.includeAda),
  }));
  response.json(test);
});

testsRouter.delete('/:id', async (request, response) => {
  await loadTest(request.params.id);
  await deleteTest(request.params.id);
  response.status(204).end();
});

// --- Steps ------------------------------------------------------------------

// Test data itself is owned by the suite - see PUT /api/suites/:id/data. A step
// may only reference a field that exists in that pool, which is what the suite
// lookup here is for.
testsRouter.put('/:id/steps', async (request, response) => {
  const { suite } = await loadTestWithSuite(request.params.id);
  const steps = parseSteps(request.body?.steps, suite.dataFields);
  const test = await patchTest(request.params.id, (row) => ({ ...row, steps }));
  response.json(test);
});

// --- Runs -------------------------------------------------------------------

testsRouter.get('/:id/runs', async (request, response) => {
  await loadTest(request.params.id);
  const rows = await runStore.read();
  response.json(
    rows
      .filter((run) => run.testId === request.params.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  );
});

testsRouter.post('/:id/runs', async (request, response) => {
  const test = await loadTest(request.params.id);
  response.status(202).json(await startRun(test));
});

/** Duplicates a test, script included - the fastest way to a variant. */
testsRouter.post('/:id/copy', async (request, response) => {
  const source = await loadTest(request.params.id);
  const copy = {
    ...structuredClone(source),
    id: newId(),
    name: str(request.body?.name, 160) || `${source.name} (copy)`,
    lastRunId: null,
    lastRunStatus: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const sourceSpec = specFilePath(source.id);
  if (await exists(sourceSpec)) {
    await fs.copyFile(sourceSpec, specFilePath(copy.id));
    copy.scriptPath = toRelative(specFilePath(copy.id));
    copy.scriptUpdatedAt = nowIso();
  } else {
    copy.scriptPath = null;
    copy.scriptUpdatedAt = null;
  }

  await testStore.update((rows) => ({ rows: [...rows, copy], result: null }));
  response.status(201).json(copy);
});
