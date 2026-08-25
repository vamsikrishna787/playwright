import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Run } from '../types';

/**
 * Watches one run over server-sent events.
 *
 * The interesting information is which step is running *right now*, which a
 * poll interval would step straight over on a fast spec. The server closes the
 * stream once the run is finished and its Lighthouse audit has landed, so there
 * is no "are we done yet" logic here — the close is the answer.
 */
export function useRunStream(runId: string | null): { run: Run | null; live: boolean } {
  const [run, setRun] = useState<Run | null>(null);
  const [live, setLive] = useState(false);
  // Held so a late frame from a stream we have already replaced cannot win.
  const currentId = useRef<string | null>(null);

  useEffect(() => {
    currentId.current = runId;
    if (!runId) {
      setRun(null);
      setLive(false);
      return;
    }

    setRun(null);
    setLive(true);

    const source = new EventSource(api.eventsUrl(runId));

    source.onmessage = (event) => {
      if (currentId.current !== runId) return;
      try {
        setRun(JSON.parse(event.data) as Run);
      } catch {
        /* a torn frame is not worth tearing the page down over */
      }
    };

    source.onerror = () => {
      // EventSource fires this on a normal close too, so it is not treated as a
      // failure: the last frame received is the truth, and the record is always
      // readable from /api/runs/:id if this browser missed the end.
      source.close();
      setLive(false);
    };

    return () => {
      source.close();
      setLive(false);
    };
  }, [runId]);

  return { run, live };
}
