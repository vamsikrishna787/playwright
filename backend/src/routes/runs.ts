/**
 * Runs: the record, the live stream, and the artifacts a run leaves behind.
 */
import { type Response } from 'express';
import { asyncRouter } from '../util/asyncRouter.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKEND_ROOT } from '../config.js';
import { subscribe } from '../services/events.js';
import { runs as runStore } from '../store/index.js';
import type { Run } from '../types.js';
import { exists } from '../util/fsx.js';
import { notFound } from '../util/misc.js';

export const runsRouter = asyncRouter();

async function load(id: string): Promise<Run> {
  const run = await runStore.find((row) => row.id === id);
  if (!run) throw notFound('Run');
  return run;
}

/** Latest run per test, keyed by test id - one call to badge a whole list. */
runsRouter.get('/latest', async (_request, response) => {
  const rows = await runStore.read();
  const latest: Record<string, Run> = {};
  for (const run of rows) {
    const held = latest[run.testId];
    if (!held || run.startedAt > held.startedAt) latest[run.testId] = run;
  }
  response.json(latest);
});

runsRouter.get('/:id', async (request, response) => {
  response.json(await load(request.params.id));
});

/**
 * Server-sent events for one run.
 *
 * Chosen over polling because the interesting information is which step is
 * running *right now* - a two-second poll would miss most of them on a fast
 * spec. The current state is sent immediately on connect, so a client that
 * subscribes late still renders correctly, and a finished run closes the stream
 * rather than holding a socket open forever.
 */
runsRouter.get('/:id/events', async (request, response) => {
  const run = await load(request.params.id);

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and friends buffer by default, which would defeat the whole thing.
    'X-Accel-Buffering': 'no',
  });

  const send = (payload: Run) => {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (payload.status === 'passed' || payload.status === 'failed' || payload.status === 'error') {
      // Hold the socket open just long enough for the Lighthouse result, which
      // lands after the verdict.
      if (payload.lighthouse?.status !== 'running') {
        clearInterval(heartbeat);
        unsubscribe();
        response.end();
      }
    }
  };

  const unsubscribe = subscribe(run.id, send);
  // Proxies drop an idle connection; a comment frame is not an event.
  const heartbeat = setInterval(() => response.write(': ping\n\n'), 15_000);

  request.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  send(run);
});

// --- Artifacts --------------------------------------------------------------

/**
 * Serves a file a run produced.
 *
 * The stored paths are backend-root-relative and written by this process, but
 * they still get resolved and re-checked against the root: a path traversal
 * through a stored value is exactly the kind of thing that stops being true
 * after someone hand-edits runs.json.
 */
async function sendArtifact(
  relative: string | null | undefined,
  contentType: string,
  response: Response,
  missing: string,
): Promise<void> {
  if (!relative) throw notFound(missing);

  const absolute = path.resolve(BACKEND_ROOT, relative);
  if (!absolute.startsWith(BACKEND_ROOT + path.sep)) throw notFound(missing);
  if (!(await exists(absolute))) throw notFound(missing);

  response.setHeader('Content-Type', contentType);
  response.sendFile(absolute);
}

runsRouter.get('/:id/video', async (request, response) => {
  const run = await load(request.params.id);
  await sendArtifact(run.videoPath, 'video/webm', response, 'Video');
});

runsRouter.get('/:id/report', async (request, response) => {
  const run = await load(request.params.id);
  // The Playwright HTML report sits next to the JSON one this path points at.
  const html = run.reportPath ? path.join(path.dirname(run.reportPath), 'html', 'index.html') : null;
  await sendArtifact(html, 'text/html', response, 'Report');
});

runsRouter.get('/:id/lighthouse', async (request, response) => {
  const run = await load(request.params.id);
  await sendArtifact(run.lighthouse?.reportPath, 'text/html', response, 'Lighthouse report');
});

/** The raw Playwright JSON, for anyone who wants the unabridged version. */
runsRouter.get('/:id/report.json', async (request, response) => {
  const run = await load(request.params.id);
  if (!run.reportPath) throw notFound('Report');
  const absolute = path.resolve(BACKEND_ROOT, run.reportPath);
  if (!absolute.startsWith(BACKEND_ROOT + path.sep) || !(await exists(absolute))) {
    throw notFound('Report');
  }
  response.type('application/json').send(await fs.readFile(absolute, 'utf8'));
});
