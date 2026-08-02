/**
 * Turns a live page into an inventory: every addressable element with the exact
 * Playwright locator expression for it, plus a WCAG audit. Shared by both the
 * scraper and the recorder so a locator means the same thing either way.
 */
import { PAGE_AGENT } from './page-agent.mjs';

const SUBMIT_WORDS =
  /\b(submit|save|buy|order|purchase|pay|checkout|delete|remove|confirm|send|register|sign\s?up|subscribe|book|apply|continue|next|log\s?in|sign\s?in|log\s?out)\b/i;

const LOCATION_FIELD = /where|origin|destination|airport|city|depart|arriv|from|to\b|location|place/i;

/** Make the agent available on a page that may have navigated since last time. */
export async function installAgent(page) {
  const present = await page.evaluate(() => Boolean(window.__pwgen)).catch(() => false);
  if (!present) await page.evaluate(PAGE_AGENT).catch(() => {});
}

/**
 * Sample data for exploratory filling. Realistic values matter more than they
 * look: an autocomplete fed a meaningless string returns no suggestions, so the
 * UI that depends on it never appears and the inventory misses half the page.
 */
function sampleValue(type, name, scenario) {
  const subject = `${type} ${name}`;
  if (/email/i.test(subject)) return 'test@example.com';
  if (/pass(word|code)/i.test(subject)) return 'Passw0rd!23';
  if (/tel|phone/i.test(subject)) return '5551234567';
  if (type === 'number') return '1';
  if (type === 'date') return '2026-01-01';
  if (type === 'time') return '12:00';
  if (type === 'url') return 'https://example.com';
  if (/zip|postal/i.test(name)) return '10001';

  if (LOCATION_FIELD.test(name)) {
    // Pull places out of the scenario text, keeping origin and destination
    // distinct — filling both with one city yields a useless suggestion list.
    const place = /([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?)/.source;
    const origin = scenario?.match(new RegExp(`\\bfrom\\s+${place}`))?.[1];
    const destination = scenario?.match(new RegExp(`\\bto\\s+${place}`))?.[1];
    if (/where to|destination|arriv|\bto\b/i.test(name)) return destination ?? 'Phoenix';
    if (/where from|origin|depart|\bfrom\b/i.test(name)) return origin ?? 'Dallas';
    return origin ?? destination ?? 'Dallas';
  }

  if (/full ?name|first ?name|last ?name|your name/i.test(name)) return 'Test User';
  if (/search|query|keyword/i.test(name)) return 'test';
  return 'test';
}

/**
 * Rebuild a Playwright locator from a described element, for our own use while
 * exploring. Test ids resolve through an explicit attribute selector rather
 * than getByTestId, which would only match the attribute the host project
 * configured — the emitted locator string is the one that respects that.
 */
export function toLocator(page, info) {
  if (info.testId && info.testIdAttr) {
    return page.locator(`[${info.testIdAttr}=${JSON.stringify(info.testId)}]`);
  }
  if (info.role && info.name) return page.getByRole(info.role, { name: info.name });
  if (info.label) return page.getByLabel(info.label);
  if (info.placeholder) return page.getByPlaceholder(info.placeholder);
  if (info.id) return page.locator(`[id=${JSON.stringify(info.id)}]`);
  if (info.role) return page.getByRole(info.role);
  return page.locator(info.tag);
}

function key(el) {
  return `${el.role}|${el.name}|${el.placeholder}|${el.testId}`;
}

/**
 * Two locator problems get resolved here rather than left for the test to hit
 * at run time:
 *
 * - getByRole name matching is substring-based, so "Password" also matches
 *   "Confirm Password" and fails strict mode. Names contained in a sibling's
 *   name get exact: true.
 * - Genuinely repeated elements (a "Add to cart" button per product) get an
 *   occurrence count so the generated test knows it needs .first()/.nth().
 */
function disambiguate(elements) {
  const withExact = elements.map((el) => {
    if (!el.name || !el.locator.startsWith('getByRole')) return el;
    const collides = elements.some(
      (other) =>
        other !== el &&
        other.role === el.role &&
        other.name !== el.name &&
        other.name.toLowerCase().includes(el.name.toLowerCase()),
    );
    if (!collides) return el;
    return { ...el, locator: el.locator.replace(/\s*\}\)$/, ', exact: true })') };
  });

  const counts = new Map();
  for (const el of withExact) counts.set(el.locator, (counts.get(el.locator) ?? 0) + 1);

  const seen = new Set();
  const unique = [];
  for (const el of withExact) {
    if (seen.has(el.locator)) continue;
    seen.add(el.locator);
    unique.push({ ...el, occurrences: counts.get(el.locator) ?? 1 });
  }
  return unique;
}

