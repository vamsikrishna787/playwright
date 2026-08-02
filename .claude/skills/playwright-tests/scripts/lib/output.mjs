/** Where capture artifacts land, and how they stay out of the host repo's git. */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CAPTURE_ROOT = '.playwright-capture';

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Creates the output directory and self-ignores it, so nothing has to be added
 * to the host repository's .gitignore for captures to stay untracked.
 */
export function prepareOutDir(explicit, prefix) {
  const dir = explicit
    ? resolve(explicit)
    : resolve(process.cwd(), CAPTURE_ROOT, `${prefix}-${stamp()}`);

  mkdirSync(dir, { recursive: true });

  if (!explicit) {
    const ignore = join(process.cwd(), CAPTURE_ROOT, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf8');
  }
  return dir;
}

export function writeArtifacts(dir, name, { markdown, json }) {
  const mdPath = join(dir, `${name}.md`);
  const jsonPath = join(dir, `${name}.json`);
  writeFileSync(mdPath, markdown, 'utf8');
  writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8');
  return { mdPath, jsonPath };
}

/** Minimal flag parser: --flag value, --flag=value, --no-flag, and positionals. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s);
    if (rawName.startsWith('no-')) {
      flags[rawName.slice(3)] = false;
      continue;
    }
    if (inlineValue !== undefined) {
      flags[rawName] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[rawName] = true;
    } else {
      flags[rawName] = next;
      i++;
    }
  }
  return { flags, positional };
}
