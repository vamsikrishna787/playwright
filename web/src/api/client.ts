import type {
  AgentAction,
  AgentResult,
  DataField,
  DerivedStep,
  Run,
  StorageProviderName,
  StorageStatus,
  Suite,
  SuiteDetail,
  SuiteSummary,
  TestCase,
  TestStep,
} from '../types';

/**
 * Every client fetch goes through here, and nothing else in the UI calls fetch.
 *
 * The base path matters: when the app is mounted under a sub-path by an ingress,
 * Next rewrites links and assets on its own but leaves a hand-written fetch
 * alone. It comes from the same BASE_PATH the server reads, exported by
 * next.config.mjs so the two can never drift.
 */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

const url = (path: string) => `${BASE}${path}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url(path), {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error((payload as { error?: string }).error || `Request failed (${response.status})`);
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/** A step on the way to the server: no id yet, and no index — the server numbers them. */
export type StepDraft = Omit<TestStep, 'index'> & { index?: number };
export type FieldDraft = Omit<DataField, 'id'> & { id?: string };

export const api = {
  // Suites -----------------------------------------------------------------

  listSuites: () => request<SuiteSummary[]>('/api/suites'),

  getSuite: (id: string) => request<SuiteDetail>(`/api/suites/${id}`),

  createSuite: (payload: { name: string; description?: string; baseUrl?: string }) =>
    request<Suite>('/api/suites', { method: 'POST', body: JSON.stringify(payload) }),

  updateSuite: (id: string, payload: Partial<Pick<Suite, 'name' | 'description' | 'baseUrl'>>) =>
    request<Suite>(`/api/suites/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  deleteSuite: (id: string) => request<void>(`/api/suites/${id}`, { method: 'DELETE' }),

  /**
   * Saves the suite's shared data pool. Deleting a field also unhooks it from
   * any step in the suite that referenced it.
   */
  saveSuiteData: (id: string, dataFields: FieldDraft[]) =>
    request<Suite>(`/api/suites/${id}/data`, {
      method: 'PUT',
      body: JSON.stringify({ dataFields }),
    }),

  /** Runs every test in the suite that has a script. */
  runSuite: (id: string) => request<Run[]>(`/api/suites/${id}/runs`, { method: 'POST' }),

  // Tests ------------------------------------------------------------------

  createTest: (suiteId: string, payload: { name: string; url?: string; description?: string }) =>
    request<TestCase>(`/api/suites/${suiteId}/tests`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getTest: (id: string) => request<TestCase & { code: string }>(`/api/tests/${id}`),

  updateTest: (
    id: string,
    payload: Partial<Pick<TestCase, 'name' | 'description' | 'url' | 'includeAda'>>,
  ) => request<TestCase>(`/api/tests/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  deleteTest: (id: string) => request<void>(`/api/tests/${id}`, { method: 'DELETE' }),

  copyTest: (id: string) => request<TestCase>(`/api/tests/${id}/copy`, { method: 'POST' }),

  /** Whole-list save: the editor is a form, not a spreadsheet. */
  saveSteps: (id: string, steps: StepDraft[]) =>
    request<TestCase>(`/api/tests/${id}/steps`, {
      method: 'PUT',
      body: JSON.stringify({ steps }),
    }),

  // Script -----------------------------------------------------------------

  getScript: (id: string) =>
    request<{ code: string; updatedAt: string | null }>(`/api/tests/${id}/script`),

  saveScript: (id: string, code: string) =>
    request<TestCase>(`/api/tests/${id}/script`, { method: 'PUT', body: JSON.stringify({ code }) }),

  /** Steps + data -> a Playwright spec, via the Python agent tier. Always saved. */
  generate: (id: string, suiteName: string) =>
    request<AgentResult>(`/api/tests/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ suiteName }),
    }),

  /**
   * Every other agent call. Returns the new code without saving unless asked,
   * so the result can be reviewed before it replaces what is saved.
   */
  runAgent: (
    id: string,
    action: string,
    payload: { code: string; instruction?: string; goal?: string; save?: boolean },
  ) =>
    request<AgentResult>(`/api/tests/${id}/agent/${action}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  derivedSteps: (id: string, code: string) =>
    request<{ steps: DerivedStep[] }>(`/api/tests/${id}/derived-steps`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  agentCatalog: () => request<{ actions: AgentAction[] }>('/api/agents/catalog'),

  // Runs -------------------------------------------------------------------

  listRuns: (testId: string) => request<Run[]>(`/api/tests/${testId}/runs`),

  startRun: (testId: string) => request<Run>(`/api/tests/${testId}/runs`, { method: 'POST' }),

  getRun: (runId: string) => request<Run>(`/api/runs/${runId}`),

  videoUrl: (runId: string) => url(`/api/runs/${runId}/video`),
  /**
   * Named down to index.html on purpose. The Playwright report asks for `data/*`
   * beside itself, so the document has to sit one level *inside* /report for
   * those relative requests to land back on the catch-all; ending the URL at
   * `/report` resolves them a level too high and the report renders with its
   * attachments missing. A trailing slash would do the same job, but Next
   * redirects that away by default.
   */
  reportUrl: (runId: string) => url(`/api/runs/${runId}/report/index.html`),
  lighthouseUrl: (runId: string) => url(`/api/runs/${runId}/lighthouse`),
  eventsUrl: (runId: string) => url(`/api/runs/${runId}/events`),

  // Storage ----------------------------------------------------------------

  storage: () => request<StorageStatus>('/api/storage'),

  /** Flips where everything is saved. `copyExisting` brings the data along. */
  setStorage: (provider: StorageProviderName, copyExisting: boolean) =>
    request<StorageStatus>('/api/storage', {
      method: 'PUT',
      body: JSON.stringify({ provider, copyExisting }),
    }),

  health: () =>
    request<{
      ok: boolean;
      env: string;
      agentApi: { url: string; reachable: boolean; actions: number };
      storage: { provider: StorageProviderName; target: string };
    }>('/api/health'),
};