async function harvest(page) {
  await installAgent(page);
  return page.evaluate(() => window.__pwgen.harvest(150)).catch(() => []);
}

/** Type into fields so dependent UI appears, and note autocomplete behaviour. */
async function fillInputs(page, elements, notes, hints, scenario) {
  const fillable = elements.filter(
    (el) =>
      (el.tag === 'input' || el.tag === 'textarea') &&
      !['checkbox', 'radio', 'submit', 'button', 'file', 'hidden', 'image'].includes(el.type) &&
      !el.disabled,
  );

  for (const el of fillable.slice(0, 12)) {
    const label = el.name || el.label || el.placeholder || '';
    try {
      const field = toLocator(page, el).first();
      // Focus first: some widgets only open their suggestion list on real focus,
      // so fill() alone shows nothing.
      await field.click({ timeout: 2500 }).catch(() => {});
      await field.fill(sampleValue(el.type, label, scenario), { timeout: 2500 });
      await page.waitForTimeout(400);

      if (el.tag !== 'input') continue;

      // Closed dropdowns elsewhere keep their options in the DOM, so only
      // visible ones belong to the field just filled.
      const options = page.locator('[role="option"]:visible');
      const count = await options.count().catch(() => 0);
      if (count === 0) continue;

      const sample = (await options.allInnerTexts().catch(() => []))
        .map((text) => text.replace(/\s+/g, ' ').trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 3);

      hints.push(
        `"${label}" is an autocomplete: click it, fill() it, then click ` +
          `page.getByRole('option', { name: ... }).first(). The rest of the form may stay ` +
          `hidden until a suggestion is committed. Observed options: ${sample.join(' / ')}`,
      );

      await options.first().click({ timeout: 2500 });
      await page.waitForTimeout(600);
    } catch {
      notes.push(`Could not fill ${el.locator}`);
    }
  }
}

/** Click only things that reveal UI — never anything that looks like it commits. */
async function expandDisclosures(page, elements, notes) {
  const candidates = elements.filter(
    (el) =>
      (el.role === 'tab' || el.tag === 'summary' || el.role === 'button') &&
      el.name &&
      !SUBMIT_WORDS.test(el.name) &&
      !['submit', 'image'].includes(el.type) &&
      !el.disabled,
  );

  for (const el of candidates.slice(0, 8)) {
    try {
      const before = page.url();
      await toLocator(page, el).first().click({ timeout: 2000 });
      await page.waitForTimeout(250);
      if (page.url() !== before) {
        // Navigation is a side effect we did not want.
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        notes.push(`Clicking ${el.locator} navigated away; stopped expanding`);
        return;
      }
    } catch {
      notes.push(`Could not expand ${el.locator}`);
    }
  }
}

function normaliseViolations(violations) {
  return violations.slice(0, 25).map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? 'unknown',
    help: violation.help ?? '',
    helpUrl: violation.helpUrl ?? '',
    count: violation.nodes?.length ?? 0,
    sample: String(violation.nodes?.[0]?.target?.[0] ?? '').slice(0, 140),
  }));
}

/**
 * Inventories whatever page is currently loaded.
 *
 * `interact` also fills inputs and expands menus to surface elements that only
 * exist after interaction. That is right for a scrape, and wrong while
 * recording — there a human is driving, and typing into their form underneath
 * them would corrupt the flow.
 */
