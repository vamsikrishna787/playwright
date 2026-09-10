import { serveArtifact } from '@/server/artifacts';
import { loadRun } from '@/server/domain-runs';
import { route } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>(async (_request, { id }) => {
  const run = await loadRun(id);
  // Lighthouse writes one self-contained HTML file, so there is nothing beside
  // it to resolve — unlike the Playwright report.
  return serveArtifact(run.lighthouse?.reportPath, 'Lighthouse report', {
    contentType: 'text/html; charset=utf-8',
  });
});
