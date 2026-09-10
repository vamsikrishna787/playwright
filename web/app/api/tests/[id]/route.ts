/**
 * A single test: its identity and its steps.
 *
 * Steps are saved as a whole list rather than a row at a time. The editor is a
 * form, not a spreadsheet — one save per screen keeps the client simple and
 * makes renumbering a server-side detail.
 */
import { route, json, noContent, body } from '@/server/http';
import { deleteTest, loadTest, patchTest } from '@/server/domain';
import { readSpec } from '@/server/services/specs';
import { bool, str } from '@/server/util/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>(async (_request, { id }) => {
  const test = await loadTest(id);

  return json({
    ...test,
    // The editor always opens with the script in hand, so switching to the
    // Script tab never costs a second round trip.
    code: await readSpec(test.id),
  });
});

export const PATCH = route<Params>(async (request, { id }) => {
  const payload = await body(request);

  const test = await patchTest(id, (current) => ({
    ...current,
    name: payload.name !== undefined ? str(payload.name, 160) || current.name : current.name,
    description:
      payload.description !== undefined ? str(payload.description, 4000) : current.description,
    url: payload.url !== undefined ? str(payload.url, 500) : current.url,
    includeAda: bool(payload.includeAda, current.includeAda),
  }));

  return json(test);
});

export const DELETE = route<Params>(async (_request, { id }) => {
  await loadTest(id);
  await deleteTest(id);
  return noContent();
});
