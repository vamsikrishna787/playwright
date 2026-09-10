import { serveArtifact } from '@/server/artifacts';
import { loadRun } from '@/server/domain-runs';
import { route } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>(async (request, { id }) => {
  const run = await loadRun(id);
  // Ranged, so the player can seek rather than only play from the start.
  return serveArtifact(run.videoPath, 'Video', {
    contentType: 'video/webm',
    ranged: true,
    request,
  });
});
