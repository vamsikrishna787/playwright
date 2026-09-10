/**
 * Storage in an S3 bucket.
 *
 * The same key space as the local provider, laid under an optional bucket
 * prefix so one bucket can hold several environments. Credentials are never
 * read here: the SDK's own chain finds them, which is what lets the same image
 * run against a developer's access keys and a pod's IAM role without a config
 * change.
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/appConfig';
import {
  contentTypeFor,
  normaliseKey,
  type StorageCheck,
  type StorageProvider,
  type StoredObject,
} from './types';

/** Missing-object errors, which are an answer rather than a failure. */
const MISSING = new Set(['NoSuchKey', 'NotFound', 'NoSuchBucket']);

const isMissing = (error: unknown): boolean => {
  const name = (error as { name?: string })?.name ?? '';
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return MISSING.has(name) || status === 404;
};

export class S3Storage implements StorageProvider {
  readonly name = 's3' as const;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(settings: AppConfig['storage']['s3']) {
    if (!settings.bucket) {
      throw new Error(
        'S3 storage is selected but no bucket is set. Set S3_BUCKET, or storage.s3.bucket in the active profile.',
      );
    }
    this.bucket = settings.bucket;
    this.prefix = settings.prefix.replace(/^\/+|\/+$/g, '');
    this.client = new S3Client({
      region: settings.region,
      ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
      forcePathStyle: settings.forcePathStyle,
    });
  }

  get target(): string {
    return `s3://${this.bucket}/${this.prefix ? `${this.prefix}/` : ''}`;
  }

  /** Storage key -> object key. The prefix is an S3 detail, never in a stored path. */
  private objectKey(key: string): string {
    const clean = normaliseKey(key);
    return this.prefix ? `${this.prefix}/${clean}` : clean;
  }

  private storageKey(objectKey: string): string {
    return this.prefix && objectKey.startsWith(`${this.prefix}/`)
      ? objectKey.slice(this.prefix.length + 1)
      : objectKey;
  }

  private async put(key: string, body: string | Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        Body: body,
        ContentType: contentType ?? contentTypeFor(key),
      }),
    );
  }

  async readBytes(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      );
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async readText(key: string): Promise<string | null> {
    return (await this.readBytes(key))?.toString('utf8') ?? null;
  }

  writeText(key: string, body: string, contentType?: string): Promise<void> {
    return this.put(key, body, contentType);
  }

  writeBytes(key: string, body: Buffer, contentType?: string): Promise<void> {
    return this.put(key, body, contentType);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      );
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const found: StoredObject[] = [];
    let token: string | undefined;

    // An empty prefix means "everything under our own prefix" - and it has to
    // carry the trailing slash, or a prefix of `playwright` would also list
    // `playwright-archive`.
    const search = normaliseKey(prefix)
      ? this.objectKey(prefix)
      : this.prefix
        ? `${this.prefix}/`
        : undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: search,
          ContinuationToken: token,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        found.push({
          key: this.storageKey(item.Key),
          size: item.Size ?? 0,
          updatedAt: item.LastModified ? item.LastModified.toISOString() : null,
        });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    return found.sort((a, b) => a.key.localeCompare(b.key));
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
    );
  }

  /** S3 has no directories, so a prefix delete is a list and a batch delete. */
  async removePrefix(prefix: string): Promise<void> {
    const objects = await this.list(prefix);
    for (let start = 0; start < objects.length; start += 1000) {
      const batch = objects.slice(start, start + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((item) => ({ Key: this.objectKey(item.key) })) },
        }),
      );
    }
  }

  /**
   * Uploads what a run wrote, then clears the local scratch copy.
   *
   * Sequential on purpose: a suite run can finish several tests at once, and a
   * hundred parallel uploads per run would put more load on the socket pool
   * than the upload is worth saving.
   */
  async putTree(localDir: string, prefix: string): Promise<number> {
    const source = path.resolve(localDir);
    const base = normaliseKey(prefix);
    let count = 0;

    const visit = async (dir: string, keyPrefix: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const key = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await visit(full, key);
        } else {
          await this.put(key, await fs.readFile(full));
          count += 1;
        }
      }
    };

    await visit(source, base);
    await fs.rm(source, { recursive: true, force: true });
    return count;
  }

  async check(): Promise<StorageCheck> {
    const probe = `.check/${randomUUID()}.txt`;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      await this.put(probe, 'ok', 'text/plain');
      await this.remove(probe);
      return { ok: true, detail: `Writable: ${this.target}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const name = (error as { name?: string })?.name;
      return {
        ok: false,
        // The two failures worth naming: no bucket, and no credentials. Both
        // read as an opaque SDK error otherwise.
        detail:
          name === 'NotFound' || name === 'NoSuchBucket'
            ? `No such bucket: ${this.bucket} (region ${await this.client.config.region()})`
            : message,
      };
    }
  }
}
