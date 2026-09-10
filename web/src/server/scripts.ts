/**
 * The script half of a test: what the agent tier is told, and what is done with
 * what it hands back.
 *
 * No prompt lives here. This layer assembles the facts — the steps the user
 * wrote, the data fields they named, the failure the last run produced — and the
 * Python tier decides what to say to the model. That split is the whole point of
 * the third tier: swapping models or prompts never touches this file.
 */
import { patchTest } from './domain';
import { writeSpec } from './services/specs';
import type { DataField, Run, TestCase } from './types';
import { nowIso, stripAnsi } from './util/misc';

/**
 * Saves the spec and records where it came from.
 *
 * `origin` is what the UI badges: a script the model wrote and a script a human
 * edited afterwards deserve different amounts of trust.
 */
export async function saveCode(
  testId: string,
  code: string,
  origin: TestCase['scriptOrigin'],
): Promise<TestCase> {
  const key = await writeSpec(testId, code);

  return patchTest(testId, (current) => ({
    ...current,
    scriptPath: key,
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
export function renderFailure(run: Run | undefined): string {
  if (!run || (run.status !== 'failed' && run.status !== 'error')) return '';

  const lines: string[] = [`Run status: ${run.status}`];
  if (run.error) lines.push('', stripAnsi(run.error));

  for (const test of run.tests.filter((entry) => entry.status === 'failed')) {
    lines.push(
      '',
      `FAILED TEST: ${test.title}`,
      test.error ? stripAnsi(test.error) : '(no message)',
    );
  }
  for (const step of run.steps.filter((entry) => entry.status === 'failed' && entry.error)) {
    lines.push('', `FAILED STEP ${step.index}: ${step.title}`, stripAnsi(step.error ?? ''));
  }

  return lines.join('\n').slice(0, 6000);
}

/**
 * Steps with their data fields resolved, which is the shape the agent expects.
 *
 * The fields come from the suite's shared pool, so `pool` is passed in rather
 * than read off the test.
 */
export function withData(test: TestCase, pool: DataField[]) {
  const byId = new Map(pool.map((field) => [field.id, field]));
  return test.steps.map((step) => ({
    index: step.index,
    action: step.action,
    expected: step.expected,
    data: step.dataFieldIds
      .map((id) => byId.get(id))
      .filter((field): field is DataField => field !== undefined),
  }));
}

/**
 * Only the fields this test actually uses.
 *
 * A suite's pool covers every test under it, and handing the model all of it
 * would put a dozen irrelevant values in the generated `data` const and invite
 * it to use one of them. The script gets what its own steps reference.
 */
export function usedFields(test: TestCase, pool: DataField[]): DataField[] {
  const used = new Set(test.steps.flatMap((step) => step.dataFieldIds));
  return pool.filter((field) => used.has(field.id));
}
