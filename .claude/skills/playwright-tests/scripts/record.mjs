#!/usr/bin/env node
/**
 * Record mode — a real browser opens, you drive it, and every step you take is
 * captured along with a full locator inventory and a WCAG audit of each page
 * you land on. Close the window when you are done.
 *
 * This is the mode to use whenever the flow crosses a login or spans more than
 * one page: locators past the entry page are then observed rather than guessed.
 *
 *   node record.mjs <startUrl> [options]
 *
 *   --out <dir>        artifact directory (default .playwright-capture/record-<ts>)
 *   --browser <name>   chromium | firefox | webkit   (default chromium)
 *   --minutes <n>      auto-finish after n minutes (default 30)
 *   --no-a11y          skip the axe audit on each page
 *   --keep-secrets     record password values literally (default: masked)
 *   --test-id-attribute  the host project's testIdAttribute (default data-testid)
 *   --print            also print the markdown to stdout
 *
 * Passwords and other secret-looking fields are masked inside the browser, so a
 * real credential never reaches this process. Pass --keep-secrets only for
 * throwaway test accounts.
 */
import { relative } from 'node:path';
import { loadPlaywright, loadAxe } from './lib/resolve.mjs';
import { capturePage, formatPage, formatAxeSummary, formatSteps, collapseSteps } from './lib/inventory.mjs';
import { PAGE_AGENT, RECORDER_AGENT } from './lib/page-agent.mjs';
import { parseArgs, prepareOutDir, writeArtifacts } from './lib/output.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const startUrl = positional[0];

if (!startUrl) {
  console.error('Usage: node record.mjs <startUrl> [--minutes 30] [--keep-secrets]');
  process.exit(1);
}

const browserName = typeof flags.browser === 'string' ? flags.browser : 'chromium';
const minutes = Number(flags.minutes) || 30;
const wantAxe = flags.a11y !== false;

let playwright;
try {
  playwright = loadPlaywright(process.cwd());
} catch (err) {
  // A missing dependency is a setup problem, not a crash — a stack trace here
  // buries the one line that says what to install.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const axe = wantAxe ? loadAxe(process.cwd()) : null;
const launcher = playwright[browserName];

if (!launcher) {
  console.error(`Unknown browser "${browserName}". Use chromium, firefox or webkit.`);
  process.exit(1);
}

const outDir = prepareOutDir(typeof flags.out === 'string' ? flags.out : null, 'record');

const browser = await launcher.launch({ headless: false, args: ['--start-maximized'] });
const context = await browser.newContext({ viewport: null });

/** Steps in the order they happened. */
const steps = [];
/** One inventory per distinct page URL, in the order they were first reached. */
const pages = [];

// Captures are serialised: a fast click sequence fires several navigations while
// an earlier capture is still running, and concurrent evaluate() calls on one
// page race each other.
let queue = Promise.resolve();
let finished = false;

// The binding has to exist before any init script runs, or the first clicks on
// the landing page report into nothing.
await context.exposeBinding('__pwRecordStep', (source, step) => {
  if (finished) return;
  steps.push(step);
  scheduleRecapture(source.page);
});

if (typeof flags['test-id-attribute'] === 'string') {
  await context.addInitScript({
    content: `window.__pwTestIdAttribute = ${JSON.stringify(flags['test-id-attribute'])};`,
  });
}
await context.addInitScript({ content: PAGE_AGENT });
if (flags['keep-secrets']) {
  await context.addInitScript({ content: 'window.__pwKeepSecrets = true;' });
}
await context.addInitScript({ content: RECORDER_AGENT });

// A single navigation raises both the context's page event and the page's load
// event, and re-auditing the same unchanged page costs an axe run each time.
// The step count is part of the signature, so a page still gets re-inventoried
// once the user has actually done something to it.
let lastSignature = '';

function captureNow(page) {
  queue = queue
    .then(async () => {
      if (finished || page.isClosed()) return;
      const signature = `${page.url()}|${steps.length}`;
      if (signature === lastSignature) return;
      lastSignature = signature;

      const report = await capturePage(page, { interact: false, axe });
      const existing = pages.findIndex((held) => held.url === report.url);
      // Re-landing on a known page (a redirect settling, the user going back,
      // or a menu that just opened) refreshes it rather than duplicating it.
      if (existing >= 0) pages[existing] = report;
      else pages.push(report);
      process.stdout.write(`  captured ${report.url}\n`);
    })
    .catch(() => {});
  return queue;
}

/**
 * Elements that appear only after an interaction — an opened menu, a revealed
 * error — are invisible to a load-time capture, so the current page is
 * re-inventoried once the user pauses.
 */
const recaptureTimers = new Map();
function scheduleRecapture(page) {
  if (!page || finished) return;
  clearTimeout(recaptureTimers.get(page));
  recaptureTimers.set(
    page,
    setTimeout(() => {
      recaptureTimers.delete(page);
      void captureNow(page);
    }, 1500),
  );
}

let lastUrl = '';
// context.newPage() also raises the context's page event, so the first page
// would otherwise be watched twice and capture everything in duplicate.
const watched = new WeakSet();

function watch(page) {
  if (watched.has(page)) return;
  watched.add(page);

  page.on('load', () => void captureNow(page));
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame() || finished) return;
    const url = frame.url();
    if (!url || url === 'about:blank' || url === lastUrl) return;
    lastUrl = url;
    steps.push({ kind: 'navigate', url, at: Date.now() });
  });
}

