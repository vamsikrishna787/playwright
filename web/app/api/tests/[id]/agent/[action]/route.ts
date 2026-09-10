/**
 * Every agent call that takes an existing script and hands back a changed one:
 * refine with an instruction, improve toward a goal, deepen the accessibility
 * coverage, or fix the last failure.
 *
 * The result comes back unsaved unless the caller asks for it, so the user can
 * read what changed before it replaces what is saved.
 */
import { route, json, body } from '@/server/http';
import { loadTest } from '@/server/domain';
import { renderFailure, saveCode } from '@/server/scripts';
import { agents } from '@/server/services/agentClient';
import { readSpec } from '@/server/services/specs';
import { runs as runStore } from '@/server/store/index';
import { ApiError, badRequest, str } from '@/server/util/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Actions this route accepts. Anything else is a 404, not a model call. */
const REFINERS = new Set(['refine', 'improve', 'ada', 'fix']);

type Params = { id: string; action: string };

export const POST = route<Params>(async (request, { id, action }) => {
  if (!REFINERS.has(action)) {
    throw new ApiError(404, `Unknown agent action "${action}".`);
  }

  const test = await loadTest(id);
  const payload = await body(request);

  // The editor buffer wins over what is saved — the user may be refining an
  // edit they have not saved yet.
  const code =
    typeof payload.code === 'string' && payload.code.trim()
      ? payload.code
      : await readSpec(test.id);

  if (!code.trim()) throw badRequest('There is no script yet. Generate one first.');

  let result;
  if (action === 'refine') {
    const instruction = str(payload.instruction, 4000);
    if (!instruction) throw badRequest('Describe the change you want.');
    result = await agents.refine({
      code,
      instruction,
      url: test.url,
      history: Array.isArray(payload.history) ? payload.history.slice(-8) : [],
    });
  } else if (action === 'improve') {
    result = await agents.improve({
      code,
      goal: str(payload.goal, 60) || 'stability',
      url: test.url,
    });
  } else if (action === 'ada') {
    result = await agents.ada({ code, url: test.url });
  } else {
    const latest = (await runStore.read())
      .filter((run) => run.testId === test.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

    const failure = renderFailure(latest);
    if (!failure) throw badRequest('There is no failing run to fix. Run the test first.');
    result = await agents.fix({ code, failure, url: test.url });
  }

  const save = payload.save === true;
  const saved = save ? await saveCode(test.id, result.code, 'refined') : test;

  return json({
    ...saved,
    code: result.code,
    reply: result.reply,
    model: result.model,
    saved: save,
  });
});
