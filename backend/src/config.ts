import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

export const BACKEND_ROOT = path.resolve(here, '..');

dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

export const PORT = Number(process.env.PORT) || 3001;

export const DATA_DIR = path.join(BACKEND_ROOT, 'data');
export const SCRIPTS_DIR = path.join(BACKEND_ROOT, 'scripts');
export const RUNS_DIR = path.join(BACKEND_ROOT, 'runs');

export const SCRIPTS_JSON = path.join(DATA_DIR, 'scripts.json');
export const RUNS_JSON = path.join(DATA_DIR, 'runs.json');

export const RUNNER_CONFIG_PATH = path.join(here, 'playwright.runner.config.ts');

export const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
export const BEDROCK_API_KEY = process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() || '';
export const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-opus-4-5-20251101-v1:0';

export const SNAPSHOT_MAX_CHARS = 15_000;

export async function ensureDirs(): Promise<void> {
  await Promise.all(
    [DATA_DIR, SCRIPTS_DIR, RUNS_DIR].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
}

export function specFileName(scriptId: string): string {
  return `${scriptId}.spec.ts`;
}

export function specFilePath(scriptId: string): string {
  return path.join(SCRIPTS_DIR, specFileName(scriptId));
}

// The page snapshot is kept beside the spec rather than in scripts.json so the
// index stays small, and so later edits can be grounded in the real page.
export function snapshotFilePath(scriptId: string): string {
  return path.join(SCRIPTS_DIR, `${scriptId}.snapshot.txt`);
}

export function runDir(scriptId: string, runId: string): string {
  return path.join(RUNS_DIR, scriptId, runId);
}
