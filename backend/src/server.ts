/**
 * The orchestration tier.
 *
 * Owns the disk (suites, tests, specs, run artifacts) and the browsers. Calls
 * the Python agent API for anything that needs a model, and nothing else.
 */
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AGENT_API_URL, MAX_BODY, PORT } from './config.js';
import { runsRouter } from './routes/runs.js';
import { scriptsRouter } from './routes/scripts.js';
import { suitesRouter } from './routes/suites.js';
import { testsRouter } from './routes/tests.js';
import { agents } from './services/agentClient.js';
import { ensureDirs } from './store/index.js';
import { hoistDataToSuites } from './store/migrate.js';
import { ApiError } from './util/misc.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: MAX_BODY }));

app.get('/api/health', async (_request, response) => {
  // Reports the agent tier too: "generate does nothing" is nearly always the
  // Python process not being up, and this is the cheapest way to see that.
  const catalog = await agents.catalog();
  response.json({
    ok: true,
    agentApi: { url: AGENT_API_URL, reachable: catalog.length > 0, actions: catalog.length },
  });
});

/** Drives the UI's action buttons, so a new Python agent needs no UI change. */
app.get('/api/agents/catalog', async (_request, response) => {
  response.json({ actions: await agents.catalog() });
});

app.use('/api/suites', suitesRouter);
// Two routers on one path: identity/data/steps in one file, script and AI in
// the other. Express falls through from the first to the second.
app.use('/api/tests', testsRouter);
app.use('/api/tests', scriptsRouter);
app.use('/api/runs', runsRouter);

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'No such endpoint.' });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  console.error('[api]', error);
  response.status(500).json({ error: message });
});

await ensureDirs();
// Test data used to live on each test; it is a suite-level pool now.
await hoistDataToSuites();

app.listen(PORT, () => {
  console.log(`[api]    http://localhost:${PORT}`);
  console.log(`[agents] ${AGENT_API_URL}`);
});
