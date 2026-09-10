/**
 * The counts a list view shows without opening anything.
 *
 * Shared by the suite list and the single-suite view, which need the same
 * numbers computed the same way.
 */
import { runs as runStore } from './store/index';
import type { Run, Suite, TestCase } from './types';

/** Most recent run per test, so a list render costs one pass over the index. */
export async function latestRuns(): Promise<Map<string, Run>> {
  const rows = await runStore.read();
  const latest = new Map<string, Run>();
  for (const run of rows) {
    const held = latest.get(run.testId);
    if (!held || run.startedAt > held.startedAt) latest.set(run.testId, run);
  }
  return latest;
}

export function summarise(suite: Suite, tests: TestCase[], latest: Map<string, Run>) {
  const own = tests.filter((test) => test.suiteId === suite.id);
  const statuses = own.map((test) => latest.get(test.id)?.status ?? test.lastRunStatus ?? null);

  return {
    ...suite,
    testCount: own.length,
    dataCount: suite.dataFields.length,
    scriptCount: own.filter((test) => test.scriptPath).length,
    passed: statuses.filter((status) => status === 'passed').length,
    failed: statuses.filter((status) => status === 'failed' || status === 'error').length,
    lastRunAt: own.reduce<string | null>((latestAt, test) => {
      const at = test.lastRunId ? (latest.get(test.id)?.startedAt ?? null) : null;
      return at && (!latestAt || at > latestAt) ? at : latestAt;
    }, null),
  };
}
