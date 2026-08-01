import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BACKEND_ROOT, snapshotFilePath, specFilePath } from '../config.js';
import type { ScriptRecord } from '../types.js';
import { generateSpec, suggestName } from './bedrock.js';
import { explorePage, formatJourney, formatReport, type PageReport } from './explorer.js';
import { scriptsStore } from './storage.js';

export class GenerationError extends Error {}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

function assertLooksLikeSpec(code: string): void {
  if (!code.includes('@playwright/test') || !/\btest\s*\(/.test(code)) {
    throw new GenerationError(
      'The model did not return valid Playwright test code. Try rephrasing the scenario.',
    );
  }
}

/**
 * An autocomplete search phrase almost always matches several suggestions, so a
 * bare option locator dies on Playwright's strict mode. The prompt asks for
 * .first(); this guarantees it, since a weaker model often forgets.
 */
function hardenOptionLocators(code: string): string {
  return code.replace(
    /(getByRole\(\s*['"]option['"][^)]*\))(?!\s*\.(?:first|last|nth)\b)/g,
    '$1.first()',
  );
}

/**
 * The accessibility test is a product guarantee, not a suggestion, so it is
 * appended if the model dropped it rather than failing the whole generation.
 */
function ensureAccessibilityTest(code: string): string {
  if (/AxeBuilder/.test(code)) return code;

  const a11yTest = `
test('accessibility: no WCAG 2.1 A/AA violations', async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = results.violations.map((v) => \`\${v.id} (\${v.impact}): \${v.help}\`);
  expect(summary).toEqual([]);
});
`;

  const withImport = /from '@axe-core\/playwright'/.test(code)
    ? code
    : code.replace(
        /(import .*from '@playwright\/test';\n)/,
        `$1import { AxeBuilder } from '@axe-core/playwright';\n`,
      );

  // Place it inside the describe block if there is one, otherwise at the end.
  const lastBrace = withImport.lastIndexOf('});');
  if (/test\.describe\s*\(/.test(withImport) && lastBrace !== -1) {
    return `${withImport.slice(0, lastBrace)}${a11yTest}${withImport.slice(lastBrace)}`;
  }
  return `${withImport}\n${a11yTest}`;
}

export async function generateAndSaveScript(input: {
  url: string;
  prompt: string;
  name?: string;
  /** Pages captured while a human walked the flow; skips the automatic crawl. */
  journey?: PageReport[];
}): Promise<ScriptRecord & { code: string }> {
  const snapshot = input.journey?.length
    ? formatJourney(input.journey)
    : // The scenario text steers what the crawler types, so autocompletes
      // surface the suggestions the generated test will actually need.
      formatReport(await explorePage(input.url, input.prompt));

  const raw = await generateSpec({ url: input.url, prompt: input.prompt, snapshot });
  const code = ensureAccessibilityTest(hardenOptionLocators(stripFences(raw)));
  assertLooksLikeSpec(code);

  const name =
    input.name?.trim() ||
    (await suggestName({ url: input.url, prompt: input.prompt }).catch(() => '')) ||
    `Test for ${input.url}`;

  const id = randomUUID();
  const absolutePath = specFilePath(id);
  await fs.writeFile(absolutePath, code, 'utf-8');
  await fs.writeFile(snapshotFilePath(id), snapshot, 'utf-8');

  const now = new Date().toISOString();
  const record: ScriptRecord = {
    id,
    name,
    sourceUrl: input.url,
    prompt: input.prompt,
    filePath: path.relative(BACKEND_ROOT, absolutePath).replace(/\\/g, '/'),
    createdAt: now,
    updatedAt: now,
  };

  await scriptsStore.update((scripts) => [record, ...scripts]);
  return { ...record, code };
}
