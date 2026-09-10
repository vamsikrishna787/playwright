/**
 * Mirrors src/server/types.ts. Kept hand-written rather than imported so the UI
 * owns its own view of the wire format, and a server type cannot drag server
 * code into a client bundle.
 */

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface Suite {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  /** The shared pool every test in this suite draws on. */
  dataFields: DataField[];
  createdAt: string;
  updatedAt: string;
}

export interface SuiteSummary extends Suite {
  testCount: number;
  dataCount: number;
  scriptCount: number;
  passed: number;
  failed: number;
  lastRunAt: string | null;
}

export interface DataField {
  id: string;
  category: string;
  name: string;
  value: string;
  secret: boolean;
}

export interface TestStep {
  id: string;
  index: number;
  action: string;
  expected: string;
  dataFieldIds: string[];
}

export interface TestCase {
  id: string;
  suiteId: string;
  name: string;
  description: string;
  url: string;
  steps: TestStep[];
  scriptPath: string | null;
  scriptUpdatedAt: string | null;
  scriptOrigin: 'generated' | 'edited' | 'refined' | null;
  includeAda: boolean;
  lastRunId: string | null;
  lastRunStatus: RunStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface TestSummary extends TestCase {
  stepCount: number;
  /** How many of the suite's shared fields this test's steps reference. */
  dataUsed: number;
  lastRun: Run | null;
}

export interface SuiteDetail extends SuiteSummary {
  tests: TestSummary[];
}

export interface RunStepResult {
  stepId: string | null;
  index: number;
  title: string;
  status: StepStatus;
  durationMs: number;
  error: string | null;
  test: string;
}

export interface RunTestResult {
  title: string;
  status: 'passed' | 'failed' | 'skipped' | 'running';
  durationMs: number;
  error: string | null;
  accessibility: boolean;
}

export interface LighthouseReport {
  status: 'queued' | 'running' | 'done' | 'error' | 'skipped';
  url: string;
  scores: Record<string, number | null>;
  metrics: Record<string, string>;
  reportPath: string | null;
  jsonPath: string | null;
  version: string;
  error: string | null;
  finishedAt: string | null;
}

export interface Run {
  id: string;
  testId: string;
  suiteId: string;
  testName: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  steps: RunStepResult[];
  tests: RunTestResult[];
  videoPath: string | null;
  reportPath: string | null;
  error: string | null;
  lighthouse: LighthouseReport | null;
}

/** The plain-English reading of a script, from the agent tier. */
export interface DerivedStep {
  index: number;
  action: string;
  text: string;
  title: string;
  test: string;
  target: string;
  value: string | null;
}

export interface AgentAction {
  id: string;
  label: string;
  description: string;
  needsInstruction: boolean;
}

export interface AgentResult extends TestCase {
  code: string;
  reply: string;
  model: string;
  saved?: boolean;
}

/** Where the platform is saving, and where it could save. See /api/storage. */
export type StorageProviderName = 'local' | 's3';

export interface StorageProviderOption {
  name: StorageProviderName;
  label: string;
  target: string;
  available: boolean;
  reason: string | null;
}

export interface StorageStatus {
  active: StorageProviderName;
  /** What the active profile asks for, before any runtime override. */
  configured: StorageProviderName;
  override: StorageProviderName | null;
  overriddenAt: string | null;
  allowRuntimeToggle: boolean;
  env: string;
  target: string;
  providers: StorageProviderOption[];
  check: { ok: boolean; detail: string };
  /** Objects copied by the last switch, when one was asked for. */
  copied?: number;
}
