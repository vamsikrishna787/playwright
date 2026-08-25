"""Everything the models are told.

Kept in one file on purpose. The prompts are the product of this tier, and
having them side by side is what stops the generate prompt and the edit prompts
drifting into demanding different file shapes — which shows up as a script that
mutates its own structure every time someone refines it.
"""

from __future__ import annotations

from ..models import DataField, StepInput

# ---------------------------------------------------------------------------
# The file shape every prompt agrees on
# ---------------------------------------------------------------------------

#: Written once and pasted into each system prompt, so an edit can never be
#: asked to preserve a structure the generator was never asked to produce.
FILE_SHAPE = """The file MUST follow this exact structure, in this order:

1. Imports:
   import { test, expect, type Page } from '@playwright/test';
   import { AxeBuilder } from '@axe-core/playwright';

2. A const holding the TARGET URL exactly as given — copy it character for
   character. Never construct, shorten, or invent a different URL.

3. A `data` const holding the test data, exactly as listed in the TEST DATA
   section, with the given keys:

   const data = {
     username: 'standard_user',
     password: 'secret_sauce',
   };

   Every value a step needs MUST be read from this object — never inline a
   literal that appears in TEST DATA. This is what lets someone change the data
   without regenerating the script.

4. A LOCATORS section — every element the test touches, declared once at the top
   as a factory so each test gets locators bound to its own page:

   const locators = (page: Page) => ({
     usernameInput: page.getByPlaceholder('Username'),
     loginButton: page.getByRole('button', { name: 'Login' }),
   });

   Name keys descriptively in camelCase.

5. A single test.describe('<suite name>', () => { ... }) containing, in order:

   a. test.beforeEach — navigate to the URL and do any setup every test needs.
   b. test.afterEach — diagnostics, written EXACTLY as:

      test.afterEach(async ({ page }, testInfo) => {
        if (testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach('screenshot', {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
        }
      });

      Note it is testInfo.attach(...) — testInfo.attachments is an array and has
      no attach method.

   c. The functional test implementing the authored steps.
   d. The accessibility test, when one is requested."""

#: The single most important rule in the file. The Node runner maps live progress
#: back to the user's own step list through this tag, so a missing or renumbered
#: tag shows up as a step that never lights up in the UI.
STEP_TAG_RULE = """STEP TAGGING — MANDATORY.
Every authored step becomes exactly one top-level test.step whose title starts
with its number in square brackets:

  await test.step('[S1] Open the login page', async () => { ... });
  await test.step('[S2] Sign in as a standard user', async () => { ... });

Rules:
- One test.step per authored step. Never merge two steps into one, never split
  one step across two.
- The number MUST match the step's number in the AUTHORED STEPS list.
- Keep the numbers in order, starting at [S1], with no gaps.
- Put each step's assertion inside that same step, so a failed expectation is
  attributed to the step that made it.
- Do NOT tag steps you added yourself (setup, teardown, the accessibility scan).
  Untagged steps are shown separately and are expected."""

A11Y_BLOCK = """test('accessibility: no WCAG 2.1 A/AA violations', async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}`);
  expect(summary).toEqual([]);
});"""

LOCATOR_RULES = """LOCATOR RULES.
You have not seen the page. Everything you know about it is in the authored
steps, so write the most durable locator the step's own words support:
- Prefer getByRole with an accessible name, then getByLabel, getByPlaceholder,
  getByTestId, then getByText. Use CSS or XPath only as a last resort.
- Take the name from the step text. "Click the Login button" is
  getByRole('button', { name: 'Login' }).
- ALWAYS end an option locator with .first(), e.g.
  page.getByRole('option', { name: 'Dallas' }).first()
  A search phrase normally matches several suggestions, and a locator resolving
  to more than one element fails Playwright's strict mode.
- For an autocomplete, do all three in order: click the field, fill the text,
  then click the option. Clicking an option without typing first finds nothing,
  because the list is empty until text is entered.
- Never assert on exact page copy you are guessing at. For anything after a
  navigation, prefer a URL assertion, and always pass a REGULAR EXPRESSION to
  toHaveURL — a plain string must match the whole URL, so '/inventory.html'
  fails against 'https://site.com/inventory.html'.
- Do NOT assert on landmark roles such as getByRole('main') or
  getByRole('navigation'): many real pages have neither, and the assertion then
  fails for a reason that has nothing to do with the scenario.
- Use web-first assertions (await expect(...).toBeVisible()) — never
  waitForTimeout, never a manual sleep."""

