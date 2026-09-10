/**
 * The suite's shared data pool.
 *
 * Deleting a field has to reach into every test in the suite: a step still
 * pointing at it would generate a reference to nothing. That cascade is why
 * this is a suite route rather than a plain field patch.
 */
import { route, json, body } from '@/server/http';
import { parseDataFields } from '@/server/domain';
import { suites as suiteStore, tests as testStore } from '@/server/store/index';
import { notFound, nowIso } from '@/server/util/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const PUT = route<Params>(async (request, { id }) => {
  const suite = await suiteStore.find((row) => row.id === id);
  if (!suite) throw notFound('Suite');

  const payload = await body(request);
  const fields = parseDataFields(payload.dataFields);
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
              dataFieldIds: step.dataFieldIds.filter((fieldId) => kept.has(fieldId)),
            })),
          }
        : test,
    ),
    result: null,
  }));

  return json(updated);
});
