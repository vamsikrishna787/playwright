import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { Result as AxeResult } from 'axe-core';
import { SNAPSHOT_MAX_CHARS } from '../config.js';

export interface DiscoveredElement {
  /** Playwright locator expression, e.g. getByRole('button', { name: 'Search' }). */
  locator: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  /** Only present once we've revealed it by interacting. */
  revealedBy?: string;
}

export interface AxeIssue {
  id: string;
  impact: string;
  help: string;
  nodes: number;
  sample: string;
}

export interface PageReport {
  url: string;
  title: string;
  headings: string[];
  elements: DiscoveredElement[];
  axe: AxeIssue[];
  notes: string[];
  /** Behavioural facts the model needs but cannot infer from a locator list. */
  hints: string[];
}

const SUBMIT_WORDS =
  /\b(submit|save|buy|order|purchase|pay|checkout|delete|remove|confirm|send|register|sign\s?up|subscribe|book|apply|continue|next|log\s?in|sign\s?in)\b/i;

const LOCATION_FIELD = /where|origin|destination|airport|city|depart|arriv|from|to\b|location|place/i;

/**
 * Sample values by input type. Getting these right matters more than it looks:
 * an autocomplete fed a meaningless string returns no suggestions, so the
 * dependent UI never appears and the crawl misses half the page.
 */
function sampleValue(type: string, name: string, context?: string): string {
  if (/email/i.test(type + name)) return 'test@example.com';
  if (/password/i.test(type + name)) return 'Passw0rd!23';
  if (/tel|phone/i.test(type + name)) return '5551234567';
  if (type === 'number') return '1';
  if (type === 'date') return '2026-01-01';
  if (type === 'time') return '12:00';
  if (type === 'url') return 'https://example.com';
  if (/zip|postal/i.test(name)) return '10001';

  if (LOCATION_FIELD.test(name)) {
    // Pull the places out of the user's own scenario, and keep origin and
    // destination distinct — filling both with the same city gives the
    // destination field a useless suggestion list.
    const place = /([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?)/.source;
    const origin = context?.match(new RegExp(`\\bfrom\\s+${place}`))?.[1];
    const destination = context?.match(new RegExp(`\\bto\\s+${place}`))?.[1];

    if (/where to|destination|arriv|\bto\b/i.test(name)) return destination ?? 'Phoenix';
    if (/where from|origin|depart|\bfrom\b/i.test(name)) return origin ?? 'Dallas';
    return origin ?? destination ?? 'Dallas';
  }

  if (/full ?name|first ?name|last ?name|your name/i.test(name)) return 'Test User';
  if (/search|query|keyword/i.test(name)) return 'test';
  return 'test';
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Prefer a role+name locator, falling back through label, placeholder, then testid. */
function buildLocator(el: {
  role: string;
  name: string;
  tag?: string;
  placeholder?: string;
  testId?: string;
  label?: string;
}): string {
  if (el.testId) return `getByTestId(${quote(el.testId)})`;
  if (el.role && el.name) return `getByRole(${quote(el.role)}, { name: ${quote(el.name)} })`;
  if (el.label) return `getByLabel(${quote(el.label)})`;
  if (el.placeholder) return `getByPlaceholder(${quote(el.placeholder)})`;

  // An unlabelled form control has no accessible name to match on, so a bare
  // role locator would be ambiguous the moment there are two of them. A tag
  // selector at least resolves deterministically with .first().
  if (el.tag && ['select', 'textarea'].includes(el.tag)) return `locator(${quote(el.tag)})`;

  if (el.role) return `getByRole(${quote(el.role)})`;
  return `getByText(${quote(el.name)})`;
}

/** Harvest every interactive element currently in the DOM. */
async function harvest(page: Page): Promise<DiscoveredElement[]> {
  const raw = await page.evaluate(() => {
    // tsx compiles via esbuild, which annotates named function expressions with a
    // __name helper. That helper does not exist inside the page, so it has to be
    // shimmed before any of the consts below are initialised.
    const scope = globalThis as unknown as Record<string, unknown>;
    if (typeof scope.__name !== 'function') scope.__name = (fn: unknown) => fn;

    const visible = (node: Element) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    };

    const accessibleName = (node: Element): string => {
      const aria = node.getAttribute('aria-label');
      if (aria) return aria.trim();
      const labelledBy = node.getAttribute('aria-labelledby');
      if (labelledBy) {
        const target = document.getElementById(labelledBy);
        if (target?.textContent) return target.textContent.trim();
      }
      const id = node.getAttribute('id');
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label?.textContent) return label.textContent.trim();
      }
      const wrapping = node.closest('label');
      if (wrapping?.textContent) return wrapping.textContent.trim();
      const alt = node.getAttribute('alt');
      if (alt) return alt.trim();
      const value = (node as HTMLInputElement).value;
      if (node.tagName === 'INPUT' && value && (node as HTMLInputElement).type === 'submit') {
        return value.trim();
      }
      // Form controls take their name from a label or ARIA only. Falling back to
      // textContent here would turn a <select>'s own options into a bogus name
      // like "VisaAmex", producing a locator that never matches at runtime.
      if (['SELECT', 'INPUT', 'TEXTAREA'].includes(node.tagName)) return '';
      return (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    };

    const roleOf = (node: Element): string => {
      const explicit = node.getAttribute('role');
      if (explicit) return explicit;
      const tag = node.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (node as HTMLInputElement).type;
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button') return 'button';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return '';
    };

    const selector =
      'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=combobox], [contenteditable=true], summary';

    return Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .slice(0, 120)
      .map((node) => {
        const input = node as HTMLInputElement & HTMLSelectElement;
        return {
          tag: node.tagName.toLowerCase(),
          role: roleOf(node),
          name: accessibleName(node),
          type: input.type || undefined,
          placeholder: input.placeholder || undefined,
          required: input.required || undefined,
          testId:
            node.getAttribute('data-testid') || node.getAttribute('data-test-id') || undefined,
          options:
            node.tagName === 'SELECT'
              ? Array.from(input.options ?? [])
                  .slice(0, 12)
                  .map((o) => o.label || o.value)
              : undefined,
        };
      })
      .filter((el) => el.name || el.placeholder || el.testId);
  });

  return raw.map((el) => ({
    ...el,
    locator: buildLocator({
      role: el.role,
      name: el.name,
      tag: el.tag,
      placeholder: el.placeholder,
      testId: el.testId,
    }),
  }));
}

