/** Latest run per test, keyed by test id — one call to badge a whole list. */
import { route, json } from '@/server/http';
import { runs as runStore } from '@/server/store/index';
import type { Run } from '@/server/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const rows = await runStore.read();
  const latest: Record<string, Run> = {};
  for (const run of rows) {
    const held = latest[run.testId];
    if (!held || run.startedAt > held.startedAt) latest[run.testId] = run;
  }
  return json(latest);
});
