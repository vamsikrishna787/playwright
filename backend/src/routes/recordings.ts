import { Router } from 'express';
import { GenerationError, generateAndSaveScript } from '../services/generator.js';
import {
  discardSession,
  getSession,
  startRecording,
  stopRecording,
} from '../services/recorder.js';
import type { RecordingSession } from '../services/recorder.js';

export const recordingsRouter: Router = Router();

/** Page reports are large; the UI only needs a summary per captured page. */
function summarise(session: RecordingSession) {
  return {
    id: session.id,
    startUrl: session.startUrl,
    status: session.status,
    error: session.error,
    startedAt: session.startedAt,
    pages: session.pages.map((page) => ({
      url: page.url,
      title: page.title,
      elementCount: page.elements.length,
      axeCount: page.axe.length,
    })),
  };
}

recordingsRouter.post('/', async (req, res) => {
  const { url } = req.body ?? {};
  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'A starting URL is required.' });
  }

  try {
    const session = await startRecording(url.trim());
    res.status(201).json(summarise(session));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

recordingsRouter.get('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Recording not found.' });
  res.json(summarise(session));
});

recordingsRouter.post('/:id/stop', async (req, res) => {
  const session = await stopRecording(req.params.id);
  if (!session) return res.status(404).json({ error: 'Recording not found.' });
  res.json(summarise(session));
});

recordingsRouter.post('/:id/generate', async (req, res) => {
  const { prompt, name } = req.body ?? {};
  const session = getSession(req.params.id);

  if (!session) return res.status(404).json({ error: 'Recording not found.' });
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Describe what the test should verify.' });
  }
  if (session.pages.length === 0) {
    return res.status(400).json({ error: 'This recording captured no pages.' });
  }

  // Stop first so the browser closes and the page list stops moving.
  await stopRecording(session.id);

  try {
    const script = await generateAndSaveScript({
      url: session.startUrl,
      prompt: prompt.trim(),
      name: typeof name === 'string' ? name : undefined,
      journey: session.pages,
    });
    discardSession(session.id);
    res.status(201).json(script);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(err instanceof GenerationError ? 502 : 500).json({ error: message });
  }
});

recordingsRouter.delete('/:id', async (req, res) => {
  await stopRecording(req.params.id);
  discardSession(req.params.id);
  res.status(204).end();
});
