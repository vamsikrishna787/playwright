import fs from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import { RUNS_JSON, SCRIPTS_JSON } from '../config.js';
import type { RunRecord, ScriptRecord } from '../types.js';

class JsonFileStore<T> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly empty: T,
  ) {}

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  read(): Promise<T> {
    return this.enqueue(() => this.load());
  }

  update(mutate: (current: T) => T): Promise<T> {
    return this.enqueue(async () => {
      const next = mutate(await this.load());
      await writeFileAtomic(this.filePath, JSON.stringify(next, null, 2));
      return next;
    });
  }

  private async load(): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.empty;
      throw err;
    }
  }
}

export const scriptsStore = new JsonFileStore<ScriptRecord[]>(SCRIPTS_JSON, []);
export const runsStore = new JsonFileStore<RunRecord[]>(RUNS_JSON, []);

export function patchRun(runs: RunRecord[], runId: string, patch: Partial<RunRecord>): RunRecord[] {
  return runs.map((run) => (run.id === runId ? { ...run, ...patch } : run));
}
