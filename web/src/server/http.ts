/**
 * The shape every route handler in app/api shares.
 *
 * `route` does three things worth having in one place: it awaits the dynamic
 * params (a promise in the App Router), it turns an ApiError into the right
 * status with a readable body, and it catches everything else. That last part is
 * not cosmetic — an unhandled rejection in a background task can take the whole
 * server process down, and with it every in-flight run.
 */
import { NextResponse } from 'next/server';
import { bootstrap } from './bootstrap';
import { ApiError } from './util/misc';

export const json = <T>(data: T, status = 200): NextResponse =>
  NextResponse.json(data, { status });

export const noContent = (): NextResponse => new NextResponse(null, { status: 204 });

/** A JSON body, or {} — a handler reads its fields defensively either way. */
export async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type Handler<P> = (request: Request, params: P) => Promise<Response>;

/** Next 15 hands dynamic segments over as a promise. */
interface Context<P> {
  params: Promise<P>;
}

export function route<P = Record<string, never>>(handler: Handler<P>) {
  // Declared as required because that is what Next's generated route types
  // expect of the second argument, and read defensively because a static
  // segment has no params to hand over.
  return async (request: Request, context: Context<P>): Promise<Response> => {
    try {
      // Start-up runs here rather than in instrumentation.ts, which Next also
      // compiles for the Edge runtime — and the Edge bundler cannot follow an
      // import of node:fs even behind a runtime guard. Every route in this
      // application declares the Node runtime, and bootstrap() is idempotent,
      // so this costs one resolved-promise check per request.
      await bootstrap().catch(() => undefined);

      const params = context?.params ? await context.params : ({} as P);
      return await handler(request, params);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: error.message }, error.status);
      }
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      console.error('[api]', error);
      return json({ error: message }, 500);
    }
  };
}
