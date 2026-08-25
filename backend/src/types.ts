/**
 * The domain model, and the wire format the UI consumes.
 *
 * A Suite holds Tests. A Test holds the two things a person authors by hand —
 * data fields and steps — plus the spec an agent wrote from them and the runs
 * that spec produced.
 */

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface Suite {
  id: string;
  name: string;
  description: string;
  /** Prefills the URL box on every test added under it. */
  baseUrl: string;
  /**
   * The shared data pool. Every test in the suite draws on this, so a login
   * that half the suite needs is entered once and referenced by all of them.
   * Categories are what keep it navigable as it grows.
   */
  dataFields: DataField[];
  createdAt: string;
  updatedAt: string;
}

/**
 * One named value a test types into the page. Owned by the suite, not the test,
 * so every test under it can reference the same value.
 *
 * `category` groups fields in the UI ("Login", "Invalid login", "Address") and is
 * passed to the agent as context, so it can tell a billing postcode from a
 * shipping one — and it is what keeps a shared pool readable once a suite has
 * data for a dozen tests in it.
 */
export interface DataField {
  id: string;
  category: string;
  name: string;
  value: string;
  /** Masked in the UI. Still written into the spec — these are test accounts. */
  secret: boolean;
}

/**
 * One authored step: what to do, and what should be true afterwards.
 *
 * `dataFieldIds` points into the *suite's* pool. It is what makes a step
 * reusable rather than hardcoded — the agent is told to reference
 * `data.<fieldName>` instead of inlining the literal, so changing the value
 * never means regenerating the script, and changing it once updates every test
 * in the suite that uses it.
 */
export interface TestStep {
  id: string;
  /** 1-based, and the number the generated spec tags its test.step() with. */
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
  /** Where the test starts. Falls back to the suite's baseUrl when blank. */
  url: string;
  steps: TestStep[];
  /** Set once a script exists on disk. */
  scriptPath: string | null;
  scriptUpdatedAt: string | null;
  /** How the current script came to be, for the badge in the UI. */
  scriptOrigin: 'generated' | 'edited' | 'refined' | null;
  includeAda: boolean;
  lastRunId: string | null;
  lastRunStatus: RunStatus | null;
  createdAt: string;
  updatedAt: string;
}

/** A step as the runner saw it, mapped back to the step the user authored. */
export interface RunStepResult {
  /** The authored step this maps to, or null for a step the agent added itself. */
  stepId: string | null;
  index: number;
  title: string;
  status: StepStatus;
  durationMs: number;
  error: string | null;
  /** Which test() inside the spec the step belongs to. */
  test: string;
}

export interface RunTestResult {
  title: string;
  status: 'passed' | 'failed' | 'skipped' | 'running';
  durationMs: number;
  error: string | null;
  /** True for the axe test, so the UI can grade accessibility separately. */
  accessibility: boolean;
}

export interface LighthouseReport {
  status: 'queued' | 'running' | 'done' | 'error' | 'skipped';
  url: string;
  /** 0-100 per category, or null where Lighthouse could not grade one. */
  scores: Record<string, number | null>;
  /** Human-readable values, e.g. { largestContentfulPaint: "1.2 s" }. */
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
  /** Live progress: the flattened step list, ordered as executed. */
  steps: RunStepResult[];
  tests: RunTestResult[];
  videoPath: string | null;
  reportPath: string | null;
  error: string | null;
  lighthouse: LighthouseReport | null;
}

/** The plain-English reading of a spec, returned by the agent tier. */
export interface DerivedStep {
  index: number;
  action: string;
  text: string;
  title: string;
  test: string;
  target: string;
  value: string | null;
}
