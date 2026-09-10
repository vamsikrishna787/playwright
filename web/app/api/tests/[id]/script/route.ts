import { route, json, body } from '@/server/http';
import { loadTest } from '@/server/domain';
import { saveCode } from '@/server/scripts';
import { readSpec } from '@/server/services/specs';
import { badRequest } from '@/server/util/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>(async (_request, { id }) => {
  const test = await loadTest(id);
  return json({ code: await readSpec(test.id), updatedAt: test.scriptUpdatedAt });
});

export const PUT = route<Params>(async (request, { id }) => {
  await loadTest(id);
  const payload = await body(request);
  const code = typeof payload.code === 'string' ? payload.code : '';
  if (!code.trim()) throw badRequest('The script is empty.');

  return json(await saveCode(id, code, 'edited'));
});
