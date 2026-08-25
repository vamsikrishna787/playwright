/**
 * Locating the Node tooling this API drives.
 *
 * The specs are TypeScript and are executed by the real Playwright CLI, and
 * Lighthouse ships its own. Both are spawned as `node <package>/cli.js` rather
 * than through npx, which is a .cmd on Windows and throws from a bare spawn.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { BACKEND_ROOT, REPO_ROOT } from '../config.js';
import { ApiError } from '../util/misc.js';

const require = createRequire(import.meta.url);

function resolveFrom(relative: string): string | null {
  for (const root of [BACKEND_ROOT, REPO_ROOT]) {
    try {
      return require.resolve(path.join(root, 'node_modules', relative));
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function playwrightCli(): string {
  const cli = resolveFrom('@playwright/test/cli.js');
  if (!cli) {
    throw new ApiError(
      500,
      'Could not find node_modules/@playwright/test/cli.js. Run `npm install` at the repo root.',
    );
  }
  return cli;
}

export function lighthouseCli(): string | null {
  return resolveFrom('lighthouse/cli/index.js');
}

/** Playwright's bundled Chromium, so Lighthouse needs no browser of its own. */
export function chromiumPath(): string | null {
  try {
    const core = resolveFrom('playwright-core/index.js');
    if (!core) return null;
    return (require(core) as { chromium: { executablePath(): string } }).chromium.executablePath();
  } catch {
    return null;
  }
}
