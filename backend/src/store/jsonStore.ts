/**
 * A JSON file standing in for a table.
 *
 * Every mutation is serialised through a promise chain, so two concurrent
 * requests can never read-modify-write over each other, and every write lands
 * atomically.
 */
import { atomicWrite, readJson } from '../util/fsx.js';

export class JsonStore<T> {
  /** The tail of the serialised queue. Each op chains onto it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private run<R>(operation: () => Promise<R>): Promise<R> {
    const next = this.queue.then(operation, operation);
    // Swallow on the chain itself so one failed op does not poison the queue;
    // the caller still sees the rejection through `next`.
    this.queue = next.catch(() => undefined);
    return next;
  }

  read(): Promise<T[]> {
    return this.run(() => readJson<T[]>(this.filePath, []));
  }

  /** Read, transform, write — atomically with respect to other callers. */
  update<R>(mutate: (rows: T[]) => { rows: T[]; result: R }): Promise<R> {
    return this.run(async () => {
      const current = await readJson<T[]>(this.filePath, []);
      const { rows, result } = mutate(current);
      await atomicWrite(this.filePath, JSON.stringify(rows, null, 2));
      return result;
    });
  }

  async find(predicate: (row: T) => boolean): Promise<T | undefined> {
    return (await this.read()).find(predicate);
  }
}
