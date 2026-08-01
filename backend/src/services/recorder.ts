import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from '@playwright/test';
import { capturePage, type PageReport } from './explorer.js';

export interface RecordingSession {
  id: string;
  startUrl: string;
  status: 'recording' | 'finished' | 'error';
  pages: PageReport[];
  error: string | null;
  startedAt: string;
}

/** Live sessions, keyed by id. Recordings are short-lived and in-memory only. */
const sessions = new Map<string, RecordingSession>();
const browsers = new Map<string, Browser>();

/** Sessions left open forever would keep a browser and its memory alive. */
const MAX_SESSION_MS = 30 * 60 * 1000;

export function getSession(id: string): RecordingSession | undefined {
  return sessions.get(id);
}


/**
 * Opens a visible browser and inventories every page the user lands on.
 *
 * The human drives: they log in, dismiss banners, and navigate wherever the
 * scenario needs to go. We only watch and take inventory, which is what makes
 * locators on page 2 real instead of guessed. Closing the window ends it.
 */
export async function startRecording(startUrl: string): Promise<RecordingSession> {
  const id = randomUUID();
  const session: RecordingSession = {
    id,
    startUrl,
    status: 'recording',
    pages: [],
    error: null,
    startedAt: new Date().toISOString(),
  };
  sessions.set(id, session);

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  browsers.set(id, browser);

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  // Capturing is serialised: a fast click sequence can fire several navigations
  // while an earlier capture is still running, and concurrent evaluate() calls
  // on the same page race each other.
  let queue: Promise<void> = Promise.resolve();
  const captureNow = (target: Page) => {
    queue = queue
      .then(async () => {
        if (session.status !== 'recording' || target.isClosed()) return;
        const report = await capturePage(target, { interact: false });

        // Re-landing on a page we already have (a redirect settling, or the user
        // going back) should refresh it rather than add a duplicate block.
        const existing = session.pages.findIndex((p) => p.url === report.url);
        if (existing >= 0) session.pages[existing] = report;
        else session.pages.push(report);
      })
      .catch(() => {});
    return queue;
  };

  const watch = (target: Page) => {
    target.on('load', () => void captureNow(target));
    target.on('dialog', (d) => d.dismiss().catch(() => {}));
  };

  watch(page);
  // Links that open a new tab are part of the journey too.
  context.on('page', (opened) => {
    watch(opened);
    void captureNow(opened);
  });

  const finish = (status: RecordingSession['status'], error?: string) => {
    if (session.status !== 'recording') return;
    session.status = status;
    if (error) session.error = error;
    browsers.delete(id);
    browser.close().catch(() => {});
  };

  browser.on('disconnected', () => finish('finished'));
  setTimeout(() => finish('finished', 'Recording timed out after 30 minutes.'), MAX_SESSION_MS);

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await captureNow(page);
  } catch (err) {
    finish('error', err instanceof Error ? err.message : String(err));
  }

  return session;
}

/** Ends a recording from the UI, for when the window is out of reach. */
export async function stopRecording(id: string): Promise<RecordingSession | undefined> {
  const session = sessions.get(id);
  if (!session) return undefined;

  const browser = browsers.get(id);
  if (browser) {
    browsers.delete(id);
    // 'disconnected' fires on close and flips the status to finished.
    await browser.close().catch(() => {});
  } else if (session.status === 'recording') {
    session.status = 'finished';
  }

  return session;
}

export function discardSession(id: string): void {
  sessions.delete(id);
}
