import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { RunRecord } from '../types';

export function usePollRun(runId: string | undefined) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Clearing the id must clear the result too, or callers that unset it
    // (e.g. dismissing the inline panel) keep rendering the stale run.
    if (!runId) {
      setRun(null);
      setError(null);
      return;
    }

    let cancelled = false;
    let timer: number;

    const tick = async () => {
      try {
        const next = await api.getRun(runId);
        if (cancelled) return;
        setRun(next);
        // The Lighthouse audit outlives the test's own verdict by some way, so
        // polling has to follow the slower of the two or its panel never fills in.
        const auditing =
          next.lighthouse?.status === 'queued' || next.lighthouse?.status === 'running';
        if (next.status === 'queued' || next.status === 'running' || auditing) {
          timer = window.setTimeout(tick, 2000);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };

    setRun(null);
    setError(null);
    tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runId]);

  return { run, error };
}
