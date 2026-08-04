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
  config.py          paths and tunables            (was src/config.ts)
  models.py          ScriptRecord / RunRecord      (was src/types.ts)
  http.py            {"error": ...} responses, lenient body parsing
  routers/           scripts, runs, recordings     (was src/routes/)
  services/
    storage.py       atomic JSON stores
    bedrock.py       generate / edit / name, via boto3 Converse
    explorer.py      crawls a page, injects axe, renders the page report
    recorder.py      headed recording, one worker thread per session
    runner.py        spawns the Playwright Node CLI, parses its report
    generator.py     crawl -> Bedrock -> harden -> save
    exemplars.py     picks previously-passing specs to imitate
    failure.py       renders a failed run for the model
    node_cli.py      finds node and node_modules/*/cli.js
playwright.runner.config.ts    read by the Node CLI, not by Python
```

`data/`, `scripts/` and `runs/` are created on first start and are gitignored. To
carry over existing work, copy those three directories from `backend/`.

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
