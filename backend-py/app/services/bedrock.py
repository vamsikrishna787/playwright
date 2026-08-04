"""Amazon Bedrock calls: generate a spec, edit a spec, name a test."""

from __future__ import annotations

import asyncio
import os
import re
from functools import lru_cache
from typing import Any, Literal, TypedDict

import boto3
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

from ..config import AWS_REGION, BEDROCK_API_KEY, BEDROCK_MODEL_ID

# A Bedrock API key (ABSK.../bedrock-api-key-...) is a bearer token, not an IAM key
# pair. botocore reads it straight from the environment for the bedrock services, so
# it is re-exported here already trimmed. Without a key, the default AWS chain applies.
if BEDROCK_API_KEY:
    os.environ["AWS_BEARER_TOKEN_BEDROCK"] = BEDROCK_API_KEY

# Amazon Nova caps generation at 5K output tokens and rejects anything higher with a
# ValidationException, so this is the ceiling for a whole generated spec file.
MAX_OUTPUT_TOKENS = 5000

_REJECTION_CODES = {"AccessDeniedException", "ValidationException", "ResourceNotFoundException"}


@lru_cache(maxsize=1)
def _client() -> Any:
    return boto3.client("bedrock-runtime", region_name=AWS_REGION)


def _converse_sync(**kwargs: Any) -> dict[str, Any]:
    try:
        return _client().converse(**kwargs)
    except NoCredentialsError as err:
        raise RuntimeError(
            "AWS credentials were not found. Run \"aws configure\", or set "
            f"AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in backend-py/.env. ({err})"
        ) from err
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "")
        message = err.response.get("Error", {}).get("Message", "") or str(err)

        if re.search(r"use case details", message, re.I):
            raise RuntimeError(
                "This AWS account has not submitted the Anthropic use case details form, so no "
                "Anthropic model on Bedrock can be called. Open the Bedrock console in "
                f"{AWS_REGION} → Model access → submit the Anthropic use case details, then retry "
                "in ~15 minutes. The gate covers every Anthropic model, so switching between them "
                "will not help — but non-Anthropic models (e.g. us.amazon.nova-pro-v1:0) are "
                "unaffected."
            ) from err
        if re.search(r"bearer token", message, re.I):
            raise RuntimeError(
                f"The Bedrock API key in backend-py/.env was rejected: {message}. These keys are "
                "time-limited — mint a fresh one in the Bedrock console under API keys, or clear "
                "AWS_BEARER_TOKEN_BEDROCK to fall back to IAM credentials."
            ) from err
        if code in _REJECTION_CODES:
            raise RuntimeError(
                f'Bedrock rejected the request for model "{BEDROCK_MODEL_ID}" in {AWS_REGION}. '
                "Check that model access is enabled for your account in that region, and that "
                f"the inference profile prefix matches your region. ({message})"
            ) from err
        raise
    except BotoCoreError as err:
        message = str(err)
        if re.search(r"credential", message, re.I):
            raise RuntimeError(
                "AWS credentials were not found. Run \"aws configure\", or set "
                f"AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in backend-py/.env. ({message})"
            ) from err
        raise


async def _converse(**kwargs: Any) -> str:
    """Runs the blocking boto3 call off the event loop and returns the joined text."""
    response = await asyncio.to_thread(_converse_sync, **kwargs)
    content = (response.get("output") or {}).get("message", {}).get("content") or []
    return "".join(block.get("text", "") for block in content).strip()


SYSTEM_PROMPT = """You are a Playwright test generator. Output ONE complete, self-contained TypeScript test file and nothing else — no prose, no explanations, no markdown code fences.

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
        const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}`);
        expect(summary).toEqual([]);
      });

      Asserting on the summary strings rather than the raw violation objects is
      deliberate — a failure then names the rules instead of dumping deep-equality noise.

Rules for the functional test:
- If a USER ACTIONS section is present, it overrides everything else about WHAT the
  test does. A human performed those exact steps and the test must replay them:
  same actions, same order, same locator expressions, one await test.step() per
  numbered line, with the literal values given. Do not invent a step that is not
  listed, do not drop one that is, and do not reorder them. The scenario text is
  then only a description of intent and a source of the success assertion — where
  the two disagree, the recorded actions win. Add assertions on top of the replayed
  steps, not instead of them.
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
  observed element rather than inventing a selector."""


def _render_exemplars(exemplars: list[str]) -> list[str]:
    """Earlier specs that passed are the most reliable statement of house style there
    is — far more precise than prose rules. They are fenced off hard from locators
    though: the model copying a selector out of an example is the exact failure
    the page report exists to prevent.
    """
    if not exemplars:
        return []

    return [
        "",
        "PROVEN EXAMPLES — earlier generated files whose most recent run PASSED.",
        "Follow their structure, naming, step wording and assertion style.",
        "Do NOT copy their locators, URLs, or test data — those belong to other pages.",
        "Every locator you write must come from the PAGE REPORT below.",
        *(f"\n--- PROVEN EXAMPLE {i + 1} ---\n{code}" for i, code in enumerate(exemplars)),
    ]