function key(el: DiscoveredElement): string {
  return `${el.role}|${el.name}|${el.placeholder ?? ''}`;
}

/**
 * getByRole name matching is substring-based, so "Password" also matches
 * "Confirm Password" and the locator fails Playwright's strict mode at runtime.
 * Any name contained in a sibling's name with the same role gets exact: true.
 */
function disambiguate(elements: DiscoveredElement[]): DiscoveredElement[] {
  return elements.map((el) => {
    if (!el.name || !el.locator.startsWith('getByRole')) return el;

    const collides = elements.some(
      (other) =>
        other !== el &&
        other.role === el.role &&
        other.name !== el.name &&
        other.name.toLowerCase().includes(el.name.toLowerCase()),
    );

    if (!collides) return el;
    return {
      ...el,
      locator: el.locator.replace(/\s*\}\)$/, ', exact: true })'),
    };
  });
}

/**
 * Type into a field so dependent UI appears. Comboboxes get special handling:
 * many apps (Google Flights, airline sites, address pickers) only unlock the
 * rest of the form once a suggestion has actually been chosen, so filling alone
 * leaves the submit control hidden and the generated test unrunnable.
 */
async function fillInputs(
  page: Page,
  elements: DiscoveredElement[],
  notes: string[],
  hints: string[],
  context?: string,
) {
  // Only real text inputs. A select-style combobox (trip type, cabin class) is
  // also role=combobox, but clicking one opens a menu that swallows subsequent
  // clicks and changes form state we never wanted to touch.
  const fillable = elements.filter(
    (el) =>
      (el.tag === 'input' || el.tag === 'textarea') &&
      !['checkbox', 'radio', 'submit', 'button', 'file', 'hidden'].includes(el.type ?? ''),
  );

  for (const el of fillable.slice(0, 12)) {
    const label = el.name || el.placeholder || '';
    try {
      const field = resolve(page, el).first();

      // Focus first. Some widgets (Google Flights' airport pickers) only open
      // their suggestion list on real focus, so fill() alone shows nothing.
      await field.click({ timeout: 2500 }).catch(() => {});
      await field.fill(sampleValue(el.type ?? '', label, context), { timeout: 2500 });
      await page.waitForTimeout(400);

      // Select-style comboboxes (trip type, cabin class) also use role=option,
      // and choosing one silently changes form state — only treat real text
      // inputs as autocompletes.
      if (el.tag !== 'input') continue;

      // Visibility matters: closed dropdowns elsewhere on the page keep their
      // options in the DOM, and picking one of those changes unrelated state.
      const options = page.locator('[role="option"]:visible');
      const count = await options.count().catch(() => 0);
      if (count === 0) continue;

      const sample = (await options.allInnerTexts().catch(() => []))
        .map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 3);

      hints.push(
        `"${label}" is an autocomplete. Click it, fill() it, then wait for ` +
          `page.getByRole('option') and click the matching one — the rest of the form ` +
          `stays hidden until a suggestion is committed. Observed options: ${sample.join(' / ')}`,
      );

      await options.first().click({ timeout: 2500 });
      await page.waitForTimeout(600);
    } catch {
      notes.push(`Could not fill ${el.locator}`);
    }
  }
}

