# Playwright Test Generator

Describe a test in plain English, get a real Playwright test back, run it, and keep a video plus results for every run.

Give it a URL and a scenario ("log in with user X / password Y and check the dashboard loads"). The backend opens the page through Playwright MCP, captures its accessibility tree, and asks AWS Bedrock to write a Playwright test grounded in that real page structure. The script is saved under **My Scripts**, where you can edit it and run it. Each run records its own video and its own results — nothing is overwritten.

## Setup

Requires Node 20+.

```bash
npm install
npm run install:browsers        # one-time Chromium download
cp backend/.env.example backend/.env
```

Then configure AWS in `backend/.env`:

```
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=us.amazon.nova-pro-v1:0
AWS_BEARER_TOKEN_BEDROCK=ABSK...
```

A Bedrock API key (the `ABSK...` string from the console) is a bearer token, not an IAM key pair — it will not work in `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. To use IAM credentials instead, leave `AWS_BEARER_TOKEN_BEDROCK` blank and either set the key/secret pair or run `aws configure`; the default AWS SDK chain applies when no bearer token is present.

Model access for the chosen model must be enabled in that region in the AWS Bedrock console. Swap the `us.` inference-profile prefix for `eu.` or `apac.` if you're elsewhere, and confirm the exact profile ID in the console.

**Anthropic models on Bedrock additionally require a use case form.** Until it's submitted (Bedrock console → Model access → Anthropic use case details), every Anthropic model returns `ResourceNotFoundException` — switching between them doesn't help, as the gate is account-wide. Amazon Nova has no such requirement, which is why `us.amazon.nova-pro-v1:0` is the current default. Claude produces noticeably better test code; switch back once the form clears. Note that Nova caps responses at 5K output tokens, so generated specs are capped there too — Claude allows more.

`backend/.env` is gitignored. Keep real credentials there, never in `.env.example`.

## Run

```bash
npm run dev
```

Backend on `http://localhost:3001`, frontend on `http://localhost:5173` (Vite picks the next free port if that one is taken — check its output).

## How it works

```
POST /api/scripts/generate
  └─ Explorer (real browser)  →  harvests every interactive element,
                                 fills inputs and expands menus to surface
                                 elements that only appear after interaction,
                                 runs an axe WCAG 2.1 A/AA audit.
                                 Never submits a form.
  └─ Bedrock Converse         →  a .spec.ts with locators declared at the top,
                                 beforeEach/afterEach hooks, the functional
                                 test, and an accessibility test
  └─ saved to backend/scripts/<scriptId>.spec.ts

POST /api/scripts/:id/runs
  └─ spawns `playwright test` in a child process
  └─ backend/runs/<scriptId>/<runId>/
       video.webm    the recording for this run
       report.json   raw Playwright JSON reporter output
       stdout.log    runner output, used for diagnosing crashes
       artifacts/    Playwright's own output dir
```

## Two ways to generate

**New Test** — automatic. You give a URL and a scenario; a headless browser crawls that one page and the test is generated from it. One click, good for single-page checks.

**Record** — you drive. A visible browser opens and you walk the flow yourself: log in, dismiss banners, navigate as far as the test needs to go. Every page you land on is inventoried in the background. Close the window when you're done, describe what to verify, and the test is generated with **real locators for every page**, not just the first.

Use Record whenever the flow crosses a login or spans more than one page. The automatic crawl never submits forms, so it only ever sees the entry page — anything past that is inferred.

Two separate browsers are involved and it helps to keep them apart: one is driven by the explorer or recorder to inspect pages during generation, the other is launched by the test runner during a run.

Every generated file has the same shape — locators declared once at the top, `beforeEach` navigating to the URL, `afterEach` attaching a screenshot on failure, the functional test, and an accessibility test asserting zero WCAG 2.1 A/AA violations. A run reports each test separately, and passes only if all of them pass.

State lives in flat files — `backend/data/scripts.json` and `backend/data/runs.json`. Writes go through a per-file queue with atomic replacement, so concurrent runs finishing at the same time can't corrupt the index.

## Notes

- Video is recorded for every run, passing or failing, so `backend/runs/` grows over time. Delete a script to remove its runs, or clear the folder by hand.
- Generation is grounded in a single snapshot of the starting page. Multi-page flows still work, but locators past the first page are inferred from the scenario rather than observed.
- If the model returns something that doesn't compile, the script is still saved — fix it in the editor and run again.
