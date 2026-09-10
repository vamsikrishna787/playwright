import { route, json, body } from '@/server/http';
import { suites as suiteStore, tests as testStore } from '@/server/store/index';
import type { TestCase } from '@/server/types';
import { badRequest, newId, notFound, nowIso, str } from '@/server/util/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const POST = route<Params>(async (request, { id }) => {
  const suite = await suiteStore.find((row) => row.id === id);
  if (!suite) throw notFound('Suite');

  const payload = await body(request);
  const name = str(payload.name, 160);
  if (!name) throw badRequest('A test needs a name.');

  const test: TestCase = {
    id: newId(),
    suiteId: suite.id,
    name,
    description: str(payload.description, 4000),
    // Falls back to the suite's base URL, which is why one is worth setting.
    url: str(payload.url, 500) || suite.baseUrl,
    steps: [],
    scriptPath: null,
    scriptUpdatedAt: null,
    scriptOrigin: null,
    includeAda: payload.includeAda === false ? false : true,
    lastRunId: null,
    lastRunStatus: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await testStore.update((rows) => ({ rows: [...rows, test], result: null }));
  return json(test, 201);
});