async def generate_spec(
    *,
    url: str,
    prompt: str,
    snapshot: str,
    exemplars: list[str] | None = None,
) -> str:
    user_message = "\n".join(
        [
            f"TARGET URL (use this exact string in page.goto): {url}",
            "",
            "Scenario and test data:",
            prompt,
            *_render_exemplars(exemplars or []),
            "",
            "PAGE REPORT — produced by crawling the live page, filling inputs and expanding",
            "menus to surface elements that only appear after interaction:",
            snapshot,
        ]
    )

    text = await _converse(
        modelId=BEDROCK_MODEL_ID,
        system=[{"text": SYSTEM_PROMPT}],
        messages=[{"role": "user", "content": [{"text": user_message}]}],
        inferenceConfig={"maxTokens": MAX_OUTPUT_TOKENS, "temperature": 0.2},
    )

    if not text:
        raise RuntimeError("Bedrock returned an empty response")
    return text


EDIT_SYSTEM_PROMPT = """You are editing an existing Playwright test file at the user's request.

Reply in exactly two parts, in this order:
1. A single fenced code block (```typescript) containing the COMPLETE updated file — never a fragment, a diff, or an ellipsis. If the request needs no code change, repeat the file unchanged.
2. After the code block, one or two plain sentences describing what you changed. No code, no bullet lists, no headings.

Keep every rule the file already follows: one import from '@playwright/test', exactly one test() block, each action wrapped in await test.step(), role/label/text based locators, web-first assertions via await expect(). Preserve the parts of the test the user did not ask you to change. If an accessibility snapshot of the page is provided, build any new locators from it rather than inventing element names.

When a LAST RUN FAILURE section is present, it is the real output of running this exact file. Diagnose it before editing, name the cause in your closing sentences, and fix that cause rather than the symptom. Common causes and their correct fixes:
- "strict mode violation ... resolved to N elements" — the locator matches several elements. Add .first(), or { exact: true } to a getByRole name. Never switch to a brittle CSS or XPath selector to dodge it.
- "Timeout ... waiting for locator" — the element never appeared. Either the locator is wrong, or a step before it did not actually complete. For an autocomplete, the sequence must be click, then fill, then click the option. Do not paper over it with waitForTimeout.
- "expect(received).toHaveURL(expected)" where expected is a plain string — a string must match the whole URL. Use a regular expression.
- An assertion on copy that was guessed rather than observed — replace it with a URL assertion or a role-based one, not a weaker timeout.
- The file failed to run at all — it is a TypeScript or import error. Fix the syntax and keep the structure.

One exception: if the ONLY failing test is the accessibility test, the script is correct and the page under test genuinely violates WCAG. Do NOT delete, skip, or weaken that test, and do not filter its violations away. Return the file unchanged and say plainly that the page has real accessibility defects, naming the rules that fired."""

FENCE_RE = re.compile(r"```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```")


class ChatTurn(TypedDict):
    role: Literal["user", "assistant"]
    text: str


class EditResult(TypedDict):
    code: str
    reply: str


async def edit_spec(
    *,
    code: str,
    instruction: str,
    source_url: str,
    snapshot: str | None = None,
    history: list[ChatTurn] | None = None,
    failure: str | None = None,
) -> EditResult:
    context = "\n".join(
        [
            f"Source URL: {source_url}",
            "",
            "Current test file:",
            "```typescript",
            code,
            "```",
            *(["", "Accessibility snapshot of the page:", snapshot] if snapshot else []),
            *(
                ["", "LAST RUN FAILURE — real output from running the file above:", failure]
                if failure
                else []
            ),
            "",
            f"Requested change: {instruction}",
        ]
    )

    # Prior turns carry only the assistant's prose, never its code — the current
    # file is always sent fresh above, so replaying old code would just conflict.
    messages: list[dict[str, Any]] = [
        {"role": turn["role"], "content": [{"text": turn["text"]}]} for turn in (history or [])
    ]
    messages.append({"role": "user", "content": [{"text": context}]})

    text = await _converse(
        modelId=BEDROCK_MODEL_ID,
        system=[{"text": EDIT_SYSTEM_PROMPT}],
        messages=messages,
        inferenceConfig={"maxTokens": MAX_OUTPUT_TOKENS, "temperature": 0.2},
    )

    if not text:
        raise RuntimeError("Bedrock returned an empty response")

    fence = FENCE_RE.search(text)
    if not fence:
        # No fence means the model answered in prose — treat it as a reply with no edit.
        return {"code": code, "reply": text}

    reply = re.sub(r"\s+", " ", text.replace(fence.group(0), "")).strip()
    return {"code": fence.group(1).strip(), "reply": reply or "Updated the test."}


async def suggest_name(*, url: str, prompt: str) -> str:
    text = await _converse(
        modelId=BEDROCK_MODEL_ID,
        system=[
            {
                "text": "Reply with a short test name of at most 6 words describing the scenario. "
                "Plain text only, no quotes, no punctuation at the end."
            }
        ],
        messages=[{"role": "user", "content": [{"text": f"URL: {url}\nScenario: {prompt}"}]}],
        inferenceConfig={"maxTokens": 64, "temperature": 0.3},
    )
    return text[:80]
