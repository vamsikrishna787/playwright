/**
 * Storage on the local filesystem.
 *
 * The provider you get on a developer machine: a key is a path under one root
 * directory. Writes go through a temp file and a rename, so a crash mid-save
 * cannot leave a half-written index behind.
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normaliseKey, type StorageCheck, type StorageProvider, type StoredObject } from './types';

export class LocalStorage implements StorageProvider {
  readonly name = 'local' as const;

  constructor(private readonly root: string) {}

  get target(): string {
    return this.root;
  }

  /** key -> absolute path, re-checked against the root after resolution. */
  private pathFor(key: string): string {
    const absolute = path.resolve(this.root, ...normaliseKey(key).split('/'));
    if (absolute !== this.root && !absolute.startsWith(this.root + path.sep)) {
      throw new Error(`Refusing a storage key outside the root: ${key}`);
    }
    return absolute;
  }

  private async write(key: string, body: string | Buffer): Promise<void> {
    const file = this.pathFor(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Beside the target so the rename stays on one filesystem, which is what
    // makes it atomic on both Windows and POSIX.
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, body);
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  async readText(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.pathFor(key), 'utf8');
    } catch {
      return null;
    }
  }

  writeText(key: string, body: string): Promise<void> {
    return this.write(key, body);
  }

  async readBytes(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.pathFor(key));
    } catch {
      return null;
    }
  }

  writeBytes(key: string, body: Buffer): Promise<void> {
    return this.write(key, body);
  }

  /** A read stream for the file, so a video is not buffered whole to serve it. */
  async stream(key: string): Promise<NodeJS.ReadableStream | null> {
    const file = this.pathFor(key);
    try {
      await fs.access(file);
    } catch {
      return null;
    }
    return createReadStream(file);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const base = normaliseKey(prefix);
    const start = this.pathFor(base);
    const found: StoredObject[] = [];

    const visit = async (dir: string, keyPrefix: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const key = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(full, key);
        } else {
          const stat = await fs.stat(full).catch(() => null);
          found.push({
            key,
            size: stat?.size ?? 0,
            updatedAt: stat ? stat.mtime.toISOString() : null,
          });
        }
      }
    };

    // A prefix naming a file rather than a directory still lists as that one file.
    const stat = await fs.stat(start).catch(() => null);
    if (stat?.isFile()) {
      return [{ key: base, size: stat.size, updatedAt: stat.mtime.toISOString() }];
    }
    await visit(start, base);
    return found.sort((a, b) => a.key.localeCompare(b.key));
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true });
  }

  async removePrefix(prefix: string): Promise<void> {
    await fs.rm(this.pathFor(prefix), { recursive: true, force: true });
  }

  /**
   * Publishing to local storage.
   *
   * A merge, not a replace: a run publishes its Playwright artifacts as soon as
   * the verdict is in and its Lighthouse report half a minute later, both under
   * the same prefix, so a second publish must not remove what the first one
   * put there. The rename is only taken when there is nothing to merge with,
   * where it saves copying a run's worth of video for no reason.
   */
  async putTree(localDir: string, prefix: string): Promise<number> {
    const destination = this.pathFor(prefix);
    const source = path.resolve(localDir);
    if (source === destination) return (await this.list(prefix)).length;

    await fs.mkdir(path.dirname(destination), { recursive: true });
    const fresh = !(await this.exists(prefix));

    if (fresh) {
      try {
        await fs.rename(source, destination);
        return (await this.list(prefix)).length;
      } catch {
        // EXDEV, or Windows holding a handle open: fall through to the copy.
      }
    }

    await fs.cp(source, destination, { recursive: true, force: true });
    await fs.rm(source, { recursive: true, force: true });
    return (await this.list(prefix)).length;
  }

  async check(): Promise<StorageCheck> {
    const probe = `.check/${randomUUID()}.txt`;
    try {
      await this.write(probe, 'ok');
      await this.remove(probe);
      return { ok: true, detail: `Writable: ${this.root}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