export async function capturePage(page, options = {}) {
  const { interact = false, scenario, axe = null, waitMs = 8000 } = options;
  const notes = [];
  const hints = [];

  await page.waitForLoadState('domcontentloaded', { timeout: waitMs }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: waitMs }).catch(() => {});

  const context = await page
    .evaluate(() => window.__pwgen?.context() ?? null)
    .catch(() => null);
  const initial = await harvest(page);
  const seen = new Map(initial.map((el) => [key(el), el]));

  if (interact) {
    await fillInputs(page, initial, notes, hints, scenario);
    await expandDisclosures(page, initial, notes);
    for (const el of await harvest(page)) {
      if (!seen.has(key(el))) seen.set(key(el), { ...el, revealedByInteraction: true });
    }
  }

  let violations = null;
  let axeError = null;
  if (axe) {
    try {
      violations = normaliseViolations(await axe.run(page));
    } catch (err) {
      axeError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    url: page.url(),
    title: context?.title ?? (await page.title().catch(() => '')),
    headings: context?.headings ?? [],
    landmarks: [...new Set(context?.landmarks ?? [])],
    elements: disambiguate([...seen.values()]),
    axe: violations,
    axeError,
    notes,
    hints,
    capturedAt: new Date().toISOString(),
  };
}

function elementLine(el) {
  const bits = [`page.${el.locator}`];
  if (el.tag) bits.push(el.tag === 'input' && el.type ? `input[${el.type}]` : el.tag);
  if (el.required) bits.push('required');
  if (el.disabled) bits.push('disabled');
  if (el.secret) bits.push('SECRET — never hard-code a real value');
  if (el.testIdAttr && el.testIdAttr !== 'data-testid') {
    bits.push(`set testIdAttribute: '${el.testIdAttr}' in playwright.config to use getByTestId`);
  }
  if (el.occurrences > 1) bits.push(`matches ${el.occurrences} elements — needs .first()/.nth()`);
  if (el.options?.length) bits.push(`options: ${el.options.slice(0, 8).join(' | ')}`);
  if (el.href) bits.push(`href=${el.href.slice(0, 60)}`);
  if (el.revealedByInteraction) bits.push('appears only after interaction');
  return `- ${bits.join('  ·  ')}`;
}

/** Markdown for one page. This is what the test author actually reads. */
export function formatPage(report, heading = 'Page') {
  const lines = [`## ${heading} — ${report.title || 'untitled'}`, '', `URL: ${report.url}`];

  if (report.headings.length) lines.push(`Headings: ${report.headings.join(' | ')}`);
  if (report.landmarks.length) lines.push(`Landmarks present: ${report.landmarks.join(', ')}`);

  lines.push('', '### Locators — copy these expressions verbatim', '');
  if (report.elements.length) {
    for (const el of report.elements) lines.push(elementLine(el));
  } else {
    lines.push('- (nothing addressable found — the page may render after auth or in an iframe)');
  }

  if (report.hints.length) {
    lines.push('', '### Observed behaviour — the test must honour these', '');
    for (const hint of report.hints) lines.push(`- ${hint}`);
  }

  lines.push('', '### Accessibility (axe, WCAG 2.1 A/AA)', '');
  if (report.axe === null) {
    lines.push(
      report.axeError
        ? `- audit failed: ${report.axeError}`
        : '- not run (install @axe-core/playwright to enable)',
    );
  } else if (report.axe.length === 0) {
    lines.push('- no violations in this page state');
  } else {
    for (const issue of report.axe) {
      lines.push(
        `- **${issue.id}** [${issue.impact}] ${issue.help} — ${issue.count} node(s), e.g. \`${issue.sample}\``,
      );
    }
  }

  if (report.notes.length) {
    lines.push('', `Notes: ${report.notes.slice(0, 6).join('; ')}`);
  }

  return lines.join('\n');
}

