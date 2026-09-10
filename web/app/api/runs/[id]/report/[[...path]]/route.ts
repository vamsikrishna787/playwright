/**
 * The Playwright HTML report.
 *
 * A catch-all rather than a single file, because the report is a directory: its
 * index.html asks for `data/*` beside itself. Serving only the index left those
 * requests resolving against the wrong path and returning nothing, so a report
 * with a trace or a video in it rendered broken. The UI links to the trailing
 * slash form, which is what makes the relative requests land back here.
 */
import { serveArtifact } from '@/server/artifacts';
import { loadRun, runPrefix } from '@/server/domain-runs';
import { route } from '@/server/http';
import { notFound } from '@/server/util/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string; path?: string[] };

export const GET = route<Params>(async (_request, { id, path }) => {
  const run = await loadRun(id);
  const prefix = runPrefix(run);
  if (!prefix) throw notFound('Report');

  const relative = (path ?? []).filter((part) => part && part !== '..');
  const key = `${prefix}/html/${relative.length ? relative.join('/') : 'index.html'}`;

  return serveArtifact(key, 'Report');
});
