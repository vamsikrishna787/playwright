import { route, json } from '@/server/http';
import { loadTest } from '@/server/domain';
import { startRun } from '@/server/services/runner';
import { runs as runStore } from '@/server/store/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>(async (_request, { id }) => {
  await loadTest(id);
  const rows = await runStore.read();
  return json(
    rows
      .filter((run) => run.testId === id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  );
});

export const POST = route<Params>(async (_request, { id }) => {
  const test = await loadTest(id);
  return json(await startRun(test), 202);
});
