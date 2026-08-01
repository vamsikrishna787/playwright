import path from 'node:path';
import { Router } from 'express';
import { BACKEND_ROOT } from '../config.js';
import { runsStore } from '../services/storage.js';
import type { RunRecord } from '../types.js';

export const runsRouter: Router = Router();

// Must precede /:runId, or Express matches "latest" as a run id.
runsRouter.get('/latest', async (_req, res) => {
  const runs = await runsStore.read();

  // runs.json is newest-first, so the first hit per script is its latest run.
  const latest: Record<string, RunRecord> = {};
  for (const run of runs) {
    if (!latest[run.scriptId]) latest[run.scriptId] = run;
  }

  res.json(latest);
});

runsRouter.get('/:runId', async (req, res) => {
  const run = (await runsStore.read()).find((r) => r.id === req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  res.json(run);
});

runsRouter.get('/:runId/video', async (req, res) => {
  const run = (await runsStore.read()).find((r) => r.id === req.params.runId);
  if (!run?.videoPath) return res.status(404).json({ error: 'No video for this run.' });

  res.type('video/webm');
  res.sendFile(path.join(BACKEND_ROOT, run.videoPath));
});

runsRouter.get('/:runId/report', async (req, res) => {
  const run = (await runsStore.read()).find((r) => r.id === req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found.' });

  res.type('application/json');
  res.sendFile(path.join(BACKEND_ROOT, run.reportPath), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'No report for this run.' });
  });
});
