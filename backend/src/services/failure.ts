import { FAILURE_MAX_CHARS } from '../config.js';
import type { RunRecord } from '../types.js';
import { runsStore } from './storage.js';

/**
 * The run to explain to the model: a specific one when the UI names it,
 * otherwise the most recent finished run for the script.
 */
export async function findRun(scriptId: string, runId?: string): Promise<RunRecord | undefined> {
  const runs = (await runsStore.read()).filter((r) => r.scriptId === scriptId);
  if (runId) return runs.find((r) => r.id === runId);

  return runs
    .filter((r) => r.status !== 'queued' && r.status !== 'running')
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
}

function trim(text: string, max: number): string {
  const clean = text.replace(/\r\n/g, '\n').trim();
  return clean.length > max ? `${clean.slice(0, max)}\n... [truncated]` : clean;
}

/**
 * Renders a failed run as the evidence the model needs to fix the file: which
 * test broke, the error Playwright reported, and how far the steps got before
 * it stopped. The step trace matters as much as the message — an error on step
 * one is a bad locator, the same error on step four is usually a missing wait
 * or a page that never appeared.
 *
 * Returns undefined for a run that passed; there is nothing to fix.
 */
export function formatFailure(run: RunRecord): string | undefined {
  if (run.status !== 'failed' && run.status !== 'error') return undefined;

  const lines: string[] = [
    `Result: ${run.status.toUpperCase()}${run.finishedAt ? ` at ${run.finishedAt}` : ''}`,
  ];

  // An 'error' run never produced a report — the file failed to compile or
  // Playwright itself refused to start, so run.error is all there is.
  if (run.tests.length === 0) {
    lines.push('', 'The test file did not run at all. Playwright reported:', run.error ?? 'no output');
    return trim(lines.join('\n'), FAILURE_MAX_CHARS);
  }

  for (const test of run.tests) {
    lines.push('', `${test.status === 'passed' ? 'PASSED' : 'FAILED'}: ${test.title}`);
    if (test.status === 'passed') continue;

    if (test.error) lines.push('Error:', test.error);

    if (test.steps.length) {
      lines.push('Steps, in order — the last one reached is where it stopped:');
      for (const step of test.steps) {
        lines.push(`  ${step.error ? 'x' : 'v'} ${step.title} (${step.durationMs}ms)`);
        if (step.error) lines.push(`      ${step.error.split('\n')[0]}`);
      }
    }
  }

  return trim(lines.join('\n'), FAILURE_MAX_CHARS);
}
