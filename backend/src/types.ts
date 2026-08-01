export interface ScriptRecord {
  id: string;
  name: string;
  sourceUrl: string;
  prompt: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunStep {
  title: string;
  durationMs: number;
  error?: string;
}

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error';

/** One test() within the spec — a run now holds a functional test and an a11y test. */
export interface RunTest {
  title: string;
  status: 'passed' | 'failed';
  durationMs: number;
  steps: RunStep[];
  error: string | null;
}

export interface RunRecord {
  id: string;
  scriptId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  videoPath: string | null;
  reportPath: string;
  /** Per-test breakdown. */
  tests: RunTest[];
  /** All steps flattened, kept so summaries stay cheap to render. */
  steps: RunStep[];
  error: string | null;
}
