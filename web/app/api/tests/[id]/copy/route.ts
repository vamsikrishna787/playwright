/** Duplicates a test, script included — the fastest way to a variant. */
import { route, json, body } from '@/server/http';
import { loadTest } from '@/server/domain';
import { copySpec } from '@/server/services/specs';
import { keys } from '@/server/paths';
import { tests as testStore } from '@/server/store/index';
import { newId, nowIso, str } from '@/server/util/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const POST = route<Params>(async (request, { id }) => {
  const source = await loadTest(id);
  const payload = await body(request);

  const copy = {
    ...structuredClone(source),
    id: newId(),
    name: str(payload.name, 160) || `${source.name} (copy)`,
    lastRunId: null,
    lastRunStatus: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  if (await copySpec(source.id, copy.id)) {
    copy.scriptPath = keys.spec(copy.id);
    copy.scriptUpdatedAt = nowIso();
  } else {
    copy.scriptPath = null;
    copy.scriptUpdatedAt = null;
  }

  await testStore.update((rows) => ({ rows: [...rows, copy], result: null }));
  return json(copy, 201);
});