GENERATE_SYSTEM = f"""You are a Playwright test generator. Output ONE complete, self-contained TypeScript test file and nothing else — no prose, no explanation, no markdown fences.

{FILE_SHAPE}

{STEP_TAG_RULE}

{LOCATOR_RULES}

FUNCTIONAL TEST RULES.
- The AUTHORED STEPS are the specification. A human wrote them and the test must
  implement them: same actions, same order. Do not invent a step that is not
  listed, do not drop one that is, and do not reorder them.
- Each step has an "expected" line. Turn it into a real expect() inside that
  step. Where it is blank, assert whatever the action implies succeeded.
- Do NOT call page.goto inside the tests — beforeEach already did it.
- Start each test body with: const el = locators(page);  then reference el.<name>.
- Read every value from the `data` const, never as an inline literal."""

REFINE_SYSTEM = f"""You are editing an existing Playwright test file at the user's request.

Reply in exactly two parts, in this order:
1. A single fenced code block (```typescript) containing the COMPLETE updated file — never a fragment, a diff, or an ellipsis. If the request needs no code change, repeat the file unchanged.
2. After the code block, one or two plain sentences describing what you changed. No code, no bullets, no headings.

Preserve everything the user did not ask you to change, and keep the file's existing structure: the data const, the locators factory, one describe block, and above all the [Sn] step tags — those numbers are how the UI maps a run back to the user's own step list, so never renumber, merge, or drop a tagged step unless the user explicitly asks for that step to change.

{LOCATOR_RULES}"""

IMPROVE_SYSTEM = """You are hardening an existing Playwright test file.

Reply in exactly two parts: a single fenced ```typescript block with the COMPLETE updated file, then one or two plain sentences naming what you changed and why.

Non-negotiable: the test must still do exactly what it did before. You are changing how it is written, never what it verifies. Keep every [Sn] step tag with its current number — the UI maps live progress through those. Keep the data const and read from it.

Never weaken the test to make it pass: do not delete an assertion, do not add test.skip, do not replace a real wait with waitForTimeout, and do not filter accessibility violations away."""

#: What each improvement goal actually asks for. Separated from the system prompt
#: so a new goal is one dict entry rather than a new prompt.
IMPROVE_GOALS = {
    "stability": """Goal: STABILITY. Remove the reasons this test would flake.
- Replace brittle locators (CSS chains, nth-child, generated class names) with
  role, label, placeholder or test-id locators.
- Replace any manual wait or timeout with a web-first assertion that waits on
  the real condition.
- Add .first() to any locator that could match more than one element.
- Make URL assertions regular expressions rather than exact strings.""",
    "readability": """Goal: READABILITY. Make the file easy for the next person.
- Give locator keys and step titles clearer names (keeping the [Sn] prefixes).
- Pull repeated expressions into well-named consts.
- Add a short comment only where the intent is genuinely not obvious.
- Do not add ceremony: no helper layers, no abstraction for its own sake.""",
    "coverage": """Goal: COVERAGE. Verify more of what the steps already do.
- Add assertions that strengthen the existing steps: state after an action, the
  content of a field just filled, the URL after a navigation.
- Every assertion you add goes INSIDE the [Sn] step it belongs to.
- Do not add new user actions, and do not add a new test() — coverage here means
  checking the existing journey harder, not walking a different one.""",
    "performance": """Goal: SPEED. Make the test finish sooner without weakening it.
- Remove redundant navigations, duplicated setup and repeated locator lookups.
- Collapse a sequence of waits into the single assertion that actually gates.
- Never lower a timeout to make a step fail faster, and never remove a check.""",
}

ADA_SYSTEM = f"""You are strengthening the accessibility coverage of a Playwright test file.

Reply in exactly two parts: a single fenced ```typescript block with the COMPLETE updated file, then one or two plain sentences describing what you added.

What to do:
- If the file has no accessibility test, add one, written exactly as:

{A11Y_BLOCK}

- If it already has one, deepen it rather than duplicating it: scan after the
  functional journey has reached its end state, not only the landing page, so
  the pages behind a login or a form submission are covered too. Add a scan
  scoped to the main interactive region with .include(), and keep the page-wide
  scan as well.
- Add keyboard-reachability checks for the controls the functional test uses:
  focus them and assert toBeFocused, so a control that cannot be tabbed to fails.
- Where the functional test fills a field, assert the field has an accessible
  name (getByLabel resolving, or an aria-label attribute).

Rules:
- Do not change what the functional test does, and keep every [Sn] step tag
  exactly as it is.
- Never filter, allow-list or otherwise suppress a violation to make the test
  pass. A real WCAG failure on the page under test is a true result, and the
  point of the scan.
- Always assert on the mapped summary strings, never the raw violation objects —
  a failure then names the rules instead of dumping deep-equality noise."""

