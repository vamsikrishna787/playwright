import type {
  AgentAction,
  AgentResult,
  DataField,
  DerivedStep,
  Run,
  Suite,
  SuiteDetail,
  SuiteSummary,
  TestCase,
  TestStep,
} from '../types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Request failed (${response.status})`);
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
   * so the result can be reviewed before it replaces what is on disk.
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

  videoUrl: (runId: string) => `/api/runs/${runId}/video`,
  reportUrl: (runId: string) => `/api/runs/${runId}/report`,
  lighthouseUrl: (runId: string) => `/api/runs/${runId}/lighthouse`,
  eventsUrl: (runId: string) => `/api/runs/${runId}/events`,

  health: () =>
    request<{ ok: boolean; agentApi: { url: string; reachable: boolean; actions: number } }>(
      '/api/health',
    ),
};
