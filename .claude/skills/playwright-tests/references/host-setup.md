# Host repository setup

The toolkit is repo-agnostic. It needs Playwright in the repository under test,
and that is all.

## Prerequisites

```bash
npm install -D @playwright/test          # if the repo has no Playwright
npx playwright install chromium          # browser binaries, once per machine
npm install -D @axe-core/playwright axe-core   # for the ADA checks
```

The capture scripts search for Playwright starting at the current directory and
walking up, including npm/yarn/pnpm workspace members and finally the global
install — a monorepo that keeps Playwright in one package works without
configuration. If they cannot find it, they say so and print the install
commands.

Without axe, capture still works: the audit section reads *not run* and the
inventory is otherwise complete. Install it before writing the a11y spec.

## Playwright config

Read the repo's `playwright.config.{ts,js,mjs}` before writing anything, for:

- `testDir` — where the three files go
- `use.baseURL` — if set, specs should use paths, not absolute URLs
- `use.testIdAttribute` — pass the same value to the capture with
  `--test-id-attribute`, so it emits `getByTestId(...)` rather than an attribute
  selector
- `projects` — which browsers a run covers

If there is no config at all, create a minimal one and say that you did:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

## Capture artifacts

Captures land in `.playwright-capture/` at the repo root. That directory ignores
itself — it contains a `.gitignore` holding `*` — so nothing needs to change in
the host repo's own `.gitignore` and no capture is ever committed by accident.

They are diagnostic input, not deliverables. Keep them out of commits, and delete
old ones freely.

## Taking the toolkit to another repo

Everything lives in two places, with no dependency on the repo it came from:

```
.claude/skills/playwright-tests/     the skill, its docs and the capture scripts
.claude/agents/playwright-test-writer.md
```

Copy both into another repo's `.claude/`, or install once for every repo:

```bash
# macOS / Linux
cp -r .claude/skills/playwright-tests ~/.claude/skills/
cp .claude/agents/playwright-test-writer.md ~/.claude/agents/

# Windows PowerShell
Copy-Item -Recurse .claude\skills\playwright-tests $HOME\.claude\skills\
Copy-Item .claude\agents\playwright-test-writer.md $HOME\.claude\agents\
```

The scripts are plain `.mjs` with no dependencies of their own — they borrow the
host repo's Playwright at run time — so a copy is all it takes.

## Sites that resist capture

- **Bot protection / CAPTCHA.** Headless is often blocked where headed is not.
  Try `--headed`, or record instead and solve the challenge by hand.
- **Nothing captured (0–2 elements).** The page needs auth, renders in an iframe,
  or draws in canvas. Record; if it is canvas, say that a DOM-locator test is not
  possible here.
- **Slow first load.** `--timeout 60000`. In a proxied or sandboxed network the
  first navigation to a public site can take minutes.
- **Login walls.** Record. For a repeatable suite, the durable answer is
  Playwright's `storageState`: sign in once, save the state, and reuse it in the
  config so tests skip the login screen.
