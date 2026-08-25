/**
 * The only door to the Python tier.
 *
 * Node holds the state and runs the browsers; Python holds the prompts and the
 * model. Everything that needs a model goes through here, which means the whole
 * AI surface can be swapped by pointing AGENT_API_URL somewhere else.
 */
import { AGENT_API_URL, AGENT_TIMEOUT_MS } from '../config.js';
import type { DataField, DerivedStep, TestStep } from '../types.js';
import { ApiError } from '../util/misc.js';

export interface AgentAction {
  id: string;
  label: string;
  description: string;
  /** True when the action needs a free-text instruction from the user. */
  needsInstruction: boolean;
}

export interface GenerateRequest {
  testName: string;
  description: string;
  url: string;
  suiteName: string;
  includeAda: boolean;
  steps: Array<Pick<TestStep, 'index' | 'action' | 'expected'> & { data: DataField[] }>;
  dataFields: DataField[];
}

export interface CodeReply {
  code: string;
  reply: string;
  model: string;
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${AGENT_API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted) {
      throw new ApiError(504, `The agent API did not answer within ${AGENT_TIMEOUT_MS / 1000}s.`);
    }
    throw new ApiError(
      502,
      `Could not reach the agent API at ${AGENT_API_URL}. Start it with \`npm run dev:agents\`. (${cause})`,
    );
  } finally {
    clearTimeout(timer);
  }

  const payload = (await response.json().catch(() => ({}))) as { detail?: string; error?: string };
  if (!response.ok) {
    throw new ApiError(
      response.status === 404 ? 502 : response.status,
      payload.detail || payload.error || `The agent API failed (${response.status}).`,
    );
  }
  return payload as T;
}

export const agents = {
  /** The catalog drives the UI's action buttons, so adding a Python agent needs no UI change. */
  async catalog(): Promise<AgentAction[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${AGENT_API_URL}/agents/catalog`, { signal: controller.signal });
      if (!response.ok) return [];
      return ((await response.json()) as { actions: AgentAction[] }).actions ?? [];
    } catch {
      // The catalog is a convenience; a dead agent tier must not blank the page.
      return [];
    } finally {
      clearTimeout(timer);
    }
  },

  generate: (body: GenerateRequest) => call<CodeReply>('/agents/generate', body),

  /** Free-text change: "also assert the cart badge shows 1". */
  refine: (body: { code: string; instruction: string; url: string; history: unknown[] }) =>
    call<CodeReply>('/agents/refine', body),

  /** A named improvement pass — stability, readability, coverage, performance. */
  improve: (body: { code: string; goal: string; url: string }) =>
    call<CodeReply>('/agents/improve', body),

  /** Deepens the axe/WCAG coverage of an existing spec. */
  ada: (body: { code: string; url: string }) => call<CodeReply>('/agents/ada', body),

  /** Hands the model a real failure report and asks for the fix. */
  fix: (body: { code: string; failure: string; url: string }) =>
    call<CodeReply>('/agents/fix', body),

  /** Plain-English reading of a spec, for the Steps view of generated code. */
  extractSteps: (body: { code: string }) =>
    call<{ steps: DerivedStep[] }>('/agents/steps/extract', body),
};
