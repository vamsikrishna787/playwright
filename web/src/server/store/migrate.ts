/**
 * Moving test data from the test up to the suite.
 *
 * Data used to be owned by each test. It is now a shared suite-level pool, so
 * every test under a suite can reference the same login instead of retyping it.
 * This runs once at startup and is a no-op afterwards.
 *
 * The delicate part is identity: steps reference fields by id, so ids have to
 * survive the move. Where two tests in one suite both had a field of the same
 * name, only the first can be kept — the pool is keyed by name, since the name
 * becomes an object key in the generated script — and every step pointing at
 * the discarded twin is repointed at the survivor. Dropping those links instead
 * would silently unhook data from steps that still need it.
 */
import type { DataField, Suite, TestCase } from '../types';
import { suites as suiteStore, tests as testStore } from './index';

/** A test as it was written before the move. */
type LegacyTest = TestCase & { dataFields?: DataField[] };

export async function hoistDataToSuites(): Promise<void> {
  const tests = (await testStore.read()) as LegacyTest[];
  const carrying = tests.filter((test) => Array.isArray(test.dataFields) && test.dataFields.length);

  // Nothing to move, and nothing left over from a half-finished earlier attempt.
  if (carrying.length === 0 && !tests.some((test) => 'dataFields' in test)) return;

  const suites = await suiteStore.read();

  /** Per suite: the pool being built, and old id -> kept id for repointing. */
  const pools = new Map<string, { fields: DataField[]; byName: Map<string, string> }>();
  const remap = new Map<string, string>();

  for (const suite of suites) {
    pools.set(suite.id, {
      // Anything already on the suite wins: it is the newer source of truth.
      fields: [...(suite.dataFields ?? [])],
      byName: new Map((suite.dataFields ?? []).map((f) => [f.name.toLowerCase(), f.id])),
    });
  }

  // Oldest test first, so which duplicate survives is stable rather than
  // dependent on how the file happened to be ordered.
  for (const test of [...carrying].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const pool = pools.get(test.suiteId);
    if (!pool) continue;

    for (const field of test.dataFields ?? []) {
      const key = field.name.trim().toLowerCase();
      if (!key) continue;

      const existing = pool.byName.get(key);
      if (existing) {
        if (existing !== field.id) remap.set(field.id, existing);
        continue;
      }
      pool.fields.push(field);
      pool.byName.set(key, field.id);
    }
  }

  await suiteStore.update((rows) => ({
    rows: rows.map((suite: Suite) => ({
      ...suite,
      dataFields: pools.get(suite.id)?.fields ?? suite.dataFields ?? [],
    })),
    result: null,
  }));

  await testStore.update((rows) => ({
    rows: (rows as LegacyTest[]).map((test) => {
      const { dataFields: _moved, ...rest } = test;
      return {
        ...rest,
        steps: test.steps.map((step) => ({
          ...step,
          dataFieldIds: [
            ...new Set(step.dataFieldIds.map((id) => remap.get(id) ?? id)),
          ],
        })),
      };
    }),
    result: null,
  }));

  const moved = [...pools.values()].reduce((total, pool) => total + pool.fields.length, 0);
  console.log(
    `[migrate] test data is now suite-level: ${moved} field(s) across ${pools.size} suite(s)` +
      (remap.size ? `, ${remap.size} duplicate reference(s) repointed` : ''),
  );
}
