import type { RecordingSession, RunRecord, ScriptRecord } from '../types';

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

export const api = {
  listScripts: () => request<ScriptRecord[]>('/api/scripts'),

  getScript: (id: string) => request<ScriptRecord & { code: string }>(`/api/scripts/${id}`),

  generate: (payload: { url: string; prompt: string; name?: string }) =>
    request<ScriptRecord & { code: string }>('/api/scripts/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
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

  listRuns: (scriptId: string) => request<RunRecord[]>(`/api/scripts/${scriptId}/runs`),

  startRun: (scriptId: string) =>
    request<RunRecord>(`/api/scripts/${scriptId}/runs`, { method: 'POST' }),

  runAll: () => request<RunRecord[]>('/api/scripts/run-all', { method: 'POST' }),

  latestRuns: () => request<Record<string, RunRecord>>('/api/runs/latest'),

  startRecording: (url: string) =>
    request<RecordingSession>('/api/recordings', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  getRecording: (id: string) => request<RecordingSession>(`/api/recordings/${id}`),

  stopRecording: (id: string) =>
    request<RecordingSession>(`/api/recordings/${id}/stop`, { method: 'POST' }),

  generateFromRecording: (id: string, payload: { prompt: string; name?: string }) =>
    request<ScriptRecord & { code: string }>(`/api/recordings/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getRun: (runId: string) => request<RunRecord>(`/api/runs/${runId}`),

  videoUrl: (runId: string) => `/api/runs/${runId}/video`,

  reportUrl: (runId: string) => `/api/runs/${runId}/report`,
};
