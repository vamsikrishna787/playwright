import { keys } from '../paths';
import type { Run, Suite, TestCase } from '../types';
import { JsonStore } from './jsonStore';

export const suites = new JsonStore<Suite>(keys.suites);
export const tests = new JsonStore<TestCase>(keys.tests);
export const runs = new JsonStore<Run>(keys.runs);

/** Applies a patch to one run in place, leaving the rest untouched. */
export function patchRun(rows: Run[], runId: string, patch: Partial<Run>): Run[] {
  return rows.map((row) => (row.id === runId ? { ...row, ...patch } : row));
}
