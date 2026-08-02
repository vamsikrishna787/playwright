import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import { AWS_REGION, BEDROCK_API_KEY, BEDROCK_MODEL_ID } from '../config.js';

// A Bedrock API key (ABSK...) is a bearer token, not an IAM key pair. This SDK build
// doesn't pick it up from the environment, so it's passed explicitly and the bearer
// auth scheme is preferred over SigV4. Without a key, the default AWS chain applies.
const client = new BedrockRuntimeClient({
  region: AWS_REGION,
  ...(BEDROCK_API_KEY
    ? {
        token: { token: BEDROCK_API_KEY },
        authSchemePreference: ['httpBearerAuth'],
      }
    : {}),
});

// Amazon Nova caps generation at 5K output tokens and rejects anything higher with a
// ValidationException, so this is the ceiling for a whole generated spec file.
const MAX_OUTPUT_TOKENS = 5000;

async function converse(command: ConverseCommand) {
  try {
    return await client.send(command);
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    const message = err instanceof Error ? err.message : String(err);

    if (/credential/i.test(message) || name === 'CredentialsProviderError') {
      throw new Error(
        `AWS credentials were not found. Run "aws configure", or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in backend/.env. (${message})`,
      );
    }
    if (/use case details/i.test(message)) {
      throw new Error(
        `This AWS account has not submitted the Anthropic use case details form, so no Anthropic model on Bedrock can be called. Open the Bedrock console in ${AWS_REGION} → Model access → submit the Anthropic use case details, then retry in ~15 minutes. The gate covers every Anthropic model, so switching between them will not help — but non-Anthropic models (e.g. us.amazon.nova-pro-v1:0) are unaffected.`,
      );
    }
    if (
      name === 'AccessDeniedException' ||
      name === 'ValidationException' ||
      name === 'ResourceNotFoundException'
    ) {
      throw new Error(
        `Bedrock rejected the request for model "${BEDROCK_MODEL_ID}" in ${AWS_REGION}. Check that model access is enabled for your account in that region, and that the inference profile prefix matches your region. (${message})`,
      );
    }
    throw err;
  }
}

