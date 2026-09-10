# Playwright Test Platform

Author a test as **data + steps in plain English**, have an agent write the
Playwright spec, run it headless on the server, and watch it advance step by
step — with a Lighthouse audit and a WCAG scan on every run.

Two tiers now, each with one job:

| Tier | Path | Port | Owns |
| --- | --- | --- | --- |
| **App / BFF** | `web/` | 5180 | Next.js 15 App Router. The UI, the API, the disk, the browsers. |
| **Agent API** | `backend-py/` | 8000 | FastAPI + Bedrock. Prompts and model calls. No state, no browser. |

The browser talks only to Next. Next is the only thing that calls Python.
Python is the only thing that calls a model. Swapping the model, or the prompts,
touches one tier.

---

## Getting started

```bash
npm run setup      # npm install, pip install, playwright install chromium
npm run dev        # both tiers together
```

Then open **http://localhost:5180**.

Bedrock credentials go in `backend-py/.env` (copy `.env.example`). A Bedrock API
key is a bearer token and is **time-limited** — when generation starts failing
with "Bearer Token has expired", mint a fresh one in the Bedrock console under
*API keys* and restart the agent tier.

Run a tier on its own:

```bash
npm run dev:agents   # FastAPI  :8000
npm run dev:web      # Next     :5180
```

The header shows a live **agents ready / agents offline** dot, and beside it the
storage provider currently in use. If generation does nothing, that first dot is
the first place to look.

---

## Where everything is saved

One switch decides it: **local disk** or **Amazon S3**. It covers everything the
platform saves — the suite, test and run indexes, every generated spec, and
every report, recording and Lighthouse audit a run produced.

The active profile sets the default:

```yaml
# web/src/config/local.yml
storage:
  provider: local        # local | s3
```

and **Settings** (the storage pill in the header) flips it at runtime, with the
option to bring the existing data along. The switch checks the destination
before it moves anything, so a wrong bucket name leaves the platform exactly
where it was.

```bash
# S3 needs a bucket; credentials come from the AWS SDK's own chain, never from
# the profile — which is what lets the same image run against a developer's
# access keys and a pod's IAM role.
S3_BUCKET=my-bucket AWS_REGION=us-east-1 npm run dev
```

Two things worth knowing:

- **A run always happens on local disk.** Playwright and Lighthouse are child
  processes writing real files, so a run executes in `web/.work/` and is
  *published* to the active provider when it finishes. That is why switching to
  S3 needs no shared filesystem, and why the work directory is scratch you can
  delete at any time.
- **A profile can refuse the switch.** `prod.yml` sets
  `storage.allowRuntimeToggle: false`, so nobody can move production data onto a
  pod's disk from a web page. The Settings page says so rather than failing
  silently.

Runtime overrides survive a restart (they are recorded in
`web/.work/storage-override.json`); switching back to what the profile says
removes the override rather than recording it.

---

## The workflow

**Suite → test → data → steps → script → run.**

1. **Suite** — groups the tests for one site. Its base URL prefills every test
   added under it.
2. **Test data** — lives on the **suite**, not the test: name, value, and a
   category. Every test under the suite draws on the same pool, so a login is
   entered once and shared. Each field becomes a key on the `data` object in the
   generated script, so changing a value never means regenerating — and it
   updates every test that references it. Use the category to keep groups apart
   (a valid login and the bad password a negative test needs).
3. **Steps** — what to do, what should then be true, and which of the suite's
   data fields the step uses. Attaching a field is what makes the script read
   `data.username` rather than inlining the literal. A generated spec only gets
   the fields its own steps reference, never the whole pool.
4. **Generate with AI** — Next sends the steps, the data and the URL to Python,
   which prompts the model and returns a complete spec, saved as
   `scripts/<testId>.spec.ts` in whichever storage is active.
5. **Run** — Next executes it headless. Steps light up live; the run stops
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
saved. Generation is the exception — it always saves.

### Accessibility and Lighthouse

Every generated spec carries a WCAG 2.1 A/AA axe scan as its own `test()`, so a
run grades the journey and the page's accessibility separately. It is never
weakened to make a run pass: a real violation is a true result.

After the verdict — deliberately after, since an audit takes ~30s and nobody
should wait on a performance number to learn their test failed — Lighthouse runs
against the start URL and its scores are attached to the run.

---

## Layout

