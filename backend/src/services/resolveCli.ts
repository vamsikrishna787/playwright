import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Resolves a package's own cli.js so it can be spawned with `node` directly.
 * Avoids `npx`, which is a .cmd on Windows and throws ENOENT from spawn().
 */
export function resolveCli(pkg: string): string {
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'cli.js');
}
