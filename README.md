# Playwright Test Generator

Record a flow once, get a real Playwright test back, run it, and keep a video plus results for every run. Everything is organised by **site**, and every site accumulates a **locator library** that makes the next test better than the last.

Add a site by URL, record the flow yourself in a real browser, and describe what should be verified. The pages you touch are inventoried, the locators are saved against that site, and AWS Bedrock writes a Playwright test grounded in what was actually observed — never in guesses. Each script carries an accessibility test asserting zero WCAG 2.1 A/AA violations.

## Setup

Requires Node 20+ and Python 3.10+.

```bash
npm install                     # supplies @playwright/test and axe-core
npm run setup:py                # Python deps + Chromium for the crawler
npx playwright install chromium # Chromium for the test runner
cp backend-py/.env.example backend-py/.env
```

Then configure AWS in `backend-py/.env`:

```
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=us.amazon.nova-pro-v1:0
AWS_BEARER_TOKEN_BEDROCK=ABSK...
```

A Bedrock API key (the `ABSK...` string from the console) is a bearer token, not an IAM key pair — it will not work in `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. **These keys expire**; when generation starts failing with "Bearer Token has expired", mint a fresh one in the Bedrock console under API keys. To use IAM credentials instead, leave `AWS_BEARER_TOKEN_BEDROCK` blank and either set the key/secret pair or run `aws configure`.

Model access for the chosen model must be enabled in that region in the AWS Bedrock console. Swap the `us.` inference-profile prefix for `eu.` or `apac.` if you're elsewhere.

**Anthropic models on Bedrock additionally require a use case form.** Until it's submitted (Bedrock console → Model access → Anthropic use case details), every Anthropic model returns `ResourceNotFoundException` — switching between them doesn't help, as the gate is account-wide. Amazon Nova has no such requirement, which is why `us.amazon.nova-pro-v1:0` is the current default. Claude produces noticeably better test code; switch back once the form clears. Note that Nova caps responses at 5K output tokens, so generated specs are capped there too.

`backend-py/.env` is gitignored. Keep real credentials there, never in `.env.example`.

## Run

```bash
npm run dev:py
```

Backend on `http://localhost:3001`, frontend on `http://localhost:5173`.

## Sites, and why they matter

**My Scripts** is grouped by site. A site is created automatically from the host of whatever URL you start with, and it owns two things: its scripts, and its locator library.

Every site header offers two ways to add a script:

**Record** — you drive. A visible browser opens and you walk the flow yourself: log in, dismiss banners, navigate as far as the test needs to go. Every page you land on is inventoried and every click, fill and selection is captured in order. The generated test replays your exact steps with **real locators for every page**, not just the first.

**Generate with AI** — free text only. No browser opens; the test is written against the locators this site already has. Fastest way to add a second, third and fourth test once a site has been recorded once. If you point it at a page nobody has recorded yet, that page is crawled once so the test still has real elements to work from.

## The locator library

Each site keeps every element ever inventoried on it, keyed by page and by role + accessible name:

- **Recording feeds it.** Pages you walk through are merged in.
- **A passing run proves it.** When a run goes green, every locator that test actually used is marked `verified` — a green run is the only real evidence a locator works. Verified entries are the ones the model is told to prefer.
- **New scripts start from it.** A recording hands the model its own fresh capture *plus* everything already known about the site's other pages, so a test can reach past the screens you just walked.

### When a locator changes

Record a page a second time and its expressions may come out different — a `.first()` appears, an `exact: true` shows up, an `.nth(2)` shifts. That is either the page moving under you or a genuinely different element answering to the same name, and only you can tell which. So the recording stops and asks, per element:

- **Keep the original** — the saved expression stays; the new observation is discarded.
- **Replace with the new one** — the page really changed.
- **Keep both** — two different elements share a name. The new one becomes primary, the old is kept as an alternate and stays available.

Your answers are written to the library and used for that generation. Whatever a later run proves green wins in the end: if a passing test used an alternate, that alternate is promoted to primary automatically.

### Editing the library by hand

Open a site's library from the link under its name. Every page and every locator is listed, verified ones marked, and each row can be:

- **Edited** — rename the element, rewrite its locator expression, or maintain its alternates (one per line). Pasting the displayed `page.getByRole(...)` form is fine; the `page.` prefix is stripped on save. Expressions are validated, so a bare CSS selector or an unbalanced bracket is refused with a message rather than silently poisoning every future generation. Changing an expression clears its verified mark — proof belongs to an expression, not to an element, and the new one has not run yet.
- **Re-prioritised** — promote any alternate to primary with *use this one*.
- **Removed** — a single entry, or a whole page's worth.

Edits take effect on the next generation for that site.

## Two views of every script

A generated script opens on **Steps** — the whole test in plain English, one line per action, grouped by test:

```
GO TO     Open https://www.saucedemo.com/
TYPE      Type "standard_user" into the "Username" field
CLICK     Click the "Login" button
CHECK     Check the page URL matches /inventory/
ACCESSIBILITY  Scan the whole page for WCAG 2.1 A/AA accessibility problems
```

**Script** shows the Playwright file itself, editable, with the AI chat panel beside it. The steps are parsed from the code — including unsaved edits — so the two views can never disagree about what the test does.

## How it works

```
POST /api/recordings                    open a real browser, inventory every page
GET  /api/recordings/:id/conflicts      locators that changed since last time
POST /api/recordings/:id/generate       apply the answers, merge the library, generate
POST /api/domains/:id/generate          free text + the site's library, no browser

  └─ Bedrock Converse    →  a .spec.ts with locators declared at the top,
                            beforeEach/afterEach hooks, the functional test,
                            and an accessibility test
  └─ saved to backend-py/scripts/<scriptId>.spec.ts

POST /api/scripts/:id/runs
  └─ spawns `playwright test` in a child process
  └─ on pass, promotes the locators it used to verified
  └─ backend-py/runs/<scriptId>/<runId>/
       video.webm    the recording for this run
       report.json   raw Playwright JSON reporter output
       stdout.log    runner output, used for diagnosing crashes
       artifacts/    Playwright's own output dir
```

Two separate browsers are involved and it helps to keep them apart: one is driven by the recorder or crawler to inspect pages during generation, the other is launched by the test runner during a run.

Every generated file has the same shape — locators declared once at the top, `beforeEach` navigating to the URL, `afterEach` attaching a screenshot on failure, the functional test, and an accessibility test asserting zero WCAG 2.1 A/AA violations. That last one is enforced after the fact: if the model omits it, it is appended. A run reports each test separately and passes only if all of them pass.

State lives in flat files — `backend-py/data/scripts.json`, `runs.json`, `domains.json`, and one `data/locators/<domainId>.json` per site. Writes go through a per-file lock with atomic replacement, so concurrent runs finishing at the same time can't corrupt an index.

## Notes

- Video is recorded for every run, passing or failing, so `backend-py/runs/` grows over time. Delete a script to remove its runs, or clear the folder by hand.
- Library pages are keyed by URL without the query string: `?sort=price` and `?sort=name` are the same screen with the same controls.
- If the model returns something that doesn't compile, the script is still saved — fix it in the editor, or ask the chat panel to fix it, and run again.
