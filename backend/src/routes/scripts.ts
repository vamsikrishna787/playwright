import fs from 'node:fs/promises';
import { Router } from 'express';
import { RUNS_DIR, snapshotFilePath, specFilePath } from '../config.js';
import { editSpec } from '../services/bedrock.js';
import { findRun, formatFailure } from '../services/failure.js';
import { GenerationError, generateAndSaveScript } from '../services/generator.js';
import { startRun } from '../services/runner.js';
import { runsStore, scriptsStore } from '../services/storage.js';

export const scriptsRouter: Router = Router();

scriptsRouter.post('/generate', async (req, res) => {
  const { url, prompt, name } = req.body ?? {};
  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'A target URL is required.' });
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'A test scenario description is required.' });
  }

  try {
    const result = await generateAndSaveScript({
      url: url.trim(),
      prompt: prompt.trim(),
      name: typeof name === 'string' ? name : undefined,
    });
    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(err instanceof GenerationError ? 502 : 500).json({ error: message });
  }
});

scriptsRouter.post('/run-all', async (_req, res) => {
  const scripts = await scriptsStore.read();
  if (scripts.length === 0) {
    return res.status(400).json({ error: 'There are no scripts to run.' });
  }

  // Queued in list order; the runner caps how many execute at once.
  const runs = [];
  for (const script of scripts) {
    runs.push(await startRun(script.id));
  }

  res.status(202).json(runs);
});

scriptsRouter.get('/', async (_req, res) => {
  res.json(await scriptsStore.read());
});

scriptsRouter.get('/:id', async (req, res) => {
  const script = (await scriptsStore.read()).find((s) => s.id === req.params.id);
  if (!script) return res.status(404).json({ error: 'Script not found.' });

  const code = await fs.readFile(specFilePath(script.id), 'utf-8').catch(() => '');
  res.json({ ...script, code });
});

scriptsRouter.put('/:id', async (req, res) => {
  const { name, code } = req.body ?? {};
  const script = (await scriptsStore.read()).find((s) => s.id === req.params.id);
  if (!script) return res.status(404).json({ error: 'Script not found.' });

  if (typeof code === 'string') {
    await fs.writeFile(specFilePath(script.id), code, 'utf-8');
  }

  const updated = await scriptsStore.update((scripts) =>
    scripts.map((s) =>
      s.id === script.id
        ? {
            ...s,
            name: typeof name === 'string' && name.trim() ? name.trim() : s.name,
            updatedAt: new Date().toISOString(),
          }
        : s,
    ),
  );

  res.json(updated.find((s) => s.id === script.id));
});

scriptsRouter.post('/:id/enhance', async (req, res) => {
  const { instruction, code, history, runId } = req.body ?? {};
  if (typeof instruction !== 'string' || !instruction.trim()) {
    return res.status(400).json({ error: 'Describe the change you want.' });
  }

  const script = (await scriptsStore.read()).find((s) => s.id === req.params.id);
  if (!script) return res.status(404).json({ error: 'Script not found.' });

  // Prefer the editor's current buffer over what's on disk — the user may have
  // unsaved edits they expect the assistant to build on.
  const current =
    typeof code === 'string' && code.trim()
      ? code
      : await fs.readFile(specFilePath(script.id), 'utf-8').catch(() => '');

  const snapshot = await fs
    .readFile(snapshotFilePath(script.id), 'utf-8')
    .catch(() => undefined);

  // Attached unprompted: when the last run is red, "fix the login step" should
  // reach the model already carrying the reason it went red. A specific runId
  // from the UI wins, so a user can point at an older failure.
  const run = await findRun(script.id, typeof runId === 'string' ? runId : undefined);
  const failure = run ? formatFailure(run) : undefined;

  try {
    const result = await editSpec({
      code: current,
      instruction: instruction.trim(),
      sourceUrl: script.sourceUrl,
      snapshot,
      failure,
      history: Array.isArray(history) ? history.slice(-8) : [],
    });
    res.json({ ...result, usedFailure: Boolean(failure) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

scriptsRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const script = (await scriptsStore.read()).find((s) => s.id === id);
  if (!script) return res.status(404).json({ error: 'Script not found.' });

  await fs.rm(specFilePath(id), { force: true });
  await fs.rm(snapshotFilePath(id), { force: true });
  await fs.rm(`${RUNS_DIR}/${id}`, { recursive: true, force: true });
  await scriptsStore.update((scripts) => scripts.filter((s) => s.id !== id));
  await runsStore.update((runs) => runs.filter((r) => r.scriptId !== id));

  res.status(204).end();
});

scriptsRouter.get('/:id/runs', async (req, res) => {
  const runs = (await runsStore.read()).filter((r) => r.scriptId === req.params.id);
  res.json(runs);
});

scriptsRouter.post('/:id/runs', async (req, res) => {
  const script = (await scriptsStore.read()).find((s) => s.id === req.params.id);
  if (!script) return res.status(404).json({ error: 'Script not found.' });

  const run = await startRun(script.id);
  res.status(202).json(run);
});
