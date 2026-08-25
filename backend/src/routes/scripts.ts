/**
 * The script half of a test: reading it, saving it, and everything that needs a
 * model.
 *
 * No prompt lives here. Node assembles the facts - the steps the user wrote, the
 * data fields they named, the failure the last run produced - and the Python
 * tier decides what to say to the model. That split is the whole point of the
 * third layer: swapping models or prompts never touches this file.
 */
import { asyncRouter } from '../util/asyncRouter.js';
import fs from 'node:fs/promises';
import { specFilePath, toRelative } from '../config.js';
import { agents } from '../services/agentClient.js';
import { runs as runStore } from '../store/index.js';
import type { DataField, Run, TestCase } from '../types.js';
import { atomicWrite, exists } from '../util/fsx.js';
import { ApiError, badRequest, nowIso, str, stripAnsi } from '../util/misc.js';
import { loadTest, patchTest } from './testHelpers.js';

export const scriptsRouter = asyncRouter();

/** Actions that take an existing script and hand back a changed one. */
const REFINERS = new Set(['refine', 'improve', 'ada', 'fix']);

async function readCode(test: TestCase): Promise<string> {
  const specPath = specFilePath(test.id);
  return (await exists(specPath)) ? fs.readFile(specPath, 'utf8') : '';
}

/**
 * Writes the spec to disk and records where it came from.
 *
 * `origin` is what the UI badges: a script the model wrote and a script a human
 * edited afterwards deserve different amounts of trust.
 */
async function saveCode(
  testId: string,
  code: string,
  origin: TestCase['scriptOrigin'],
): Promise<TestCase> {
  const specPath = specFilePath(testId);
  await atomicWrite(specPath, code.endsWith('\n') ? code : `${code}\n`);

  return patchTest(testId, (current) => ({
    ...current,
    scriptPath: toRelative(specPath),
    scriptUpdatedAt: nowIso(),
    scriptOrigin: origin,
  }));
}

/**
 * The most recent failure, rendered for the model.
 *
 * Only what actually broke: the failing tests and the failing steps. A whole
 * report would bury the one line that explains the failure.
 */
function renderFailure(run: Run | undefined): string {
  if (!run || (run.status !== 'failed' && run.status !== 'error')) return '';

  const lines: string[] = [`Run status: ${run.status}`];
  if (run.error) lines.push('', stripAnsi(run.error));

  for (const test of run.tests.filter((entry) => entry.status === 'failed')) {
    lines.push('', `FAILED TEST: ${test.title}`, test.error ? stripAnsi(test.error) : '(no message)');
  }
  for (const step of run.steps.filter((entry) => entry.status === 'failed' && entry.error)) {
    lines.push('', `FAILED STEP ${step.index}: ${step.title}`, stripAnsi(step.error ?? ''));
  }

  return lines.join('\n').slice(0, 6000);
}

/** Steps with their data fields resolved, which is the shape the agent expects. */
function withData(test: TestCase) {
  const byId = new Map(test.dataFields.map((field) => [field.id, field]));
  return test.steps.map((step) => ({
    index: step.index,
    action: step.action,
    expected: step.expected,
    data: step.dataFieldIds
      .map((id) => byId.get(id))
      .filter((field): field is DataField => field !== undefined),
  }));
}

// --- Reading and saving -----------------------------------------------------

scriptsRouter.get('/:id/script', async (request, response) => {
  const test = await loadTest(request.params.id);
  response.json({ code: await readCode(test), updatedAt: test.scriptUpdatedAt });
});

scriptsRouter.put('/:id/script', async (request, response) => {
  await loadTest(request.params.id);
  const code = typeof request.body?.code === 'string' ? request.body.code : '';
  if (!code.trim()) throw badRequest('The script is empty.');

  const test = await saveCode(request.params.id, code, 'edited');
  response.json(test);
});

// --- Generation -------------------------------------------------------------

scriptsRouter.post('/:id/generate', async (request, response) => {
  const test = await loadTest(request.params.id);

  if (test.steps.length === 0) {
    throw badRequest('Add at least one step before generating - the steps are the instructions.');
  }
  if (!test.url) {
    throw badRequest('This test has no URL. Set one on the test, or a base URL on the suite.');
  }

  const suiteName = str(request.body?.suiteName, 120);
  const result = await agents.generate({
    testName: test.name,
    description: test.description,
    url: test.url,
    suiteName,
    includeAda: test.includeAda,
    steps: withData(test),
    dataFields: test.dataFields,
  });

  const saved = await saveCode(test.id, result.code, 'generated');
  response.json({ ...saved, code: result.code, reply: result.reply, model: result.model });
});

/**
 * Every other agent call: refine with an instruction, improve toward a goal,
 * deepen the accessibility coverage, or fix the last failure.
 *
 * The result is returned unsaved unless the caller asks for it, so the user can
 * read a diff before committing to it.
 */
scriptsRouter.post('/:id/agent/:action', async (request, response) => {
  const action = request.params.action;
  if (!REFINERS.has(action)) {
    throw new ApiError(404, `Unknown agent action "${action}".`);
  }

  const test = await loadTest(request.params.id);
  // The editor buffer wins over what is on disk - the user may be refining an
  // edit they have not saved yet.
  const code = typeof request.body?.code === 'string' && request.body.code.trim()
    ? request.body.code
    : await readCode(test);

  if (!code.trim()) throw badRequest('There is no script yet. Generate one first.');

  let result;
  if (action === 'refine') {
    const instruction = str(request.body?.instruction, 4000);
    if (!instruction) throw badRequest('Describe the change you want.');
    result = await agents.refine({
      code,
      instruction,
      url: test.url,
      history: Array.isArray(request.body?.history) ? request.body.history.slice(-8) : [],
    });
  } else if (action === 'improve') {
    result = await agents.improve({
      code,
      goal: str(request.body?.goal, 60) || 'stability',
      url: test.url,
    });
  } else if (action === 'ada') {
    result = await agents.ada({ code, url: test.url });
  } else {
    const latest = (await runStore.read())
      .filter((run) => run.testId === test.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

    const failure = renderFailure(latest);
    if (!failure) throw badRequest('There is no failing run to fix. Run the test first.');
    result = await agents.fix({ code, failure, url: test.url });
  }

  const save = request.body?.save === true;
  const saved = save ? await saveCode(test.id, result.code, 'refined') : test;

  response.json({ ...saved, code: result.code, reply: result.reply, model: result.model, saved: save });
});

/**
 * The plain-English reading of the current script.
 *
 * Distinct from the authored steps: this is what the script actually does, which
 * after a few refinements is not always what was originally written down.
 */
scriptsRouter.post('/:id/derived-steps', async (request, response) => {
  const test = await loadTest(request.params.id);
  const code = typeof request.body?.code === 'string' && request.body.code.trim()
    ? request.body.code
    : await readCode(test);

  if (!code.trim()) {
    response.json({ steps: [] });
    return;
  }
  response.json(await agents.extractSteps({ code }));
});
