import { route, json, noContent, body } from '@/server/http';
import { deleteTest } from '@/server/domain';
import { suites as suiteStore, tests as testStore } from '@/server/store/index';
import type { Suite } from '@/server/types';
import { notFound, nowIso, str } from '@/server/util/misc';
import { latestRuns, summarise } from '@/server/summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>(async (_request, { id }) => {
  const suite = await suiteStore.find((row) => row.id === id);
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

  return json({ ...summarise(suite, tests, latest), tests: own });
});

export const PATCH = route<Params>(async (request, { id }) => {
  const payload = await body(request);

  const updated = await suiteStore.update((rows) => {
    const suite = rows.find((row) => row.id === id);
    if (!suite) return { rows, result: null };

    const next: Suite = {
      ...suite,
      name: payload.name !== undefined ? str(payload.name, 120) || suite.name : suite.name,
      description:
        payload.description !== undefined ? str(payload.description, 2000) : suite.description,
      baseUrl: payload.baseUrl !== undefined ? str(payload.baseUrl, 500) : suite.baseUrl,
      updatedAt: nowIso(),
    };
    return { rows: rows.map((row) => (row.id === next.id ? next : row)), result: next };
  });

  if (!updated) throw notFound('Suite');
  return json(updated);
});

export const DELETE = route<Params>(async (_request, { id }) => {
  const suite = await suiteStore.find((row) => row.id === id);
  if (!suite) throw notFound('Suite');

  // Deleting the suite has to take its tests with it, or their scripts and runs
  // are stranded in storage with nothing left pointing at them.
  const owned = (await testStore.read()).filter((test) => test.suiteId === suite.id);
  for (const test of owned) await deleteTest(test.id);

  await suiteStore.update((rows) => ({
    rows: rows.filter((row) => row.id !== suite.id),
    result: null,
  }));
  return noContent();
});