/** Click only things that reveal UI — never anything that looks like it commits. */
async function expandDisclosures(page: Page, elements: DiscoveredElement[], notes: string[]) {
  const candidates = elements.filter(
    (el) =>
      (el.role === 'tab' || el.tag === 'summary' || el.role === 'button') &&
      el.name &&
      !SUBMIT_WORDS.test(el.name) &&
      el.type !== 'submit',
  );

  for (const el of candidates.slice(0, 8)) {
    try {
      const before = page.url();
      await resolve(page, el).first().click({ timeout: 2000, trial: false });
      await page.waitForTimeout(250);
      if (page.url() !== before) {
        // Navigation is a side effect we did not want — go back and stop clicking.
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        notes.push(`Clicking ${el.locator} navigated away; skipped further clicks`);
        return;
      }
    } catch {
      notes.push(`Could not expand ${el.locator}`);
    }
  }
}

function resolve(page: Page, el: DiscoveredElement): Locator {
  if (el.placeholder) return page.getByPlaceholder(el.placeholder);
  if (el.role && el.name) return page.getByRole(el.role as never, { name: el.name, exact: false });
  if (el.name) return page.getByText(el.name, { exact: false });
  return page.locator(el.tag);
}

async function runAxe(page: Page): Promise<AxeIssue[]> {
  try {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    return results.violations.slice(0, 15).map((v: AxeResult) => ({
      id: v.id,
      impact: v.impact ?? 'unknown',
      help: v.help,
      nodes: v.nodes.length,
      sample: (v.nodes[0]?.target?.[0] ?? '').toString().slice(0, 120),
    }));
  } catch {
    return [];
  }
}

/**
 * Inventories whatever page is currently loaded: harvests every interactive
 * element, runs an axe audit, and returns a report.
 *
 * `interact` controls whether it also fills inputs and expands disclosures to
 * surface elements that only exist after interaction. That is right for the
 * automatic crawl, but wrong while recording — there a human is driving, and
 * typing into their form underneath them would corrupt the flow.
 */
