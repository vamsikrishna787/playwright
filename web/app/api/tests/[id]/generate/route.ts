/**
 * Steps + data -> a Playwright spec, via the agent tier.
 *
 * Generation is the one agent call that always saves: there is nothing to
 * compare it against, and a script the user cannot run is not a result.
 */
import { route, json, body } from '@/server/http';
import { loadTestWithSuite } from '@/server/domain';
import { saveCode, usedFields, withData } from '@/server/scripts';
import { agents } from '@/server/services/agentClient';
import { badRequest, str } from '@/server/util/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A model call can sit well past the default; the runner's own cap is separate.
export const maxDuration = 300;

type Params = { id: string };

export const POST = route<Params>(async (request, { id }) => {
  const { test, suite } = await loadTestWithSuite(id);
  const payload = await body(request);

  if (test.steps.length === 0) {
    throw badRequest('Add at least one step before generating — the steps are the instructions.');
  }
  if (!test.url) {
    throw badRequest('This test has no URL. Set one on the test, or a base URL on the suite.');
  }

  const result = await agents.generate({
    testName: test.name,
    description: test.description,
    url: test.url,
    suiteName: str(payload.suiteName, 120) || suite.name,
    includeAda: test.includeAda,
    steps: withData(test, suite.dataFields),
    dataFields: usedFields(test, suite.dataFields),
  });

  const saved = await saveCode(test.id, result.code, 'generated');
  return json({ ...saved, code: result.code, reply: result.reply, model: result.model });
});
