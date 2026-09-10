import { runs as runStore } from './store/index';
import type { Run } from './types';
import { notFound } from './util/misc';

export async function loadRun(id: string): Promise<Run> {
  const run = await runStore.find((row) => row.id === id);
  if (!run) throw notFound('Run');
  return run;
}

/**
 * The directory a run's artifacts were published under.
 *
 * Derived from the report key rather than rebuilt from ids, so a record written
 * by an older layout still resolves to wherever its files actually went.
 */
export function runPrefix(run: Run): string | null {
  if (!run.reportPath) return null;
  const cut = run.reportPath.lastIndexOf('/');
  return cut === -1 ? null : run.reportPath.slice(0, cut);
}
