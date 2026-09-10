import { route, json } from '@/server/http';
import { loadRun } from '@/server/domain-runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>(async (_request, { id }) => json(await loadRun(id)));
