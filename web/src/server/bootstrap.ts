/**
 * One-time process start-up: the work that used to sit at the bottom of an
 * Express server file.
 *
 * Awaited by the `route` wrapper rather than from instrumentation.ts, because
 * Next compiles instrumentation for the Edge runtime as well and that bundler
 * refuses an import of node:fs even behind a `NEXT_RUNTIME` guard. Every route
 * here is Node, and this is idempotent, so the first request pays for it and
 * the rest see a resolved promise.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { APP_ENV, appConfig } from '../config/appConfig';
import { work } from './paths';
import { getStorage } from './storage';
import { hoistDataToSuites } from './store/migrate';

let started: Promise<void> | null = null;

async function start(): Promise<void> {
  await fs.mkdir(work.scriptsDir, { recursive: true });
  await fs.mkdir(path.join(work.root, 'runs'), { recursive: true });

  console.log(`[app]     ${appConfig.app.name} (${APP_ENV})`);
  // getStorage announces which provider it opened, so there is no second line
  // for it here.
  await getStorage();
  console.log(`[agents]  ${appConfig.agents.baseUrl}`);

  // Test data used to live on each test; it is a suite-level pool now.
  await hoistDataToSuites();
}

/** Idempotent: a second call waits on the first rather than repeating it. */
export function bootstrap(): Promise<void> {
  started ??= start().catch((error) => {
    console.error('[app] start-up failed:', error);
    // Cleared so a transient failure (an unreachable bucket at boot) can be
    // retried by the next request rather than poisoning the process.
    started = null;
    throw error;
  });
  return started;
}