```
web/                          Next.js 15 App Router — the UI and the BFF
  server-bootstrap.mjs          production entry: wraps Next in an HTTPS/mTLS server
  next.config.mjs               basePath, CSP, headers
  middleware.ts                 the auth gate — pages only, never /api
  src/config/
    application.yml             the base every profile is layered over
    local.yml dev.yml           one file per environment; APP_ENV picks it
    test.yml prod.yml
    appConfig.ts                loads, resolves ${VAR:default}, validates, freezes
  src/server/
    storage/                    THE SWITCH: local.ts | s3.ts behind one interface
    store/                      the JSON indexes, serialised per document
    services/                   runner, lighthouse, agentClient, specs, events
    paths.ts                    storage keys vs local work paths — kept apart
  app/
    api/                        the BFF: one route.ts per endpoint
    page.tsx suites/ tests/     thin shells delegating to containers
    settings/                   the storage switch
  src/containers/               one directory per page, each with its CSS module
  src/components/               data editor, steps editor, script panel, run progress
  runtime/
    playwright.runner.config.ts the config passed to the Playwright CLI with --config
    reporters/ndjson.cjs        streams a line per step, which makes runs watchable
  .data/                        local storage root (gitignored)
  .work/                        run scratch space (gitignored)

backend-py/                   Agent API
  app/services/prompts.py       everything the models are told
  app/services/agents.py        the agents, plus the validation that repairs weak output
  app/services/steps.py         spec -> plain English, no model involved
  app/services/bedrock.py       model client and its error messages
```

### The layers, in order

1. **Server bootstrap** — `server-bootstrap.mjs` wraps the Next handler in a
   Node HTTPS server (certificates at `server.tls.certDir`, mutual TLS when the
   profile asks), falling back to plain HTTP when TLS is off or the certificates
   are not there. `npm run dev` bypasses it: `next dev` is its own server.
2. **Config** — `appConfig.ts` loads `application.yml` and layers
   `<APP_ENV>.yml` over it, resolving `${VAR:default}` against the environment.
   Read once, validated, frozen. Nothing downstream reads `process.env`
   directly. Two settings are the documented exception — `BASE_PATH`, which Next
   needs at build time, and the auth pair, which the Edge middleware cannot read
   a file to get.
3. **Auth** — `middleware.ts` gates every page route and nothing else. The
   matcher excludes `/api`, `/_next` and anything with a file extension: the API
   is called by the pages themselves and carries its own errors, and gating it
   would answer a fetch with a redirect the client would try to parse as JSON.
4. **API / BFF** — `app/api/**/route.ts`. Every handler goes through one `route`
   wrapper that awaits the dynamic params, turns an `ApiError` into the right
   status, and catches everything else.
5. **UI** — `app/layout.tsx` is a server component; the pages are thin shells
   over `src/containers/*`, each with a colocated CSS module. Shared primitives
   (buttons, tables, badges, the step list) stay in `app/globals.css`. Every
   client fetch goes through `src/api/client.ts` — nothing else calls `fetch`.
6. **Build / deploy** — `Dockerfile` builds on the Playwright image, because this
   application spawns the Playwright CLI and a headless Chromium; the tag has to
   track `@playwright/test` in `package.json`.

---

## Notes and limits

- **The agent has not seen the page.** It writes locators from your step text
  (`"Click the Login button"` → `getByRole('button', { name: 'Login' })`). That
  works well for clearly-worded steps on conventional pages, and less well on
  bespoke UI. When a locator misses, run the test and use **Fix the last
  failure** — the model gets the real Playwright error and usually repairs it in
  one pass.
- **Port 5180, not 3000.** 3000 is the first port every other Node project on
  the machine takes.
- **Concurrency** is capped (`runs.maxConcurrent`, default 2). Each run is its
  own Chromium; a suite run queues beyond that. Lighthouse is one at a time
  globally, because two audits racing each other each measure the other's CPU
  contention as the page being slow.
- **Secret data fields** are masked in the UI only. The value is still written
  into the spec — these are test accounts, not production credentials.
- **Deleting a suite data field** unhooks it from every step in the suite that
  referenced it. That cascade is deliberate: a step pointing at a field that no
  longer exists would generate a reference to nothing.
- **The Playwright HTML report** is served through `/api/runs/<id>/report/…` as
  a directory rather than a single file, because its index asks for `data/*`
  beside itself. Ending that URL at `/report` resolves those one level too high
  and the report renders with its attachments missing.

### Coming from the three-tier version

The Express `backend/` and the Vite `frontend/` are gone — both are now `web/`.
Data written by the old backend uses exactly the key shape the storage layer
uses now, so importing it is a copy:

```bash
npm run import:legacy      # backend/{data,scripts,runs} -> web/.data
```

To end up in S3 instead, import to local disk first and then flip the switch on
the Settings page with *copy what is already saved* ticked.
