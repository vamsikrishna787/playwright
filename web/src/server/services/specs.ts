/**
 * The generated spec files.
 *
 * A spec is saved through the storage provider like everything else, but
 * Playwright can only run a real file, so it is materialised into the work
 * directory immediately before a run. With local storage the two are a copy
 * apart; with S3 the download is the only way the CLI could ever see it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { keys, work } from '../paths';
import { getStorage } from '../storage';

export async function readSpec(testId: string): Promise<string> {
  const storage = await getStorage();
  return (await storage.readText(keys.spec(testId))) ?? '';
}

export async function specExists(testId: string): Promise<boolean> {
  const storage = await getStorage();
  return storage.exists(keys.spec(testId));
}

export async function writeSpec(testId: string, code: string): Promise<string> {
  const storage = await getStorage();
  const key = keys.spec(testId);
  await storage.writeText(key, code.endsWith('\n') ? code : `${code}\n`, 'text/plain; charset=utf-8');
  return key;
}

export async function deleteSpec(testId: string): Promise<void> {
  const storage = await getStorage();
  await storage.remove(keys.spec(testId));
  await fs.rm(work.specFile(testId), { force: true });
}

/** Duplicates a spec. Returns false when the source has none. */
export async function copySpec(fromTestId: string, toTestId: string): Promise<boolean> {
  const code = await readSpec(fromTestId);
  if (!code.trim()) return false;
  await writeSpec(toTestId, code);
  return true;
}

/**
 * Puts the spec on disk for the Playwright CLI and hands back its path.
 *
 * The work directory holds one file per test rather than per run: Playwright is
 * pointed at it as its testDir and given a regex selecting the one file, so a
 * stale sibling from an earlier run costs nothing.
 */
export async function materialiseSpec(testId: string): Promise<string | null> {
  const code = await readSpec(testId);
  if (!code.trim()) return null;

  const file = work.specFile(testId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, code, 'utf8');
  return file;
}