context.on('page', (opened) => {
  // A link that opens a new tab is part of the journey too.
  watch(opened);
  void captureNow(opened);
});

const page = await context.newPage();
watch(page);

async function finish(reason) {
  if (finished) return;
  finished = true;
  for (const timer of recaptureTimers.values()) clearTimeout(timer);
  await queue.catch(() => {});
  await browser.close().catch(() => {});

  const ordered = collapseSteps(steps);
  const indexOfUrl = (url) => {
    const found = pages.findIndex((held) => held.url === url);
    return found >= 0 ? found + 1 : 1;
  };

  const header = [
    '# Recorded journey',
    '',
    `Captured: ${new Date().toISOString()}`,
    `Start URL: ${startUrl}`,
    `Finished because: ${reason}`,
    `Pages visited: ${pages.length} · steps recorded: ${ordered.length}`,
    `Accessibility: ${axe ? axe.source : 'not run — install @axe-core/playwright'}`,
    flags['keep-secrets'] ? 'Secrets: recorded literally (--keep-secrets)' : 'Secrets: masked',
    '',
    'Every locator below was observed on a page the user actually reached, so',
    'locators for page 2 and beyond are real. Keep the step order: a locator from',
    'a later page does not exist until the test has navigated there.',
    '',
  ];

  const markdown = [
    header.join('\n'),
    formatSteps(ordered, (step) => indexOfUrl(step.url)),
    pages.map((report, i) => formatPage(report, `Page ${i + 1} of ${pages.length}`)).join('\n\n'),
    formatAxeSummary(pages),
  ]
    .filter((section) => section)
    .join('\n\n');

  const { mdPath, jsonPath } = writeArtifacts(outDir, 'journey', {
    markdown,
    json: { mode: 'record', startUrl, reason, steps: ordered, pages },
  });

  if (flags.print) console.log(markdown);

  console.log(
    [
      '',
      `Recording finished (${reason}).`,
      `${pages.length} page(s), ${ordered.length} step(s).`,
      `  markdown: ${relative(process.cwd(), mdPath) || mdPath}`,
      `  json:     ${relative(process.cwd(), jsonPath) || jsonPath}`,
    ].join('\n'),
  );
  process.exit(0);
}

browser.on('disconnected', () => void finish('browser window closed'));
process.on('SIGINT', () => void finish('interrupted'));
setTimeout(() => void finish(`time limit of ${minutes} minute(s) reached`), minutes * 60_000).unref();

console.log(
  [
    `Recording ${startUrl} in ${browserName}.`,
    'Drive the flow yourself — log in, dismiss banners, go wherever the test needs to go.',
    'Close the browser window when you are done, and the journey is written out.',
    '',
  ].join('\n'),
);

try {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await captureNow(page);
} catch (err) {
  console.error(`Could not open ${startUrl}: ${err instanceof Error ? err.message : String(err)}`);
  await finish('start URL failed to load');
}
