import { route, json } from '@/server/http';
import { tests as testStore } from '@/server/store/index';
import { str } from '@/server/util/misc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  const suiteId = str(new URL(request.url).searchParams.get('suiteId'), 60);
  const rows = await testStore.read();
  return json(suiteId ? rows.filter((test) => test.suiteId === suiteId) : rows);
});
