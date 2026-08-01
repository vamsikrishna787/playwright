import cors from 'cors';
import express from 'express';
import { PORT, ensureDirs } from './config.js';
import { recordingsRouter } from './routes/recordings.js';
import { runsRouter } from './routes/runs.js';
import { scriptsRouter } from './routes/scripts.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/scripts', scriptsRouter);
app.use('/api/runs', runsRouter);
app.use('/api/recordings', recordingsRouter);

await ensureDirs();

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
