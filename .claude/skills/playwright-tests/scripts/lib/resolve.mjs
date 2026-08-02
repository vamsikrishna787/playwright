/**
 * Finds Playwright and axe inside whatever repository these scripts are run
 * against. Nothing here is specific to one project: the only requirement is
 * that the host repo (or a global install) has Playwright somewhere.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

/** Workspace members, which keep their own node_modules when versions conflict. */
function workspaceMembers(root) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return [];

  let patterns = [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
  } catch {
    return [];
  }

  const members = [];
  for (const pattern of patterns) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      members.push(join(root, pattern));
      continue;
    }
    const base = join(root, pattern.slice(0, star));
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) members.push(join(base, entry.name));
      }
    } catch {
      // Unreadable directory is simply not a candidate.
    }
  }
  return members.filter((dir) => existsSync(dir));
}

/** Every directory worth using as a module-resolution starting point. */
function candidateRoots(start) {
  const roots = [];
  const push = (dir) => {
    if (dir && !roots.includes(dir)) roots.push(dir);
  };

  let dir = resolve(start);
  for (;;) {
    push(dir);
    for (const member of workspaceMembers(dir)) push(member);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/** Last resort — spawning npm costs ~300ms, so it is only consulted on miss. */
let globalRootCache;
function globalRoot() {
  if (globalRootCache !== undefined) return globalRootCache;
  try {
    globalRootCache = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true,
    }).trim();
  } catch {
    globalRootCache = '';
  }
  return globalRootCache;
}

function resolvePath(names, cwd) {
  const paths = candidateRoots(cwd);
  for (const name of names) {
    try {
      return require.resolve(name, { paths });
    } catch {
      // Try the next name.
    }
  }
  const global = globalRoot();
  if (!global) return null;
  for (const name of names) {
    try {
      return require.resolve(name, { paths: [global] });
    } catch {
      // Try the next name.
    }
  }
  return null;
}

function requireFrom(names, cwd) {
  const entry = resolvePath(names, cwd);
  return entry ? { entry, module: require(entry) } : null;
}

/**
 * Playwright, from the host repo. @playwright/test is preferred because it is
 * what test files import, but a repo that only has the plain driver still works
 * for capture — the generated tests just need @playwright/test at run time.
 */
export function loadPlaywright(cwd = process.cwd()) {
  const found = requireFrom(['@playwright/test', 'playwright', 'playwright-core'], cwd);
  if (!found) {
    throw new Error(
      'Playwright was not found from ' +
        cwd +
        '. Install it in this repo first:\n' +
        '  npm install -D @playwright/test\n' +
        '  npx playwright install chromium',
    );
  }
  return found.module;
}

const DEFAULT_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * An axe runner, or null when the host repo has neither axe package.
 *
 * Two tiers, because a11y coverage should not depend on which of the two the
 * repo happens to have: @axe-core/playwright when present, otherwise axe-core's
 * own bundle injected by hand.
 */
export function loadAxe(cwd = process.cwd()) {
  const builder = requireFrom(['@axe-core/playwright'], cwd);
  if (builder) {
    const mod = builder.module;
    const AxeBuilder = mod.AxeBuilder ?? mod.default ?? mod;
    return {
      source: '@axe-core/playwright',
      async run(page, tags = DEFAULT_TAGS) {
        const results = await new AxeBuilder({ page }).withTags(tags).analyze();
        return results.violations ?? [];
      },
    };
  }

  const bundle = resolvePath(['axe-core/axe.min.js', 'axe-core/axe.js'], cwd);
  if (bundle) {
    const source = readFileSync(bundle, 'utf8');
    return {
      source: 'axe-core (injected)',
      async run(page, tags = DEFAULT_TAGS) {
        await page.addScriptTag({ content: source });
        const results = await page.evaluate(
          (values) => window.axe.run(document, { runOnly: { type: 'tag', values } }),
          tags,
        );
        return results.violations ?? [];
      },
    };
  }

  return null;
}

export const AXE_TAGS = DEFAULT_TAGS;
