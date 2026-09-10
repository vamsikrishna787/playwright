/**
 * The storage contract.
 *
 * Everything this platform saves — the suite/test/run indexes, the generated
 * spec files, and every artifact a run leaves behind — is addressed by a
 * forward-slash key and passes through one of these. That is the whole point of
 * the interface: `local` writes to a directory, `s3` writes to a bucket, and no
 * caller can tell which it is holding.
 *
 * Keys are relative and POSIX-shaped, e.g.
 *   data/suites.json
 *   scripts/<testId>.spec.ts
 *   runs/<testId>/<runId>/report.json
 */
import type { StorageProviderName } from '../../config/appConfig';

export interface StoredObject {
  key: string;
  size: number;
  updatedAt: string | null;
}

export interface StorageCheck {
  ok: boolean;
  detail: string;
}

export interface StorageProvider {
  readonly name: StorageProviderName;
  /** Where the data actually lands, for the UI to show. */
  readonly target: string;

  readText(key: string): Promise<string | null>;
  writeText(key: string, body: string, contentType?: string): Promise<void>;

  readBytes(key: string): Promise<Buffer | null>;
  writeBytes(key: string, body: Buffer, contentType?: string): Promise<void>;

  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<StoredObject[]>;

  remove(key: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;

  /**
   * Publishes a directory a child process just wrote.
   *
   * Playwright and Lighthouse are real processes writing real files, so a run
   * always happens on local disk and is published afterwards. Returns how many
   * objects landed.
   */
  putTree(localDir: string, prefix: string): Promise<number>;

  /** Is the destination actually reachable and writable? For the Settings page. */
  check(): Promise<StorageCheck>;
}

/** Content types worth naming; anything else is served as a download. */
const TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.woff2': 'font/woff2',
};

export function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf('.');
  return (dot === -1 ? undefined : TYPES[key.slice(dot).toLowerCase()]) ?? 'application/octet-stream';
}

/**
 * Normalises a key and refuses anything that could escape the root.
 *
 * The keys this process writes are all built from uuids, but they are read back
 * out of a JSON index that a person can hand-edit, so they are re-checked on the
 * way in rather than trusted.
 */
export function normaliseKey(key: string): string {
  const cleaned = key.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = cleaned.split('/').filter((part) => part !== '' && part !== '.');
  if (segments.some((part) => part === '..')) {
    throw new Error(`Refusing a storage key that walks up out of the root: ${key}`);
  }
  return segments.join('/');
}
