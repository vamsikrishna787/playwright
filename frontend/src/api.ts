export type ScriptStatus = 'none' | 'generating' | 'ready' | 'stale' | 'failed';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'passed' | 'failed' | 'error';
export type SuiteStatus = 'empty' | 'running' | 'failing' | 'passing' | 'not-run';

export interface DataPoint {
  key: string;
  value: string;
}

export interface TestDefinition {
  name: string;
  description: string;
  startUrl: string;
  expectedResult: string;
  steps: string[];
  dataPoints: DataPoint[];
}

export interface StepResult {
  title: string;
  durationMs: number;
  error: string | null;
}

export interface RunTestResult {
  title: string;
  status: string;
  durationMs: number;
  errors: string[];
  steps: StepResult[];
}

export interface Artifact {
  name: string;
  label: string;
  contentType: string;
  size: number;
  viewUrl: string;
  downloadUrl: string;
}

export interface Run {
  runId: string;
  status: JobStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  trigger: 'manual' | 'suite';
  startUrl?: string;
  lighthouse: boolean;
  lighthousePreset: 'desktop' | 'mobile';
  lighthouseStatus?: 'running' | 'done' | 'failed';
  lighthouseScores?: Record<string, number | null> | null;
  lighthouseError?: string | null;
  error?: string | null;
  tests?: RunTestResult[];
  artifacts?: Artifact[];
}

export interface GenerationSummary {
  jobId: string;
  status: JobStatus;
  error?: string | null;
  queuedAt: string;
  finishedAt?: string;
}

export interface LogEntry {
  t: string;
  kind: string;
  message: string;
  detail?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface GenerationJob extends GenerationSummary {
  startedAt?: string;
  model?: string;
  turns?: number;
  submissions?: number;
  usage?: Usage;
  log: LogEntry[];
}

export interface ScriptMeta {
  jobId: string;
  generatedAt: string;
  definitionHash: string;
  model: string;
  summary: string;
  turns: number;
  submissions: number;
  usage: Usage;
}

export interface TestCase extends TestDefinition {
  id: string;
  suiteId: string;
  createdAt: string;
  updatedAt: string;
  resolvedStartUrl: string;
  scriptStatus: ScriptStatus;
  generation: GenerationSummary | null;
  script: ScriptMeta | null;
  lastRun: Run | null;
  runCount: number;
  runs?: Run[];
  suite?: Suite;
}

export interface SuiteCounts {
  total: number;
  ready: number;
  generating: number;
  noScript: number;
  passed: number;
  failed: number;
  running: number;
}

export interface SuiteInput {
  name: string;
  description: string;
  baseUrl: string;
}

export interface Suite extends SuiteInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SuiteStatus;
  counts: SuiteCounts;
  tests?: TestCase[];
}

export interface ScriptResponse {
  code: string | null;
  draft: string | null;
  meta: ScriptMeta | null;
  downloadUrl: string | false;
}

export interface RunOptions {
  lighthouse: boolean;
  lighthousePreset: 'desktop' | 'mobile';
}

const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
export const AUTH_REQUIRED = 'e2e-studio:auth-required';

// ---------------------------------------------------------------- session cookie
// The session (signed-in email + server signature) lives in a cookie on this site and is sent to the
// API in the Authorization header on every call. Signing out deletes the cookie.

export interface Session {
  email: string;
  token: string;
}

const COOKIE = 'bal_session';
const COOKIE_PATH = import.meta.env.BASE_URL || '/';

export function getSession(): Session | null {
  const raw = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  try {
    const session = JSON.parse(decodeURIComponent(raw.slice(COOKIE.length + 1)));
    return session?.email && session?.token ? session : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session, maxAgeSeconds: number) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(session))}; Max-Age=${maxAgeSeconds}; Path=${COOKIE_PATH}; SameSite=Lax${secure}`;
}

export function clearSession() {
  document.cookie = `${COOKIE}=; Max-Age=0; Path=${COOKIE_PATH}; SameSite=Lax`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!API_URL) throw new ApiError(0, 'VITE_API_URL is not configured. Run scripts/deploy.py or set it in frontend/.env.local');
  const session = getSession();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) {
    clearSession();
    window.dispatchEvent(new Event(AUTH_REQUIRED));
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const t = (suiteId: string, testId: string) => `/suites/${suiteId}/tests/${testId}`;

export const api = {
  startSignIn: (email: string) =>
    request<{ mode: 'email' | 'code'; token?: string; email: string; expiresIn?: number }>('POST', '/auth/start', { email }),
  verifyCode: (email: string, code: string) =>
    request<{ token: string; email: string; expiresIn: number }>('POST', '/auth/verify', { email, code }),
  listSuites: () => request<Suite[]>('GET', '/suites'),
  createSuite: (input: SuiteInput) => request<Suite>('POST', '/suites', input),
  getSuite: (id: string) => request<Suite>('GET', `/suites/${id}`),
  updateSuite: (id: string, input: SuiteInput) => request<Suite>('PUT', `/suites/${id}`, input),
  deleteSuite: (id: string) => request<unknown>('DELETE', `/suites/${id}`),
  runSuite: (id: string, options: RunOptions) =>
    request<{ started: Run[]; skipped: { testId: string; reason: string }[] }>('POST', `/suites/${id}/run`, options),

  createTest: (suiteId: string, def: TestDefinition) => request<TestCase>('POST', `/suites/${suiteId}/tests`, def),
  getTest: (suiteId: string, testId: string) => request<TestCase>('GET', t(suiteId, testId)),
  updateTest: (suiteId: string, testId: string, def: TestDefinition) => request<TestCase>('PUT', t(suiteId, testId), def),
  deleteTest: (suiteId: string, testId: string) => request<unknown>('DELETE', t(suiteId, testId)),
  generate: (suiteId: string, testId: string) => request<GenerationJob>('POST', `${t(suiteId, testId)}/generate`),
  getGeneration: (suiteId: string, testId: string) => request<GenerationJob>('GET', `${t(suiteId, testId)}/generation`),
  getScript: (suiteId: string, testId: string) => request<ScriptResponse>('GET', `${t(suiteId, testId)}/script`),
  runTest: (suiteId: string, testId: string, options: RunOptions) => request<Run>('POST', `${t(suiteId, testId)}/run`, options),
  getRun: (suiteId: string, testId: string, runId: string) => request<Run>('GET', `${t(suiteId, testId)}/runs/${runId}`),
};
