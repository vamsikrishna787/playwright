import fs from 'node:fs/promises';
import { DATA_DIR, RUNS_DIR, RUNS_JSON, SCRIPTS_DIR, SUITES_JSON, TESTS_JSON } from '../config.js';
import type { Run, Suite, TestCase } from '../types.js';
import { JsonStore } from './jsonStore.js';

export const suites = new JsonStore<Suite>(SUITES_JSON);
export const tests = new JsonStore<TestCase>(TESTS_JSON);
export const runs = new JsonStore<Run>(RUNS_JSON);

export async function ensureDirs(): Promise<void> {
  await Promise.all(
    [DATA_DIR, SCRIPTS_DIR, RUNS_DIR].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
}

/** Applies a patch to one run in place, leaving the rest untouched. */
export function patchRun(rows: Run[], runId: string, patch: Partial<Run>): Run[] {
  return rows.map((row) => (row.id === runId ? { ...row, ...patch } : row));
}
