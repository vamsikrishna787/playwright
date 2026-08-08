import type {
  ConflictResolution,
  DomainLibrary,
  DomainRecord,
  DomainSummary,
  LibraryDocument,
  LocatorConflict,
  RecordingSession,
  RunRecord,
  ScriptRecord,
  ScriptStep,
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

type GeneratedScript = ScriptRecord & { code: string };

export const api = {
  // Sites ------------------------------------------------------------------

  listDomains: () => request<DomainSummary[]>('/api/domains'),

  getDomain: (id: string) =>
    request<DomainSummary & { pages: Array<{ url: string; title: string; locatorCount: number }> }>(
      `/api/domains/${id}`,
    ),

  addDomain: (url: string) =>
    request<DomainRecord>('/api/domains', { method: 'POST', body: JSON.stringify({ url }) }),

  renameDomain: (id: string, name: string) =>
    request<DomainRecord>(`/api/domains/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  deleteDomain: (id: string) => request<void>(`/api/domains/${id}`, { method: 'DELETE' }),

  /** Free text plus the site's own recorded locators — no browser opens. */
  generateWithAi: (id: string, payload: { prompt: string; url?: string; name?: string }) =>
    request<GeneratedScript>(`/api/domains/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Locator library --------------------------------------------------------

  getLibrary: (id: string) => request<DomainLibrary>(`/api/domains/${id}/locators`),

  // The two writes answer with the library alone — no site record — so a caller
  // merging the response keeps the one it already has.
  deleteLocator: (id: string, payload: { pageUrl: string; key?: string }) =>
    request<LibraryDocument>(`/api/domains/${id}/locators/delete`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** Hand-edit one entry. Omitted fields are left as they are. */
  updateLocator: (
    id: string,
    payload: {
      pageUrl: string;
      key: string;
      locator?: string;
      name?: string;
      alternates?: string[];
    },
  ) =>
    request<LibraryDocument>(`/api/domains/${id}/locators/update`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  promoteLocator: (id: string, payload: { pageUrl: string; key: string; locator: string }) =>
    request<LibraryDocument>(`/api/domains/${id}/locators/promote`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Scripts ----------------------------------------------------------------

  listScripts: (domainId?: string) =>
    request<ScriptRecord[]>(domainId ? `/api/scripts?domainId=${domainId}` : '/api/scripts'),

  getScript: (id: string) => request<GeneratedScript & { steps: ScriptStep[] }>(`/api/scripts/${id}`),

  /** Plain-English reading of the editor buffer, saved or not. */
  previewSteps: (code: string) =>
    request<{ steps: ScriptStep[] }>('/api/scripts/steps', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  updateScript: (id: string, payload: { name?: string; code?: string }) =>
    request<ScriptRecord>(`/api/scripts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  deleteScript: (id: string) => request<void>(`/api/scripts/${id}`, { method: 'DELETE' }),

  enhance: (
    id: string,
    payload: {
      instruction: string;
      code: string;
      history: Array<{ role: 'user' | 'assistant'; text: string }>;
    },
  ) =>
    request<{ code: string; reply: string }>(`/api/scripts/${id}/enhance`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Runs -------------------------------------------------------------------

  listRuns: (scriptId: string) => request<RunRecord[]>(`/api/scripts/${scriptId}/runs`),

  startRun: (scriptId: string) =>
    request<RunRecord>(`/api/scripts/${scriptId}/runs`, { method: 'POST' }),

  runAll: (domainId?: string) =>
    request<RunRecord[]>(
      domainId ? `/api/scripts/run-all?domainId=${domainId}` : '/api/scripts/run-all',
      { method: 'POST' },
    ),

  latestRuns: () => request<Record<string, RunRecord>>('/api/runs/latest'),

  getRun: (runId: string) => request<RunRecord>(`/api/runs/${runId}`),

  videoUrl: (runId: string) => `/api/runs/${runId}/video`,

  reportUrl: (runId: string) => `/api/runs/${runId}/report`,

  // Recording --------------------------------------------------------------

  startRecording: (payload: { url: string; domainId?: string }) =>
    request<RecordingSession>('/api/recordings', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getRecording: (id: string) => request<RecordingSession>(`/api/recordings/${id}`),

  stopRecording: (id: string) =>
    request<RecordingSession>(`/api/recordings/${id}/stop`, { method: 'POST' }),

  /** Locators that changed since these pages were last recorded. */
  getConflicts: (id: string) =>
    request<{ conflicts: LocatorConflict[] }>(`/api/recordings/${id}/conflicts`),

  generateFromRecording: (
    id: string,
    payload: { prompt: string; name?: string; resolutions: ConflictResolution[] },
  ) =>
    request<GeneratedScript>(`/api/recordings/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
