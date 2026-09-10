/**
 * Server-sent events for one run.
 *
 * Chosen over polling because the interesting information is which step is
 * running *right now* — a two-second poll would miss most of them on a fast
 * spec. The current state is sent immediately on connect, so a client that
 * subscribes late still renders correctly, and a finished run closes the stream
 * rather than holding a socket open forever.
 */
import { loadRun } from '@/server/domain-runs';
import { route } from '@/server/http';
import { subscribe } from '@/server/services/events';
import type { Run } from '@/server/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DONE = new Set(['passed', 'failed', 'error', 'cancelled']);

type Params = { id: string };

export const GET = route<Params>(async (request, { id }) => {
  const run = await loadRun(id);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener('abort', close);
        try {
          controller.close();
        } catch {
          /* already closed by the client going away */
        }
      };

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };

      const send = (payload: Run) => {
        write(`data: ${JSON.stringify(payload)}\n\n`);
        if (!DONE.has(payload.status)) return;
        // Hold the socket open just long enough for the Lighthouse result,
        // which lands after the verdict.
        if (payload.lighthouse?.status !== 'running') close();
      };

      const unsubscribe = subscribe(run.id, send);
      // Proxies drop an idle connection; a comment frame is not an event.
      const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);

      request.signal.addEventListener('abort', close);
      send(run);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer by default, which would defeat the whole thing.
      'X-Accel-Buffering': 'no',
    },
  });
});
