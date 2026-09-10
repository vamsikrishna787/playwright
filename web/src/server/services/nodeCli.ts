/**
 * Locating the Node tooling this application drives.
 *
 * The specs are TypeScript and are executed by the real Playwright CLI, and
 * Lighthouse ships its own. Both are spawned as `node <package>/cli.js` rather
 * than through npx, which is a .cmd on Windows and throws from a bare spawn.
 *
 * These are found by looking on disk rather than with require.resolve, and that
 * is not a stylistic choice: the bundler rewrites a `createRequire` inside a
 * server bundle into a stub whose `resolve` throws MODULE_NOT_FOUND for every
 * path it is given. A run failed with "could not find @playwright/test" while
 * the file sat exactly where it was being looked for. Both of these are plain
 * files at a known location under node_modules, so a path check is all that was
 * ever needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../../config/appConfig';
import { ApiError } from '../util/misc';

/**
 * Where a node_modules could be: this app, then the workspace root above it.
 * npm hoists a workspace's dependencies to the root, so the second is where
 * they usually are; the first covers a standalone install of `web/`.
 */
const ROOTS = [APP_ROOT, path.resolve(APP_ROOT, '..')];

function findFile(relative: string): string | null {
  for (const root of ROOTS) {
    const candidate = path.join(root, 'node_modules', ...relative.split('/'));
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function playwrightCli(): string {
  const cli = findFile('@playwright/test/cli.js');
  if (!cli) {
    throw new ApiError(
      500,
      `Could not find node_modules/@playwright/test/cli.js under ${ROOTS.join(' or ')}. Run \`npm install\` at the repo root.`,
    );
  }
  return cli;
}

export function lighthouseCli(): string | null {
  return findFile('lighthouse/cli/index.js');
}

/**
 * Playwright's bundled Chromium, so Lighthouse needs no browser of its own.
 *
 * This one has to actually load the module to ask it where the browser went.
 * process.getBuiltinModule is Node's own way to reach a builtin without an
 * import statement a bundler would rewrite — and if it is unavailable, the
 * answer is simply "no browser here" and Lighthouse falls back to finding its
 * own.
 */
export function chromiumPath(): string | null {
  try {
    const entry = findFile('playwright-core/index.js');
    if (!entry) return null;

    const getBuiltin = (
      process as NodeJS.Process & {
        getBuiltinModule?: (id: string) => { createRequire(from: string): NodeRequire };
      }
    ).getBuiltinModule;

    const load = getBuiltin?.('node:module').createRequire(entry);
    if (!load) return null;

    return (load(entry) as { chromium: { executablePath(): string } }).chromium.executablePath();
  } catch {
    return null;
  }
}
