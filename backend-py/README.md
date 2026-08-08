# backend-py

A FastAPI port of the Express/TypeScript API in [`backend/`](../backend). Same
routes, same JSON shapes, same on-disk layout — the React frontend talks to it
without a single change.

## What is Python and what is still Node

The generated tests are **still Playwright TypeScript specs**, because that is the
product: the editor shows TypeScript, the a11y assertions use `@axe-core/playwright`,
and the run reports and videos come from Playwright's own JSON reporter.

| Concern | Runs on |
| --- | --- |
| HTTP API, storage, Bedrock calls | Python (FastAPI, boto3) |
| Page crawler and headed recorder | Python (`playwright` for Python) |
| Executing a generated `*.spec.ts` | Node (`@playwright/test` CLI, spawned as a child process) |
| axe-core rules used while crawling | `node_modules/axe-core`, injected into the page by Python |

So both runtimes are required. `node_modules` at the repo root supplies the CLI and
axe; `npm install` there is still a setup step.

## Setup

```bash
# from the repo root — supplies @playwright/test and axe-core
npm install

cd backend-py
python -m venv .venv && .venv\Scripts\activate     # PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt

# browsers for the Python crawler/recorder
python -m playwright install chromium

# browsers for the Node CLI that runs the specs
cd .. && npx playwright install chromium

cp backend-py/.env.example backend-py/.env        # then fill in your Bedrock credentials
```

## Run

```bash
cd backend-py
uvicorn app.main:app --reload --port 3001
```

Interactive docs land at <http://localhost:3001/docs>. The frontend's Vite proxy
already points `/api` at port 3001, so `npm run dev -w frontend` needs no change.

## Running it on another machine

A fresh box needs **Node and Python both** — the generated specs are TypeScript and
are executed by the Playwright Node CLI.

```bash
git clone https://github.com/vamsikrishna787/playwright.git
cd playwright

npm install                    # Node deps: @playwright/test 1.62.1, axe-core, vite
npx playwright install chromium

npm run setup:py               # pip install -r requirements.txt + python browsers

cp backend-py/.env.example backend-py/.env    # then add your Bedrock key
npm run dev:py                 # starts the FastAPI API and the frontend together
```

Then open <http://localhost:5173>. `dev:py` is the Python equivalent of `npm run
dev`; the original `dev` still starts the old TypeScript backend.

`.env` is gitignored, so it never comes with the clone — every machine needs its
own copy.

### Frontend and backend on *separate* machines

The API binds `0.0.0.0` under `dev:py`, so it already accepts remote connections.
Point the frontend at it:

```bash
# on the API machine
npm run dev:api

# on the frontend machine — use the API machine's address
VITE_API_TARGET=http://192.168.1.42:3001 npm run dev -w frontend
```

Windows PowerShell has no inline env-var syntax:

```powershell
$env:VITE_API_TARGET = "http://192.168.1.42:3001"; npm run dev -w frontend
```

The proxy target and the dev server's host are the only two things that change —
the browser still talks to its own origin, so there are no CORS concerns.

Three things that bite in practice:

- **Windows Firewall** blocks inbound 3001/5173 on first run. Allow them, or the
  other machine just times out.
- **Recording needs a desktop.** The recorder opens a *visible* browser on the
  machine running the API, so that box needs a real logged-in GUI session — a
  headless server or a bare SSH session cannot record. Generating from a URL,
  running tests and replaying videos all work fine headless.
- **Tests run on the API machine**, not the browser's. A test pointing at
  `localhost` resolves to the API machine's localhost.

## Credentials

`AWS_BEARER_TOKEN_BEDROCK` is read straight out of the environment by boto3 — a
Bedrock API key is a bearer token, not an IAM key pair, and needs no other wiring.
These keys are **time-limited**; when one expires the API answers with a message
saying so and pointing at the Bedrock console. Leave the variable blank to fall
back to the normal AWS chain (`aws configure`, SSO, instance roles).

## Layout

```
app/
  main.py            FastAPI app, CORS, body limit, router wiring
  config.py          paths and tunables
  models.py          Domain / Script / Run / locator library records
  http.py            {"error": ...} responses, lenient body parsing
  routers/           domains, scripts, runs, recordings
  services/
    storage.py       atomic JSON stores (a list per file, or one document)
    domains.py       host -> site, URL canonicalisation, startup backfill
    locators.py      the per-site locator library: merge, diff, verify, render
    bedrock.py       generate / edit / name, via boto3 Converse
    explorer.py      crawls a page, injects axe, renders the page report
    recorder.py      headed recording, one worker thread per session
    runner.py        spawns the Playwright Node CLI, parses its report
    generator.py     recording or library -> Bedrock -> harden -> save
    steps.py         parses a spec into the plain-English Steps view
    exemplars.py     picks previously-passing specs to imitate
    failure.py       renders a failed run for the model
    node_cli.py      finds node and node_modules/*/cli.js
playwright.runner.config.ts    read by the Node CLI, not by Python
```

`data/`, `scripts/` and `runs/` are created on first start and are gitignored.

### Storage

| File | Holds |
| --- | --- |
| `data/domains.json` | one row per site |
| `data/scripts.json` | one row per script, each carrying its `domainId` |
| `data/runs.json` | one row per run |
| `data/locators/<domainId>.json` | that site's locator library, one document |

The library is one file per site rather than a single index: it grows with every
page ever recorded, and loading every site's locators to answer a question about
one of them would get slow quickly.

Scripts written before the app was organised by site carry no `domainId`. On
startup each one adopts the site of its own source URL, creating it if the host
is new, so an existing `scripts.json` still shows up grouped rather than empty.

## Notes on the port

- **Threads, not an async browser.** Playwright's sync API is used from worker
  threads (`asyncio.to_thread`, and a dedicated thread per recording). This keeps
  browser work off the event loop without depending on which event loop policy
  uvicorn installed, which is a real difference between platforms.
- **Recording captures on a pump loop** rather than inside Playwright event
  handlers — calling back into Playwright from a sync handler can deadlock, so
  `load` events only enqueue a page and the session thread does the capture.
- **Run concurrency** is an `asyncio.Semaphore(3)` in place of the hand-rolled
  slot queue; same limit, same FIFO behaviour.
- **Video is served with byte-range support**, which the old `res.sendFile` gave
  for free. The player seeks past EOF on purpose to recover the duration of a
  header-less Playwright WebM, so partial requests have to be answered properly.
