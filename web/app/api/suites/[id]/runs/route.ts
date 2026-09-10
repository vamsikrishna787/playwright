/** Runs every test in the suite that has a script. */
import { route, json } from '@/server/http';
import { startRun } from '@/server/services/runner';
import { suites as suiteStore, tests as testStore } from '@/server/store/index';
import { ApiError, notFound } from '@/server/util/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const POST = route<Params>(async (_request, { id }) => {
  const suite = await suiteStore.find((row) => row.id === id);
  if (!suite) throw notFound('Suite');

  const runnable = (await testStore.read()).filter(
    (test) => test.suiteId === suite.id && test.scriptPath,
  );
  if (runnable.length === 0) {
    throw new ApiError(400, 'No test in this suite has a script yet. Generate one first.');
  }

  // Started in order; the runner's own limit decides how many actually go at once.
  const started = [];
  for (const test of runnable) started.push(await startRun(test));
  return json(started, 202);
});
