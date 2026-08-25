# Playwright Test Platform

Author a test as **data + steps in plain English**, have an agent write the
Playwright spec, run it headless on the server, and watch it advance step by
step — with a Lighthouse audit and a WCAG scan on every run.

Three tiers, each with one job:

| Tier | Path | Port | Owns |
| --- | --- | --- | --- |
| **UI** | `frontend/` | 5180 | React + Vite + Monaco. Suites, tests, data, steps, script, runs. |
| **Orchestration API** | `backend/` | 4000 | Node + Express. All state on disk, runs the browsers, streams progress. |
| **Agent API** | `backend-py/` | 8000 | FastAPI + Bedrock. Prompts and model calls. No state, no browser. |

The UI talks only to Node. Node is the only thing that calls Python. Python is
the only thing that calls a model. Swapping the model, or the prompts, touches
one tier.

---

## Getting started

```bash
npm run setup      # npm install, pip install, playwright install chromium
npm run dev        # all three tiers together
```

Then open **http://localhost:5180**.

Bedrock credentials go in `backend-py/.env` (copy `.env.example`). A Bedrock API
key is a bearer token and is **time-limited** — when generation starts failing
with "Bearer Token has expired", mint a fresh one in the Bedrock console under
*API keys* and restart the agent tier.

Run a tier on its own:

```bash
npm run dev:agents   # FastAPI  :8000
npm run dev:api      # Node     :4000
npm run dev:ui       # Vite     :5180
```

The header shows a live **agents ready / agents offline** dot. If generation
does nothing, that dot is the first place to look.

---

## The workflow

**Suite → test → data → steps → script → run.**

1. **Suite** — groups the tests for one site. Its base URL prefills every test
   added under it.
2. **Test data** — name, value, and a category. Each field becomes a key on the
   `data` object in the generated script, so changing a value never means
   regenerating.
3. **Steps** — what to do, what should then be true, and which data fields the
   step uses. Attaching a field is what makes the script read `data.username`
   rather than inlining the literal.
4. **Generate with AI** — Node sends the steps, the data and the URL to Python,
   which prompts the model and returns a complete spec. Saved to
   `backend/scripts/<testId>.spec.ts`.
5. **Run** — Node executes it headless. Steps light up live; the run stops
   visibly at whichever step broke.

### Step tags are the mechanism

The generator is instructed to wrap every authored step in a tagged
`test.step`:

```ts
await test.step('[S2] Fill the Password field', async () => { … });
```

That tag is how a live run maps back to the user's own step list, which is what
makes "passed 3 of 5 steps, failed at step 4" possible. Steps the agent adds
itself — setup, the accessibility scan — are untagged and shown separately, so a
step number in the UI always means the same thing as a step number in the
editor.

If a model forgets the tags entirely, the runner falls back to matching steps by
order of appearance, and generation warns which tags were missing.

### Script view and Steps view

The **Script view** is the file. The **Steps view** is the agent tier reading
that file back as sentences — resolving `data.username` to its real value — so
you can see what the script actually does after a few refinements, which is not
always what was originally written down.

### Asking an agent to change it

Each button is a separate Python endpoint, listed by `GET /agents/catalog` so a
new agent needs no UI change:

| Action | Does |
| --- | --- |
| **Refine** | A change you describe in plain English. |
| **Improve** | A hardening pass — stability, readability, coverage or speed. Never changes what the test verifies. |
| **Deepen accessibility** | Extends the axe scan past the landing page, adds keyboard-reachability and accessible-name checks. |
| **Fix the last failure** | Reads the real output of the failing run and repairs the cause. |

Results come back **unsaved** so you can read them before they replace what is
on disk. Generation is the exception — it always saves.

### Accessibility and Lighthouse

Every generated spec carries a WCAG 2.1 A/AA axe scan as its own `test()`, so a
run grades the journey and the page's accessibility separately. It is never
weakened to make a run pass: a real violation is a true result.

After the verdict — deliberately after, since an audit takes ~30s and nobody
should wait on a performance number to learn their test failed — Node runs
Lighthouse against the start URL and attaches the scores to the run.

---

## Layout

```
backend/                    Node orchestration API
  playwright.runner.config.ts   config the API passes with --config
  reporters/ndjson.cjs          streams a line per step, which is what makes runs watchable
  src/routes/                   suites, tests, scripts + AI, runs
  src/services/runner.ts        spawns Playwright, folds events into the run record
  src/services/agentClient.ts   the only door to the Python tier
  data/  scripts/  runs/        state on disk (gitignored)

backend-py/                 Agent API
  app/services/prompts.py       everything the models are told
  app/services/agents.py        the agents, plus the validation that repairs weak output
  app/services/steps.py         spec -> plain English, no model involved
  app/services/bedrock.py       model client and its error messages

frontend/                   React UI
  src/pages/                    SuitesPage, SuiteDetailPage, TestEditorPage
  src/components/               data editor, steps editor, script panel, run progress
  src/hooks/useRunStream.ts     SSE subscription for one run
```

Storage is JSON files plus spec files on disk — `suites.json`, `tests.json`,
`runs.json`. Every write is atomic and serialised per file.

---

## Notes and limits

- **The agent has not seen the page.** It writes locators from your step text
  (`"Click the Login button"` → `getByRole('button', { name: 'Login' })`). That
  works well for clearly-worded steps on conventional pages, and less well on
  bespoke UI. When a locator misses, run the test and use **Fix the last
  failure** — the model gets the real Playwright error and usually repairs it in
  one pass.
- **Vite is on 5180, not 5173**, with `strictPort` — 5173 is the first port every
  other Vite project takes, and a silent fallback means debugging someone else's
  app.
- **Concurrency** is capped (`MAX_CONCURRENT_RUNS`, default 2). Each run is its
  own Chromium; a suite run queues beyond that. Lighthouse is one at a time
  globally, because two audits racing each other each measure the other's CPU
  contention as the page being slow.
- **Secret data fields** are masked in the UI only. The value is still written
  into the spec — these are test accounts, not production credentials.
