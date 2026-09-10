/** The raw Playwright JSON, for anyone who wants the unabridged version. */
import { serveArtifact } from '@/server/artifacts';
import { loadRun } from '@/server/domain-runs';
import { route } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>(async (_request, { id }) => {
  const run = await loadRun(id);
  return serveArtifact(run.reportPath, 'Report', { contentType: 'application/json' });
});
