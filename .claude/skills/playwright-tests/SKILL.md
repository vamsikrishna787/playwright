---
name: playwright-tests
description: Build Playwright end-to-end tests from a live site, with locators, functional tests and ADA/accessibility checks in separate files. Use whenever someone asks to add or generate Playwright/e2e tests for a URL, record a page or a multi-step flow in a browser, scrape the locators off a page, or add WCAG/ADA/axe checks. Works in any repository that has Playwright installed.
---

# Playwright test authoring from a live page

Tests are only as good as their locators, and a locator that was invented rather
than observed fails on the first run. So nothing here starts from guesswork: a
real browser opens the site first, and every locator written into a test comes
out of that capture.

Two ways in, and picking the right one is the single most important decision:

| Ask sounds like | Mode | Why |
| --- | --- | --- |
| "add tests for `<url>`", "check this page", "scrape the locators" | **scrape** | one page, no sign-in, no form submission |
| "record this page/flow", "walk through it", anything past a login, a cart, a wizard | **record** | you drive a real browser; every page you reach is captured |

If the flow crosses a login or spans more than one page, use record. The scraper
never submits a form, so it only ever sees the entry page — everything past that
would be guessed, and guessed locators do not survive a run.

## Locating the scripts

They sit next to this file. Resolve the skill directory once (it is either in the
repo or in the user's home) and reuse it:

```bash
# project install
ls .claude/skills/playwright-tests/scripts
# user install, available in every repo
ls ~/.claude/skills/playwright-tests/scripts
```

Run them with plain `node` from the **root of the repository under test**. They
find that repo's Playwright themselves — workspaces, nested `node_modules` and
global installs included. See [references/host-setup.md](references/host-setup.md)
when Playwright or axe is missing.

## Mode 1 — scrape a URL

```bash
node <skill>/scripts/scrape.mjs "<url>" --scenario "<what the test should do>"
```

Opens the page headless, harvests every addressable element, fills inputs and
opens menus to surface controls that only exist after interaction, and runs an
axe WCAG 2.1 A/AA audit. It never clicks anything that looks like it commits —
no submit, no purchase, no delete.

Useful flags: `--no-interact` (read-only), `--headed`, `--no-a11y`,
`--browser firefox|webkit`, `--test-id-attribute data-test`, and several URLs at
once for a set of known pages.

Output: `.playwright-capture/scrape-<timestamp>/inventory.md` (read this) and
`inventory.json`. The directory ignores itself, so nothing lands in git.

## Mode 2 — record a journey

```bash
node <skill>/scripts/record.mjs "<startUrl>"
```

A real browser opens and **the developer drives it**. Tell them so explicitly,
in these words: sign in, dismiss banners, walk the flow to the end, then close
the window. Every step they take is recorded, and every page they land on is
inventoried with its own locators and its own axe audit.

The run blocks until the window closes (or `--minutes`, default 30, elapses), so
launch it and wait rather than polling.

Password-like fields are masked **inside the browser** — a real credential never
reaches the transcript or the JSON. The generated test must read them from an env
var. `--keep-secrets` exists for throwaway accounts only; do not reach for it
unasked.

Output: `.playwright-capture/record-<timestamp>/journey.md` — the ordered steps
with draft code, then one section per page.

`npx playwright codegen <url>` is the alternative when someone explicitly asks
for Playwright's own inspector. It gives an action script and no locator
inventory or a11y data, so fold its output into the structure below rather than
committing it as-is.

## What to write

Three files per feature, so locators can be reused and the ADA checks can run —
or fail — on their own:

```
<testDir>/<feature>.locators.ts    every locator, one factory per page
<testDir>/<feature>.spec.ts        the functional tests
<testDir>/<feature>.a11y.spec.ts   the WCAG/ADA checks
```

Full templates, the naming rules and where `<testDir>` comes from:
[references/file-layout.md](references/file-layout.md).

Non-negotiables:

- Locators live in `.locators.ts` only. A raw `page.getByRole(...)` inside a spec
  is a bug — it is the thing that makes tests unmaintainable when the UI moves.
- Copy locator expressions **verbatim** from the capture. If the scenario needs a
  control that was never observed, say so rather than inventing a selector.
- Secrets come from `process.env`, never a literal.
- Accessibility lives in its own spec so a WCAG failure names an a11y defect
  instead of failing a checkout test.

Then read [references/locator-rules.md](references/locator-rules.md) before
writing the locators file, and [references/ada-checks.md](references/ada-checks.md)
before writing the a11y spec.

## Workflow

1. **Get the URL.** If none was given, ask for it — do not guess one.
2. **Choose the mode** from the table above. When it is genuinely ambiguous
   (a URL plus a scenario that might cross a login), ask; otherwise decide.
3. **Capture.** Run the script and read the generated `.md`.
4. **Report what was found** before writing: how many pages, how many locators,
   how many WCAG violations. If the capture is thin (0–2 elements), the page
   probably needs auth or renders in an iframe — switch to record rather than
   writing a test against nothing.
5. **Write the three files** into the repo's existing test directory.
6. **Run them**: `npx playwright test <files> --reporter=list`.
7. **Fix what fails**, using [references/troubleshooting.md](references/troubleshooting.md).
   One exception: a failing a11y test usually means the page really does violate
   WCAG. Report the violations, never weaken the assertion.
8. **Report**: files written, tests passing, and every accessibility violation
   found — those are product defects the team needs to see.

## Hard rules

- Never weaken, skip or delete an accessibility assertion to make a run green.
  Excluding a known-accepted defect is allowed only with a comment naming the
  ticket.
- Never invent a locator, a URL, or copy in text you have not observed. Assert
  `toHaveURL(/regex/)` rather than exact copy you are guessing at.
- Never submit a payment, place an order, or delete data to make a test pass.
  Ask before recording a flow that ends in one.
- Never commit a captured credential.
