/**
 * A JSON document standing in for a table.
 *
 * Every mutation is serialised through a promise chain, so two concurrent
 * requests can never read-modify-write over each other. Where the document
 * actually lands — a file on disk or an object in a bucket — is the storage
 * provider's business, and this class deliberately cannot tell.
 */
import { getStorage } from '../storage';

export class JsonStore<T> {
  /** The tail of the serialised queue. Each op chains onto it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly key: string) {}

  private run<R>(operation: () => Promise<R>): Promise<R> {
    const next = this.queue.then(operation, operation);
    // Swallow on the chain itself so one failed op does not poison the queue;
    // the caller still sees the rejection through `next`.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<T[]> {
    const storage = await getStorage();
    const raw = await storage.readText(this.key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as T[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // A hand-edited index that no longer parses must not take the process
      // down on the next read; it reads as empty and the next write repairs it.
      console.error(`[store] ${this.key} is not valid JSON, treating it as empty.`);
      return [];
    }
  }

  read(): Promise<T[]> {
    return this.run(() => this.load());
  }

  /** Read, transform, write — atomically with respect to other callers. */
  update<R>(mutate: (rows: T[]) => { rows: T[]; result: R }): Promise<R> {
    return this.run(async () => {
      const current = await this.load();
      const { rows, result } = mutate(current);
      const storage = await getStorage();
      await storage.writeText(this.key, JSON.stringify(rows, null, 2), 'application/json');
      return result;
    });
  }

  async find(predicate: (row: T) => boolean): Promise<T | undefined> {
    return (await this.read()).find(predicate);
  }
}