export async function capturePage(
  page: Page,
  options: { interact?: boolean; context?: string } = {},
): Promise<PageReport> {
  const { interact = true, context } = options;
  const notes: string[] = [];
  const hints: string[] = [];

  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  const title = await page.title().catch(() => '');
  const headings = await page
    .locator('h1, h2')
    .allInnerTexts()
    .then((all) => all.map((h) => h.trim()).filter(Boolean).slice(0, 12))
    .catch(() => []);

  const initial = await harvest(page);
  const seen = new Map(initial.map((el) => [key(el), el]));

  if (interact) {
    await fillInputs(page, initial, notes, hints, context);
    await expandDisclosures(page, initial, notes);

    // Anything new here only existed after we interacted.
    for (const el of await harvest(page)) {
      if (!seen.has(key(el))) {
        seen.set(key(el), { ...el, revealedBy: 'interaction' });
      }
    }
  }

  return {
    url: page.url(),
    title,
    headings,
    elements: disambiguate([...seen.values()]),
    axe: await runAxe(page),
    notes,
    hints,
  };
}

/** Opens the URL in a headless browser and inventories it. */
export async function explorePage(url: string, context?: string): Promise<PageReport> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await browserContext.newPage();

    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return await capturePage(page, { interact: true, context });
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Compact, token-bounded rendering of the report for the model. */
export function formatReport(report: PageReport): string {
  const lines: string[] = [
    `URL: ${report.url}`,
    `Title: ${report.title}`,
    report.headings.length ? `Headings: ${report.headings.join(' | ')}` : '',
    '',
    'INTERACTIVE ELEMENTS (use these locator expressions verbatim):',
  ];

  for (const el of report.elements) {
    const bits = [
      `page.${el.locator}`,
      el.type && el.type !== 'text' ? `type=${el.type}` : '',
      el.required ? 'required' : '',
      el.options?.length ? `options=[${el.options.slice(0, 6).join(', ')}]` : '',
      el.revealedBy ? 'appears-after-interaction' : '',
    ].filter(Boolean);
    lines.push(`- ${bits.join('  ')}`);
  }

  if (report.hints.length) {
    lines.push('', 'PAGE BEHAVIOUR — observed while crawling, you MUST honour these:');
    for (const hint of report.hints) lines.push(`- ${hint}`);
  }

  if (report.axe.length) {
    lines.push('', 'KNOWN ACCESSIBILITY VIOLATIONS ON THIS PAGE (axe, WCAG 2.1 A/AA):');
    for (const issue of report.axe) {
      lines.push(`- ${issue.id} [${issue.impact}] ${issue.help} (${issue.nodes} node(s))`);
    }
  } else {
    lines.push('', 'axe found no WCAG 2.1 A/AA violations on the initial page state.');
  }

  if (report.notes.length) {
    lines.push('', `Exploration notes: ${report.notes.slice(0, 5).join('; ')}`);
  }

  const text = lines.filter((l) => l !== '').join('\n');
  return text.length > SNAPSHOT_MAX_CHARS
    ? `${text.slice(0, SNAPSHOT_MAX_CHARS)}\n... [truncated]`
    : text;
}

/**
 * Renders a recorded journey. Each page gets its own numbered block so the model
 * can tell which locators belong to which screen — the whole point of recording
 * is that page 2's elements are observed rather than guessed.
 */
export function formatJourney(pages: PageReport[]): string {
  const budget = Math.floor(SNAPSHOT_MAX_CHARS / Math.max(pages.length, 1));

  const blocks = pages.map((page, i) => {
    const body = formatReport(page);
    const trimmed = body.length > budget ? `${body.slice(0, budget)}\n... [truncated]` : body;
    return [
      `═══ PAGE ${i + 1} OF ${pages.length} ═══`,
      i === 0
        ? 'This is the starting page — the test must goto() this URL.'
        : `Reached by the user acting on page ${i}. Your test must perform the actions ` +
          `that navigate here before using any locator from this block.`,
      trimmed,
    ].join('\n');
  });

  return blocks.join('\n\n');
}

