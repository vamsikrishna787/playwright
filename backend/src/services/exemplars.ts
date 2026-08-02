import fs from 'node:fs/promises';
import { EXEMPLAR_MAX_CHARS, MAX_EXEMPLARS, specFilePath } from '../config.js';
import type { RunRecord, ScriptRecord } from '../types.js';
import { runsStore, scriptsStore } from './storage.js';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Scripts whose most recent finished run passed. A script that has never run, or
 * whose last run failed, is not a pattern worth teaching — showing the model a
 * broken file is worse than showing it none.
 */
async function provenScripts(excludeId?: string): Promise<ScriptRecord[]> {
  const [scripts, runs] = await Promise.all([scriptsStore.read(), runsStore.read()]);

  const latest = new Map<string, RunRecord>();
  for (const run of runs) {
    // A run still in flight says nothing about the script yet.
    if (run.status === 'queued' || run.status === 'running') continue;
    const held = latest.get(run.scriptId);
    if (!held || Date.parse(run.startedAt) > Date.parse(held.startedAt)) {
      latest.set(run.scriptId, run);
    }
  }

  return scripts.filter((s) => s.id !== excludeId && latest.get(s.id)?.status === 'passed');
}

/**
 * Picks a couple of previously-passing specs to show alongside the generation
 * request. Same-site scripts rank first: they exercise the same DOM, so their
 * waiting and assertion patterns transfer directly. Newest wins after that,
 * which makes the library self-improving — fix a script, run it green, and it
 * becomes the example the next generation follows.
 */
export async function findExemplars(input: {
  url: string;
  excludeId?: string;
}): Promise<string[]> {
  const proven = await provenScripts(input.excludeId);
  if (proven.length === 0) return [];

  const host = hostOf(input.url);
  const ranked = [...proven].sort((a, b) => {
    const bySite =
      Number(hostOf(b.sourceUrl) === host) - Number(hostOf(a.sourceUrl) === host);
    return bySite || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });

  const picked: string[] = [];
  for (const script of ranked) {
    if (picked.length >= MAX_EXEMPLARS) break;
    const code = await fs.readFile(specFilePath(script.id), 'utf-8').catch(() => '');
    // Oversized files are skipped rather than truncated: half a spec teaches a
    // structure that does not close its own braces.
    if (!code.trim() || code.length > EXEMPLAR_MAX_CHARS) continue;
    picked.push(code.trim());
  }

  return picked;
}
