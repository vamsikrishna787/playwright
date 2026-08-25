import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Writes beside the target and renames, so a crash mid-save cannot leave a
 * half-written index behind. rename is atomic on both Windows and POSIX when
 * source and destination share a filesystem — hence writing into the same dir.
 */
export async function atomicWrite(filePath: string, payload: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, payload, 'utf8');
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Every file matching an extension beneath a directory, sorted. */
export async function walk(dir: string, ext: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(current: string) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.name.endsWith(ext)) found.push(full);
    }
  }
  await visit(dir);
  return found.sort();
}
