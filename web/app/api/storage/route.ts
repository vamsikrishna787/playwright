/**
 * The storage switch.
 *
 * GET reports where the platform is saving, what the active profile configured,
 * and which providers are usable right now. PUT flips it — refused outright
 * when the profile disables the toggle, and refused before anything moves when
 * the destination does not answer.
 *
 * `copyExisting` mirrors what is already saved into the new provider. Without
 * it the switch points at whatever is already there, which is occasionally what
 * you want and usually a surprise.
 */
import { route, json, body } from '@/server/http';
import { badRequest } from '@/server/util/misc';
import { checkStorage, setStorageProvider, storageStatus } from '@/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const [status, check] = await Promise.all([storageStatus(), checkStorage()]);
  return json({ ...status, check });
});

export const PUT = route(async (request) => {
  const payload = await body(request);
  const provider = payload.provider;

  if (provider !== 'local' && provider !== 's3') {
    throw badRequest('Choose a provider: "local" or "s3".');
  }

  try {
    const result = await setStorageProvider(provider, {
      copyExisting: payload.copyExisting === true,
    });
    return json({ ...result.status, check: result.check, copied: result.copied });
  } catch (error) {
    // A refused switch is the caller asking for something impossible, not a
    // server fault — and the message is the whole point of the response.
    throw badRequest(error instanceof Error ? error.message : String(error));
  }
});
