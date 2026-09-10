/**
 * Local-filesystem helpers, used only against the work directory.
 *
 * Anything the platform *saves* goes through the storage provider; these are
 * for the scratch space a child process writes into before it is published.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

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