const SYSTEM_PROMPT = `You are a Playwright test generator. Output ONE complete, self-contained TypeScript test file and nothing else — no prose, no explanations, no markdown code fences.

The file MUST follow this exact structure, in this order:

1. Imports:
   import { test, expect, type Page } from '@playwright/test';
   import { AxeBuilder } from '@axe-core/playwright';

2. A const holding the TARGET URL exactly as given below — copy it character for
   character. Never construct, shorten, or invent a different URL.

3. A LOCATORS section — every element the test touches, declared once at the top as a
   factory so each test gets locators bound to its own page:

   const locators = (page: Page) => ({
     usernameInput: page.getByPlaceholder('Username'),
     loginButton: page.getByRole('button', { name: 'Login' }),
   });

   Name keys descriptively in camelCase. Use ONLY the locator expressions listed in the
   page report below, copied verbatim — never invent an element that was not observed.

4. A single test.describe('<suite name>', () => { ... }) containing, in order:

   a. test.beforeEach — navigate to the URL and perform any setup every test needs.
   b. test.afterEach — teardown/diagnostics, written EXACTLY as:

      test.afterEach(async ({ page }, testInfo) => {
        if (testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach('screenshot', {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
        }
      });

      Note it is testInfo.attach(...) — testInfo.attachments is an array and has no
      attach method.

   c. The functional test('<scenario name>', ...) implementing the requested scenario.
   d. An accessibility test, always included, written EXACTLY as:

      test('accessibility: no WCAG 2.1 A/AA violations', async ({ page }) => {
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        const summary = results.violations.map((v) => \`\${v.id} (\${v.impact}): \${v.help}\`);
        expect(summary).toEqual([]);
      });

      Asserting on the summary strings rather than the raw violation objects is
      deliberate — a failure then names the rules instead of dumping deep-equality noise.

Rules for the functional test:
- Start each test body with: const el = locators(page);  then reference el.<name>.
- Do NOT call page.goto inside the tests — beforeEach already did it.
- Wrap every logical action and assertion in await test.step('<clear description>', async () => { ... }).
- Use literal data from the scenario (usernames, passwords, search terms) directly in fill().
- For any field the PAGE BEHAVIOUR section calls an autocomplete, always do all three
  steps in order: click the field, fill() the search text, then click the option —
  clicking an option without typing first will not find it, because the list is empty
  until text is entered. ALWAYS end an option locator with .first(), e.g.
  await page.getByRole('option', { name: 'Dallas' }).first().click();
  A search phrase normally matches several suggestions, and a locator that resolves to
  more than one element fails Playwright's strict mode.
- Never reference an element that is not in the element list. If the scenario asks for a
  control that was not observed (for example a Search button that only appears once the
  form is complete), locate it by its role and a short name fragment rather than
  inventing a full label.
- If the page report is split into "PAGE 1 OF N" blocks, a human recorded the journey and
  EVERY page was observed. Use each page's locators verbatim for the steps that happen on
  that page, and write the actions that navigate from one to the next. Locators from a
  later page will not exist until your test has navigated there, so keep them in the right
  order. In that case the guidance below about unobserved pages does not apply.
- The crawl only observed the starting page. For anything AFTER a navigation or search,
  you have not seen the resulting page, so never assert on exact copy you are guessing at
  — a getByText('Flights from Dallas to Phoenix') that you invented will fail. Prefer a
  URL assertion, which is the only thing you can reliably predict:
  await expect(page).toHaveURL(/inventory/);
  Always pass a REGULAR EXPRESSION to toHaveURL, never a plain string — a string must
  match the whole URL exactly, so '/inventory.html' fails against
  'https://site.com/inventory.html'.
  If the scenario names a control on the later page (a button, a heading), assert that by
  role with a short name fragment and .first(). Do NOT assert on landmark roles such as
  getByRole('main') or getByRole('navigation') — many real pages have no such landmark,
  and the assertion fails for a reason unrelated to the scenario.
  Reserve exact-text assertions for strings that appear in the element list or headings.
- Use web-first assertions (await expect(...).toBeVisible()) — never manual waits or timeouts.
- Include at least one expect() reflecting the scenario's success condition.
- If the scenario needs an element that is not in the page report, choose the closest
  observed element rather than inventing a selector.`;

/**
 * Earlier specs that passed are the most reliable statement of house style there
 * is — far more precise than prose rules. They are fenced off hard from locators
 * though: the model copying a selector out of an example is the exact failure
 * the page report exists to prevent.
 */
function renderExemplars(exemplars: string[]): string[] {
  if (exemplars.length === 0) return [];

  return [
    '',
    'PROVEN EXAMPLES — earlier generated files whose most recent run PASSED.',
    'Follow their structure, naming, step wording and assertion style.',
    'Do NOT copy their locators, URLs, or test data — those belong to other pages.',
    'Every locator you write must come from the PAGE REPORT below.',
    ...exemplars.map((code, i) => `\n--- PROVEN EXAMPLE ${i + 1} ---\n${code}`),
  ];
}

export async function generateSpec(input: {
  url: string;
  prompt: string;
  snapshot: string;
  /** Previously-passing specs, shown as structural patterns to imitate. */
  exemplars?: string[];
}): Promise<string> {
  const userMessage = [
    `TARGET URL (use this exact string in page.goto): ${input.url}`,
    '',
    'Scenario and test data:',
    input.prompt,
    ...renderExemplars(input.exemplars ?? []),
    '',
    'PAGE REPORT — produced by crawling the live page, filling inputs and expanding',
    'menus to surface elements that only appear after interaction:',
    input.snapshot,
  ].join('\n');

  const response = await converse(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: userMessage }] }],
      inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 },
    }),
  );

  const text = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();

  if (!text) throw new Error('Bedrock returned an empty response');
  return text;
}