FIX_SYSTEM = """You are fixing a Playwright test that just failed. You are given the file and the real output of the run.

Reply in exactly two parts: a single fenced ```typescript block with the COMPLETE fixed file, then one or two plain sentences naming the cause and the fix.

Diagnose before you edit. Fix the cause, not the symptom:
- "strict mode violation ... resolved to N elements" — the locator matches several elements. Add .first(), or { exact: true } to a getByRole name. Never switch to a brittle CSS or XPath selector to dodge it.
- "Timeout ... waiting for locator" — the element never appeared. Either the locator is wrong, or a step before it did not really complete. For an autocomplete the sequence must be click, then fill, then click the option. Do not paper over it with waitForTimeout.
- "expect(received).toHaveURL(expected)" where expected is a plain string — a string must match the whole URL. Use a regular expression.
- An assertion on copy that was guessed rather than observed — replace it with a URL assertion or a role-based one, not a weaker timeout.
- The file failed to run at all — it is a TypeScript or import error. Fix the syntax and keep the structure.

Keep every [Sn] step tag with its current number, and keep reading values from the data const.

One exception: if the ONLY failing test is the accessibility test, the script is correct and the page genuinely violates WCAG. Do NOT delete, skip or weaken that test, and do not filter its violations away. Return the file unchanged and say plainly that the page has real accessibility defects, naming the rules that fired."""


# ---------------------------------------------------------------------------
# Rendering the facts Node sends
# ---------------------------------------------------------------------------


def render_data(fields: list[DataField]) -> str:
    """The TEST DATA section — the exact keys the `data` const must have.

    Grouped by category because that is how the user entered them, and because
    the grouping is often the only thing distinguishing two fields with the same
    role (a billing postcode from a shipping one).
    """
    if not fields:
        return "TEST DATA: none. The test needs no input values."

    by_category: dict[str, list[DataField]] = {}
    for field in fields:
        by_category.setdefault(field.category or "General", []).append(field)

    lines = ["TEST DATA — build the `data` const from exactly these keys:"]
    for category, group in by_category.items():
        lines.append(f"\n[{category}]")
        for field in group:
            lines.append(f"  {field.name} = {field.value!r}")

    lines.append(
        "\nUse data.<key> everywhere the value is needed. Never inline these literals."
    )
    return "\n".join(lines)


def render_steps(steps: list[StepInput]) -> str:
    """The AUTHORED STEPS section — the specification the test implements.

    The action is written on the tag line exactly as it should appear in the
    test.step title. An earlier version labelled it "DO:", and the model dutifully
    copied the label into every generated title — the step list then read
    "[S1] DO: Fill the Username field" in the UI. Anything on that line is title
    text, so nothing but title text goes there.
    """
    lines = [
        "AUTHORED STEPS — implement every one, in order, as a tagged test.step.",
        "The bracketed line IS the step title: copy it verbatim into test.step().",
    ]

    for step in steps:
        lines.append(f"\n[S{step.index}] {step.action}")
        if step.expected:
            lines.append(f"      must then be true: {step.expected}")
        if step.data:
            used = ", ".join(f"data.{field.name}" for field in step.data)
            lines.append(f"      reads: {used}")

    return "\n".join(lines)


def build_generate_message(
    *,
    test_name: str,
    description: str,
    url: str,
    suite_name: str,
    include_ada: bool,
    steps: list[StepInput],
    data_fields: list[DataField],
) -> str:
    accessibility = (
        f"ACCESSIBILITY: include this test, written exactly as shown:\n\n{A11Y_BLOCK}"
        if include_ada
        else "ACCESSIBILITY: not requested for this test. Do not add an axe scan, "
        "and do not import AxeBuilder."
    )

    return "\n\n".join(
        part
        for part in [
            f"TARGET URL (use this exact string in page.goto): {url}",
            f"SUITE NAME (use as the test.describe title): {suite_name or test_name}",
            f"TEST NAME (use as the functional test() title): {test_name}",
            f"WHAT THIS TEST IS FOR:\n{description}" if description else "",
            render_data(data_fields),
            render_steps(steps),
            accessibility,
        ]
        if part
    )


def build_edit_message(*, code: str, url: str, instruction: str, failure: str = "") -> str:
    return "\n".join(
        [
            f"Target URL: {url}" if url else "",
            "",
            "Current test file:",
            "```typescript",
            code,
            "```",
            *(
                ["", "LAST RUN FAILURE — real output from running the file above:", failure]
                if failure
                else []
            ),
            "",
            instruction,
        ]
    )
