#!/usr/bin/env node
/**
 * Scrape mode — give it URLs, get back every locator on those pages plus a WCAG
 * audit. Nothing is submitted, so it is safe to point at a live site.
 *
 *   node scrape.mjs <url> [<url> ...] [options]
 *
 *   --scenario "<text>"  what the test will do; steers exploratory input values
 *   --out <dir>          artifact directory (default .playwright-capture/scrape-<ts>)
 *   --no-interact        do not fill inputs or open menus, just read the page
 *   --no-a11y            skip the axe audit
 *   --headed             show the browser (useful when a page blocks headless)
 *   --browser <name>     chromium | firefox | webkit   (default chromium)
 *   --timeout <ms>       navigation timeout (default 30000)
 *   --test-id-attribute  the host project's testIdAttribute (default data-testid)
 *   --print              also print the markdown to stdout
 */
import { relative } from 'node:path';
import { loadPlaywright, loadAxe } from './lib/resolve.mjs';
import { capturePage, formatPage, formatAxeSummary } from './lib/inventory.mjs';
import { PAGE_AGENT } from './lib/page-agent.mjs';
import { parseArgs, prepareOutDir, writeArtifacts } from './lib/output.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));

if (positional.length === 0) {
  console.error('Usage: node scrape.mjs <url> [<url> ...] [--scenario "..."] [--out <dir>]');
  process.exit(1);
}

const urls = positional;
const interact = flags.interact !== false;
const wantAxe = flags.a11y !== false;
const browserName = typeof flags.browser === 'string' ? flags.browser : 'chromium';
const timeout = Number(flags.timeout) || 30_000;

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

const outDir = prepareOutDir(typeof flags.out === 'string' ? flags.out : null, 'scrape');

const browser = await launcher.launch({ headless: flags.headed !== true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
if (typeof flags['test-id-attribute'] === 'string') {
  await context.addInitScript({
    content: `window.__pwTestIdAttribute = ${JSON.stringify(flags['test-id-attribute'])};`,
  });
}
await context.addInitScript({ content: PAGE_AGENT });

const page = await context.newPage();
page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

const reports = [];
const failures = [];

for (const url of urls) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    reports.push(
      await capturePage(page, {
        interact,
        scenario: typeof flags.scenario === 'string' ? flags.scenario : undefined,
        axe,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ url, message });
    console.error(`Failed on ${url}: ${message}`);
  }
}

await browser.close().catch(() => {});

if (reports.length === 0) {
  console.error('No page could be captured.');
  process.exit(1);
}

const header = [
  '# Page inventory',
  '',
  `Captured: ${new Date().toISOString()}`,
  `Mode: scrape${interact ? ' (with exploratory interaction)' : ' (read-only)'}`,
  `Accessibility: ${axe ? axe.source : 'not run — install @axe-core/playwright'}`,
  ...(typeof flags.scenario === 'string' ? [`Scenario: ${flags.scenario}`] : []),
  '',
  'Every locator below was observed on the live page. Use them verbatim; do not',
  'invent elements. Pages reached only after submitting a form are NOT here —',
  'record the journey instead if the flow crosses a login or a submit.',
  '',
];

const body = reports.map((report, i) =>
  formatPage(report, reports.length > 1 ? `Page ${i + 1} of ${reports.length}` : 'Page'),
);

const summary = formatAxeSummary(reports);
const markdown = [
  header.join('\n'),
  body.join('\n\n'),
  ...(summary ? ['', summary] : []),
].join('\n');

const { mdPath, jsonPath } = writeArtifacts(outDir, 'inventory', {
  markdown,
  json: { mode: 'scrape', urls, interact, failures, pages: reports },
});

if (flags.print) console.log(markdown);

const elementCount = reports.reduce((total, report) => total + report.elements.length, 0);
const violationCount = reports.reduce((total, report) => total + (report.axe?.length ?? 0), 0);

console.log(
  [
    '',
    `Captured ${reports.length} page(s), ${elementCount} locator(s), ${violationCount} accessibility violation(s).`,
    `  markdown: ${relative(process.cwd(), mdPath) || mdPath}`,
    `  json:     ${relative(process.cwd(), jsonPath) || jsonPath}`,
  ].join('\n'),
);
