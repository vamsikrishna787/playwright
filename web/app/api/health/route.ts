/**
 * Liveness, plus whether the agent tier is answering.
 *
 * The agent state is worth reporting here rather than on its own endpoint:
 * "generate does nothing" is nearly always the Python process not being up, and
 * this is the cheapest way for the header dot to see that. The storage line is
 * the same idea in the other direction — where the platform is currently
 * saving, on every poll, without a second request.
 */
import { appConfig } from '@/config/appConfig';
import { route, json } from '@/server/http';
import { agents } from '@/server/services/agentClient';
import { getStorage } from '@/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const [catalog, storage] = await Promise.all([agents.catalog(), getStorage()]);

  return json({
    ok: true,
    env: appConfig.env,
    agentApi: {
      url: appConfig.agents.baseUrl,
      reachable: catalog.length > 0,
      actions: catalog.length,
    },
    storage: { provider: storage.name, target: storage.target },
  });
});
