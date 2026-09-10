/**
 * The plain-English reading of the current script.
 *
 * Distinct from the authored steps: this is what the script actually does, which
 * after a few refinements is not always what was originally written down.
 */
import { route, json, body } from '@/server/http';
import { loadTest } from '@/server/domain';
import { agents } from '@/server/services/agentClient';
import { readSpec } from '@/server/services/specs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Params = { id: string };

export const POST = route<Params>(async (request, { id }) => {
  const test = await loadTest(id);
  const payload = await body(request);

  const code =
    typeof payload.code === 'string' && payload.code.trim()
      ? payload.code
      : await readSpec(test.id);

  if (!code.trim()) return json({ steps: [] });
  return json(await agents.extractSteps({ code }));
});
