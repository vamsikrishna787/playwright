/**
 * The authored steps.
 *
 * Test data itself is owned by the suite — see PUT /api/suites/[id]/data. A step
 * may only reference a field that exists in that pool, which is what the suite
 * lookup here is for.
 */
import { route, json, body } from '@/server/http';
import { loadTestWithSuite, parseSteps, patchTest } from '@/server/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const PUT = route<Params>(async (request, { id }) => {
  const { suite } = await loadTestWithSuite(id);
  const payload = await body(request);
  const steps = parseSteps(payload.steps, suite.dataFields);
  return json(await patchTest(id, (row) => ({ ...row, steps })));
});
