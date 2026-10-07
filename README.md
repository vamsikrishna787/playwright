# Browser Automation Lab

An open source app from [OpenSuperLab](https://opensuperlab.com) for building end-to-end tests without writing code.
Describe a test in plain language, let an AI agent perform it in a real browser and turn it into a
**verified Playwright script**, then run that script on demand with video, trace and Lighthouse reports.

Live at **https://opensuperlab.com/labs/browserautomation/**

## How it works

1. **Test suites** group related test cases and hold a base URL.
2. **Test cases** have a start URL, ordered steps, an expected result, and **data points**
   (key/value test data such as usernames). Steps refer to data points as `{{key}}`.
3. **Generate** (AI, only when you ask): the worker Lambda starts a headless Chromium behind the
   [Playwright MCP](https://github.com/microsoft/playwright-mcp) server, and a model on Amazon Bedrock
   performs the steps through MCP tools. It then writes a Playwright Test spec and submits it. The platform
   runs the spec in a clean browser. Failures go back to the agent, which fixes the script and resubmits.
   Only a script that passes is saved to S3.
4. **Run** (no AI): the worker Lambda downloads the saved script and executes it with `playwright test`,
   recording a video, trace, screenshot and HTML report, plus an optional Lighthouse audit.
   Everything lands in S3 and can be viewed or downloaded from the UI.

Scripts read data points from `TEST_DATA` at run time, so changing a value (a password, a search term)
does not require regenerating. Changing steps, the start URL, the expected result or the set of data keys
marks the script **outdated** until you regenerate.

## Architecture

```
Browser ──HTTPS──▶ CloudFront (opensuperlab.com/labs/browserautomation*) ──▶ S3 static website (React UI)
   │
   └──HTTPS + x-api-token──▶ API Gateway (HTTP API) ──▶ API Lambda (Python, zip)
                                                          │  CRUD on S3 JSON, presigned report URLs
                                                          └─ async invoke ─▶ Worker Lambda (Python, container image)
                                                                              ├─ generate: Bedrock model ⇄ Playwright MCP ⇄ Chromium
                                                                              │            └─ verify with `playwright test`
                                                                              └─ run: `playwright test` + Lighthouse
                                                          S3 data bucket ◀────┘ suites, tests, scripts, runs, artifacts
```

| Piece | Where |
| --- | --- |
| UI: Vite + React + TypeScript, styled to match opensuperlab.com | `frontend/` |
| API Lambda: routing, validation, status roll-ups | `backend/src/app/api.py` |
| S3 storage layout and helpers | `backend/src/app/store.py` |
| Agent loop: Playwright MCP + verification | `backend/src/app/generator.py`, `prompts.py` |
| Model backends: Bedrock Converse (any model) and Claude | `backend/src/app/llm.py` |
| Playwright runner + Lighthouse | `backend/src/app/pw.py`, `worker.py` |
| Worker image: Python + Node + Chromium + Playwright MCP + Lighthouse | `backend/worker/Dockerfile` |
| Infrastructure (SAM/CloudFormation) | `infra/app.yaml`, `infra/build.yaml` |
| One-command deploy | `scripts/deploy.py`, `deploy.config.json` |

### S3 layout (data bucket)

```
suites/{suiteId}/suite.json
suites/{suiteId}/tests/{testId}/test.json          definition (API writes)
suites/{suiteId}/tests/{testId}/generation.json    latest AI job + live log (worker writes)
suites/{suiteId}/tests/{testId}/script.spec.ts     verified Playwright script
suites/{suiteId}/tests/{testId}/script.json        script metadata (model, attempts, tokens)
suites/{suiteId}/tests/{testId}/draft.spec.ts      last unverified attempt, if generation failed
suites/{suiteId}/tests/{testId}/runs/{runId}/      run.json, video.webm, trace.zip, report.zip,
                                                   screenshot.png, results.json, output.log,
                                                   lighthouse.html, lighthouse.json
```

## Choosing the model

Generation works with any Bedrock model that supports tool use. Set `model` in `deploy.config.json`:

| Model id | Notes |
| --- | --- |
| `us.moonshotai.kimi-k3` | **Default.** Strong agentic tool use; verified end to end with this app. |
| `qwen.qwen3-coder-next` | Coding-focused alternative. |
| `us.amazon.nova-2-lite-v1:0` | Amazon-native and lowest cost, but in testing it stopped after its first failed verification instead of fixing the script. |
| `anthropic.claude-opus-4-8`, `anthropic.claude-opus-5-5` | Claude, through the Anthropic SDK. Requires the account's Anthropic use-case form on Bedrock (see below). |

Claude on Bedrock needs a one-time **Anthropic use case** form per AWS account: Bedrock console →
Model catalog → any Anthropic model → *Submit use case details*. Access applies about 15 minutes after
submission. Third-party models such as Kimi are subscribed through AWS Marketplace on first use, which
the worker role is allowed to do.

## Deploy

Requirements: Python 3.10+ with `boto3`, AWS CLI v2, Node 20+, and AWS credentials. Docker is **not**
needed: the worker image is built in AWS CodeBuild.

```bash
python scripts/deploy.py
```

This deploys `e2e-studio-build` (ECR + CodeBuild) and `e2e-studio-app` (S3, API Gateway, Lambdas), builds
the UI, uploads it under `labs/browserautomation/` in the website bucket, and adds a
`/labs/browserautomation*` route to the existing opensuperlab.com CloudFront distribution
(`cloudfrontDistributionId` in `deploy.config.json`). Other routes on that distribution are untouched.

The first deploy creates an API token in `.deploy/api-token` (git-ignored). Paste it into the UI on first visit.

Useful variants:

```bash
python scripts/deploy.py --skip-image       # backend config/API changes only
python scripts/deploy.py --only-frontend    # UI changes only
python scripts/deploy.py --model qwen.qwen3-coder-next
```

## Local development

```bash
cd frontend
npm install
echo VITE_API_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com > .env.development.local
npm run dev    # http://localhost:5173/labs/browserautomation/
```

`http://localhost:5173` is allowed by the API's CORS settings.

## Limits and notes

- Lambda caps a job at 15 minutes. Generation on slow sites can take several minutes. Longer flows are a good
  fit for moving the worker to ECS Fargate with the same image.
- The API is protected by a shared token (`x-api-token`). For multi-user production use, put Cognito in front.
- Page content is untrusted: the agent cannot use MCP tools that run Node code or read local files, and
  browser/test subprocesses run without the Lambda's AWS credentials.
- Data point values are stored in S3 (encrypted at rest) and sent to the model during generation.
  Use dedicated test accounts, not real credentials.
