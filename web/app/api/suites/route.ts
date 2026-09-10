/**
 * Suites: the unit the home page lists and the unit "run everything" acts on.
 */
import { route, json, body } from '@/server/http';
import { suites as suiteStore, tests as testStore } from '@/server/store/index';
import type { Suite } from '@/server/types';
import { badRequest, newId, nowIso, str } from '@/server/util/misc';
import { latestRuns, summarise } from '@/server/summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const [rows, tests, latest] = await Promise.all([
    suiteStore.read(),
    testStore.read(),
    latestRuns(),
  ]);
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  return json(sorted.map((suite) => summarise(suite, tests, latest)));
});

export const POST = route(async (request) => {
  const payload = await body(request);
  const name = str(payload.name, 120);
  if (!name) throw badRequest('A suite needs a name.');

  const suite: Suite = {
    id: newId(),
    name,
    description: str(payload.description, 2000),
    baseUrl: str(payload.baseUrl, 500),
    dataFields: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await suiteStore.update((rows) => ({ rows: [...rows, suite], result: null }));
  return json(suite, 201);
});
