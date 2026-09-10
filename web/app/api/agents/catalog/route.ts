/** Drives the UI action buttons, so a new Python agent needs no UI change. */
import { route, json } from '@/server/http';
import { agents } from '@/server/services/agentClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => json({ actions: await agents.catalog() }));