/** Aggregate WCAG picture across every page, for the ADA spec's scope. */
export function formatAxeSummary(pages) {
  const audited = pages.filter((page) => page.axe !== null);
  if (audited.length === 0) return '';

  const totals = new Map();
  for (const page of audited) {
    for (const issue of page.axe) {
      const held = totals.get(issue.id) ?? { ...issue, count: 0, pages: 0 };
      held.count += issue.count;
      held.pages += 1;
      totals.set(issue.id, held);
    }
  }

  const lines = ['## Accessibility summary (all pages)', ''];
  if (totals.size === 0) {
    lines.push('No WCAG 2.1 A/AA violations were detected on any captured page.');
    lines.push('The ADA spec should therefore assert zero violations and be expected to pass.');
    return lines.join('\n');
  }

  lines.push(
    'These are real defects in the page under test, not test bugs. Keep the ADA spec',
    'asserting zero violations; if the team has accepted a defect, exclude it explicitly',
    'with a comment naming the ticket rather than deleting the assertion.',
    '',
  );
  for (const issue of [...totals.values()].sort((a, b) => b.count - a.count)) {
    lines.push(`- **${issue.id}** [${issue.impact}] ${issue.help} — ${issue.count} node(s) across ${issue.pages} page(s)`);
  }
  return lines.join('\n');
}

/**
 * Collapses raw recorded events into the steps a test would contain. Typing
 * fires one input event per keystroke, so consecutive fills on one element are
 * folded into the final value.
 */
export function collapseSteps(steps) {
  const out = [];
  for (const step of steps) {
    const previous = out[out.length - 1];
    const sameTarget = previous?.element?.locator === step.element?.locator;

    if (step.kind === 'fill' && previous?.kind === 'fill' && sameTarget) {
      previous.value = step.value;
      previous.url = step.url;
      continue;
    }
    // A click on the field you are already typing into is noise.
    if (step.kind === 'click' && previous?.kind === 'fill' && sameTarget) continue;
    if (step.kind === 'click' && previous?.kind === 'click' && sameTarget && step.at - previous.at < 400) {
      continue;
    }
    // Ticking a checkbox or choosing an option also fires a click. check() and
    // selectOption() already do that click, so the pair would double up.
    if (
      ['check', 'uncheck', 'selectOption'].includes(step.kind) &&
      previous?.kind === 'click' &&
      sameTarget
    ) {
      out[out.length - 1] = { ...step };
      continue;
    }
    out.push({ ...step });
  }
  return out;
}

const ACTION_CODE = {
  click: (step) => `await page.${step.element.locator}.click();`,
  fill: (step) => `await page.${step.element.locator}.fill('${(step.value ?? '').replace(/'/g, "\\'")}');`,
  check: (step) => `await page.${step.element.locator}.check();`,
  uncheck: (step) => `await page.${step.element.locator}.uncheck();`,
  press: (step) =>
    step.element?.locator
      ? `await page.${step.element.locator}.press('${step.key}');`
      : `await page.keyboard.press('${step.key}');`,
  selectOption: (step) =>
    `await page.${step.element.locator}.selectOption('${(step.options?.[0]?.value ?? '').replace(/'/g, "\\'")}');`,
  navigate: (step) => `// navigated to ${step.url}`,
};

/** Markdown for the recorded step sequence, with draft code per step. */
export function formatSteps(steps, pageIndexFor) {
  const lines = [
    '## Recorded steps — in order, as performed',
    '',
    'Draft code is mechanical: keep the order, but wrap steps in test.step() and add',
    'assertions. A step marked SECRET must read from an env var, never a literal.',
    '',
  ];

  if (steps.length === 0) {
    lines.push('_No interactions were recorded._');
    return lines.join('\n');
  }

  steps.forEach((step, index) => {
    const page = pageIndexFor?.(step) ?? 1;
    const code = ACTION_CODE[step.kind]?.(step) ?? `// ${step.kind}`;
    const secret = step.element?.secret ? '  ← SECRET' : '';
    lines.push(`${index + 1}. \`[page ${page}]\` ${code}${secret}`);
  });

  return lines.join('\n');
}
