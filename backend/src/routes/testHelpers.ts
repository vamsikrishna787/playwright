/**
 * Shared test-record plumbing: loading, patching, and the cascade delete that
 * both the suite route and the test route need.
 */
import fs from 'node:fs/promises';
import { specFilePath } from '../config.js';
import { deleteRunsFor } from '../services/runner.js';
import { tests as testStore } from '../store/index.js';
import type { DataField, TestCase, TestStep } from '../types.js';
import { badRequest, newId, notFound, nowIso, str } from '../util/misc.js';

export async function loadTest(id: string): Promise<TestCase> {
  const test = await testStore.find((row) => row.id === id);
  if (!test) throw notFound('Test');
  return test;
}

/** Read-modify-write of one test, serialised by the store. */
export async function patchTest(
  id: string,
  mutate: (test: TestCase) => TestCase,
): Promise<TestCase> {
  const updated = await testStore.update((rows) => {
    const current = rows.find((row) => row.id === id);
    if (!current) return { rows, result: null };
    const next = { ...mutate(current), updatedAt: nowIso() };
    return { rows: rows.map((row) => (row.id === id ? next : row)), result: next };
  });

  if (!updated) throw notFound('Test');
  return updated;
}

/** Removes the record, its spec file and its whole run history. */
export async function deleteTest(id: string): Promise<void> {
  await deleteRunsFor(id);
  await fs.rm(specFilePath(id), { force: true });
  await testStore.update((rows) => ({ rows: rows.filter((row) => row.id !== id), result: null }));
}

/**
 * Normalises a posted data-field list.
 *
 * Ids are preserved when the client sends one, because steps reference fields by
 * id - reassigning them on every save would silently unlink every step.
 */
export function parseDataFields(input: unknown): DataField[] {
  if (!Array.isArray(input)) throw badRequest('Expected a list of data fields.');

  const fields: DataField[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    const name = str((raw as DataField)?.name, 80);
    if (!name) continue;

    // The name is what a step reads as `data.<name>` in the generated script, so
    // two fields sharing one would make the reference ambiguous.
    const key = name.toLowerCase();
    if (seen.has(key)) throw badRequest(`Two data fields are both named "${name}".`);
    seen.add(key);

    fields.push({
      id: str((raw as DataField)?.id, 60) || newId(),
      category: str((raw as DataField)?.category, 80) || 'General',
      name,
      value: typeof (raw as DataField)?.value === 'string' ? (raw as DataField).value : '',
      secret: (raw as DataField)?.secret === true,
    });
  }

  return fields;
}

/**
 * Normalises a posted step list and renumbers it.
 *
 * `index` is authoritative here rather than client-supplied: it is the number
 * the generated script tags its test.step() with, and the number the runner maps
 * live progress back through, so it must always be 1..n with no gaps.
 */
export function parseSteps(input: unknown, fields: DataField[]): TestStep[] {
  if (!Array.isArray(input)) throw badRequest('Expected a list of steps.');

  const validIds = new Set(fields.map((field) => field.id));

  return input
    .map((raw) => ({
      id: str((raw as TestStep)?.id, 60) || newId(),
      action: str((raw as TestStep)?.action, 2000),
      expected: str((raw as TestStep)?.expected, 2000),
      dataFieldIds: Array.isArray((raw as TestStep)?.dataFieldIds)
        ? (raw as TestStep).dataFieldIds.filter((id) => validIds.has(id))
        : [],
    }))
    .filter((step) => step.action)
    .map((step, position) => ({ ...step, index: position + 1 }));
}
