/**
 * The auth gate.
 *
 * Runs in the Edge runtime, which cannot open the YAML profiles — so the two
 * settings it needs come from the environment, and appConfig reads the same two
 * variables so the API layer and this file can never disagree.
 *
 * Pages are gated; /api is not. The API is called by the pages themselves and
 * carries its own errors, and gating it here would answer a fetch with a login
 * redirect that the client would then try to parse as JSON.
 */
import { NextResponse, type NextRequest } from 'next/server';

const ENABLED = ['1', 'true', 'yes', 'on'].includes(
  (process.env.AUTH_ENABLED || 'false').trim().toLowerCase(),
);
const HEADER = (process.env.AUTH_HEADER_NAME || 'x-remote-user').trim().toLowerCase();

export function middleware(request: NextRequest): NextResponse {
  if (!ENABLED) return NextResponse.next();

  // An identity-aware proxy in front of the pod terminates the login and passes
  // the user down as a header; an empty one means the request did not come
  // through it.
  const user = request.headers.get(HEADER);
  if (!user) {
    return NextResponse.json(
      { error: `Unauthenticated: no ${HEADER} header on the request.` },
      { status: 401 },
    );
  }

  const forwarded = NextResponse.next();
  forwarded.headers.set('x-authenticated-user', user);
  return forwarded;
}

export const config = {
  /**
   * Every page route, and nothing else: the API layer, Next's own assets, the
   * favicon and anything with a file extension are all ungated.
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon\\.ico|.*\\.[^/]+$).*)'],
};
