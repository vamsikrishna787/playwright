/**
 * Brings data written by the previous Express backend into local storage.
 *
 * The old backend kept `backend/data`, `backend/scripts` and `backend/runs` on
 * disk and recorded backend-root-relative paths in its indexes — which is
 * exactly the key shape the storage layer uses now, so the move is a copy and
 * nothing inside the JSON needs rewriting.
 *
 *   node scripts/import-legacy-data.mjs [--from ../backend] [--force]
 *
 * Copies into the *local* provider's root. To end up in S3, import here first
 * and then flip the switch on the Settings page with "copy what is already
 * saved" ticked.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

const APP_ROOT = process.cwd();
const from = path.resolve(APP_ROOT, flag('from', '../backend'));
const force = argv.includes('--force');

/** The local root, read from the same profiles the application reads. */
async function localRoot() {
  const env = (process.env.APP_ENV || 'local').trim().toLowerCase();
  for (const profile of [env, 'application']) {
    const file = path.join(APP_ROOT, 'src', 'config', `${profile}.yml`);
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (!text) continue;
    const root = parse(text)?.storage?.local?.root;
    if (root) return path.resolve(APP_ROOT, String(root));
  }
  return path.resolve(APP_ROOT, '.data');
}

const root = await localRoot();
let copied = 0;
let skipped = 0;

for (const folder of ['data', 'scripts', 'runs']) {
  const source = path.join(from, folder);
  if (!(await fs.stat(source).catch(() => null))) {
    console.log(`[import] ${folder}: nothing at ${source}`);
    continue;
  }

  const destination = path.join(root, folder);
  const exists = await fs.stat(destination).catch(() => null);
  if (exists && !force) {
    console.log(`[import] ${folder}: ${destination} already exists — pass --force to overwrite.`);
    skipped += 1;
    continue;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
  console.log(`[import] ${folder}: ${source} -> ${destination}`);
  copied += 1;
}

console.log(
  `[import] done — ${copied} folder(s) copied${skipped ? `, ${skipped} skipped` : ''}. Storage root: ${root}`,
);
