/**
 * A tiny per-run pub/sub, so the UI can watch a run advance step by step instead
 * of polling for a verdict that arrives a minute later.
 *
 * Subscribers are held per run id and dropped when the response closes; a run
 * that finishes clears its topic once every listener has had the final frame.
 */
import type { Run } from '../types.js';

type Listener = (run: Run) => void;

const topics = new Map<string, Set<Listener>>();

export function subscribe(runId: string, listener: Listener): () => void {
  const listeners = topics.get(runId) ?? new Set<Listener>();
  listeners.add(listener);
  topics.set(runId, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) topics.delete(runId);
  };
}

export function publish(run: Run): void {
  for (const listener of topics.get(run.id) ?? []) {
    // One bad listener must not stop the others being told.
    try {
      listener(run);
    } catch {
      /* ignore */
    }
  }
}

export const hasSubscribers = (runId: string) => (topics.get(runId)?.size ?? 0) > 0;