const EDIT_SYSTEM_PROMPT = `You are editing an existing Playwright test file at the user's request.

Reply in exactly two parts, in this order:
1. A single fenced code block (\`\`\`typescript) containing the COMPLETE updated file — never a fragment, a diff, or an ellipsis. If the request needs no code change, repeat the file unchanged.
2. After the code block, one or two plain sentences describing what you changed. No code, no bullet lists, no headings.

Keep every rule the file already follows: one import from '@playwright/test', exactly one test() block, each action wrapped in await test.step(), role/label/text based locators, web-first assertions via await expect(). Preserve the parts of the test the user did not ask you to change. If an accessibility snapshot of the page is provided, build any new locators from it rather than inventing element names.

When a LAST RUN FAILURE section is present, it is the real output of running this exact file. Diagnose it before editing, name the cause in your closing sentences, and fix that cause rather than the symptom. Common causes and their correct fixes:
- "strict mode violation ... resolved to N elements" — the locator matches several elements. Add .first(), or { exact: true } to a getByRole name. Never switch to a brittle CSS or XPath selector to dodge it.
- "Timeout ... waiting for locator" — the element never appeared. Either the locator is wrong, or a step before it did not actually complete. For an autocomplete, the sequence must be click, then fill, then click the option. Do not paper over it with waitForTimeout.
- "expect(received).toHaveURL(expected)" where expected is a plain string — a string must match the whole URL. Use a regular expression.
- An assertion on copy that was guessed rather than observed — replace it with a URL assertion or a role-based one, not a weaker timeout.
- The file failed to run at all — it is a TypeScript or import error. Fix the syntax and keep the structure.

One exception: if the ONLY failing test is the accessibility test, the script is correct and the page under test genuinely violates WCAG. Do NOT delete, skip, or weaken that test, and do not filter its violations away. Return the file unchanged and say plainly that the page has real accessibility defects, naming the rules that fired.`;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export async function editSpec(input: {
  code: string;
  instruction: string;
  sourceUrl: string;
  snapshot?: string;
  history?: ChatTurn[];
  /** Rendered output of the last failed run, when there is one. */
  failure?: string;
}): Promise<{ code: string; reply: string }> {
  const context = [
    `Source URL: ${input.sourceUrl}`,
    '',
    'Current test file:',
    '```typescript',
    input.code,
    '```',
    ...(input.snapshot ? ['', 'Accessibility snapshot of the page:', input.snapshot] : []),
    ...(input.failure
      ? ['', 'LAST RUN FAILURE — real output from running the file above:', input.failure]
      : []),
    '',
    `Requested change: ${input.instruction}`,
  ].join('\n');

  // Prior turns carry only the assistant's prose, never its code — the current
  // file is always sent fresh above, so replaying old code would just conflict.
  const messages = [
    ...(input.history ?? []).map((turn) => ({
      role: turn.role,
      content: [{ text: turn.text }],
    })),
    { role: 'user' as const, content: [{ text: context }] },
  ];

  const response = await converse(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: EDIT_SYSTEM_PROMPT }],
      messages: messages as ConverseCommandInput['messages'],
      inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 },
    }),
  );

  const text = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();

  if (!text) throw new Error('Bedrock returned an empty response');

  const fence = text.match(/```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/);
  if (!fence) {
    // No fence means the model answered in prose — treat it as a reply with no edit.
    return { code: input.code, reply: text };
  }

  const reply = text.replace(fence[0], '').replace(/\s+/g, ' ').trim();
  return {
    code: fence[1].trim(),
    reply: reply || 'Updated the test.',
  };
}

export async function suggestName(input: { url: string; prompt: string }): Promise<string> {
  const response = await converse(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [
        {
          text: 'Reply with a short test name of at most 6 words describing the scenario. Plain text only, no quotes, no punctuation at the end.',
        },
      ],
      messages: [
        { role: 'user', content: [{ text: `URL: ${input.url}\nScenario: ${input.prompt}` }] },
      ],
      inferenceConfig: { maxTokens: 64, temperature: 0.3 },
    }),
  );

  return (response.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim()
    .slice(0, 80);
}
