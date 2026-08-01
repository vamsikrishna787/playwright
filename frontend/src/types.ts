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

export interface CapturedPage {
  url: string;
  title: string;
  elementCount: number;
  axeCount: number;
}

export interface RecordingSession {
  id: string;
  startUrl: string;
  status: 'recording' | 'finished' | 'error';
  error: string | null;
  startedAt: string;
  pages: CapturedPage[];
}

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
  tests: RunTest[];
  steps: RunStep[];
  error: string | null;
}
