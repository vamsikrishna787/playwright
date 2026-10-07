"""AI script generation: a model on Amazon Bedrock drives Playwright MCP, then proves the script passes.

This only runs when the user clicks "Generate". Test runs never call a model: they execute the
saved, verified script (see worker.run_job).

Flow
1. Start the Playwright MCP server (stdio) with a headless Chromium.
2. Agent loop with the configured Bedrock model (see llm.py): the model performs the test steps
   live with the browser_* tools, writes a spec, and calls `submit_script`.
3. `submit_script` runs the spec with `playwright test` in a clean browser. Failures go back to
   the model as tool errors so it can investigate and resubmit.
4. Only a passing script is saved as script.spec.ts. The last failing attempt is kept as draft.spec.ts.
"""

import asyncio
import os
import json
import shutil
import time
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from . import llm, prompts, pw, store
from .llm import ToolResult

MODEL = llm.MODEL
MAX_TURNS = int(os.environ.get("GENERATION_MAX_TURNS", "80"))
MAX_SUBMISSIONS = int(os.environ.get("GENERATION_MAX_SUBMISSIONS", "6"))

MCP_CLI = pw.NODE_APP / "node_modules" / "@playwright" / "mcp" / "cli.js"
# Tools that are irrelevant to recording a test or would end the session early, plus tools that
# reach outside the page (Node code execution, local file access). Page content is untrusted.
EXCLUDED_TOOLS = {
    "browser_install", "browser_close", "browser_resize", "browser_pdf_save", "browser_take_screenshot",
    "browser_run_code_unsafe", "browser_run_code", "browser_file_upload", "browser_drop",
}
MAX_TOOL_TEXT = 60_000
MAX_LOG_ENTRIES = 300


class GenerationError(Exception):
    pass


class JobLog:
    """Keeps generation.json in S3 up to date so the UI can show live progress."""

    def __init__(self, key, job):
        self.key = key
        self.job = job
        self.job.setdefault("log", [])
        self._last_flush = 0.0

    def add(self, kind, message, detail=None):
        entry = {"t": store.now_iso(), "kind": kind, "message": message[:2000]}
        if detail:
            entry["detail"] = detail[:4000]
        self.job["log"] = (self.job["log"] + [entry])[-MAX_LOG_ENTRIES:]
        print(f"[{kind}] {message[:500]}")
        self.flush()

    def flush(self, force=False):
        if force or time.time() - self._last_flush > 1.5:
            store.put_json(self.key, self.job)
            self._last_flush = time.time()


def mcp_result_blocks(result):
    blocks = []
    for item in getattr(result, "content", None) or []:
        if item.type == "text":
            text = item.text
            if len(text) > MAX_TOOL_TEXT:
                text = text[:MAX_TOOL_TEXT] + "\n...(output truncated)"
            blocks.append({"type": "text", "text": text})
        elif item.type == "image":
            blocks.append({"type": "image", "source": {"type": "base64", "media_type": item.mime_type, "data": item.data}})
        else:
            blocks.append({"type": "text", "text": json.dumps(item.model_dump(mode="json"))[:MAX_TOOL_TEXT]})
    return blocks or [{"type": "text", "text": "(no output)"}], bool(getattr(result, "is_error", False))


def clean_schema(schema):
    schema = dict(schema or {"type": "object", "properties": {}})
    schema.pop("$schema", None)
    return schema


def describe_failure(result):
    parts = ["FAILED. Fix the script and call submit_script again."]
    if result["timedOut"]:
        parts.append("The run timed out.")
    parts.append("Errors:\n" + "\n---\n".join(result["errors"])[:6000])
    for test in result["tests"]:
        failed_steps = [s for s in test["steps"] if s.get("error")]
        if failed_steps:
            parts.append("Failed step: " + failed_steps[0]["title"])
    parts.append("Runner output (tail):\n" + pw.tail(result["output"], 3000))
    return "\n\n".join(parts)


def mcp_launch_options():
    """Browser for the MCP server.

    In Lambda, use chrome-headless-shell: full Chromium crashes there with --single-process.
    The newest revision is the one @playwright/mcp's own playwright-core was installed with.
    """
    shells = sorted(
        Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/ms-playwright")).glob(
            "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"),
        key=lambda p: int(p.parts[-3].rsplit("-", 1)[-1]),
    )
    if shells:
        return {"executablePath": str(shells[-1]), "args": pw.CHROMIUM_ARGS}
    return {"channel": "chromium", "args": pw.CHROMIUM_ARGS}  # local development


def mcp_server_params(workdir):
    config_path = workdir / "mcp-config.json"
    config_path.write_text(json.dumps({
        "browser": {"browserName": "chromium", "launchOptions": mcp_launch_options()},
    }), encoding="utf-8")
    return StdioServerParameters(
        command=pw.NODE,
        args=[
            str(MCP_CLI), "--config", str(config_path),
            "--headless", "--isolated", "--no-sandbox",
            "--image-responses", "omit",
            "--viewport-size", "1280x720",
            "--ignore-https-errors",
            "--timeout-action", "10000",
            "--codegen", "typescript",
            "--output-dir", str(workdir / "mcp-output"),
        ],
        env={**pw.child_env(), "HOME": "/tmp"},
        cwd=str(workdir),
    )


async def mcp_selfcheck(workdir, url):
    """Start Playwright MCP and navigate once. Used by the worker's `selfcheck` action."""
    workdir.mkdir(parents=True, exist_ok=True)
    with open(workdir / "mcp-server.log", "w") as errlog:
        async with stdio_client(mcp_server_params(workdir), errlog=errlog) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool("browser_navigate", {"url": url}, read_timeout_seconds=120)
                blocks, is_error = mcp_result_blocks(result)
                return {"ok": not is_error, "output": blocks[0].get("text", "")[-1500:]}


def text_result(tool_id, text, is_error=False):
    return ToolResult(tool_id, [{"type": "text", "text": text}], is_error)


class Generator:
    def __init__(self, suite, test, job_log, deadline):
        self.suite = suite
        self.test = test
        self.log = job_log
        self.deadline = deadline
        self.start_url = store.resolve_start_url(suite, test)
        self.data = store.test_data(test)
        self.workdir = Path("/tmp/jobs") / job_log.job["jobId"]
        self.last_code = None
        self.summary = ""
        self.turns = 0
        self.submissions = 0
        self.usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}

    def verify(self, code):
        self.last_code = code
        if "@playwright/test" not in code:
            return False, "FAILED. The file must import from '@playwright/test'. Submit the complete spec file."
        timeout = int(max(60, min(300, self.deadline - time.time() - 20)))
        result = pw.run_spec(
            code,
            self.workdir / "verify",
            {"TEST_DATA": json.dumps(self.data), "START_URL": self.start_url},
            record=False,
            timeout_s=timeout,
        )
        if result["passed"]:
            return True, f"PASSED in {result['durationMs'] / 1000:.1f}s. The script has been saved."
        return False, describe_failure(result)

    async def run(self):
        shutil.rmtree(self.workdir, ignore_errors=True)
        self.workdir.mkdir(parents=True)
        server = mcp_server_params(self.workdir)

        with open(self.workdir / "mcp-server.log", "w") as errlog:
            async with stdio_client(server, errlog=errlog) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listed = await session.list_tools()
                    tools = [
                        {"name": t.name, "description": t.description or t.name, "input_schema": clean_schema(t.input_schema)}
                        for t in listed.tools if t.name not in EXCLUDED_TOOLS
                    ] + [prompts.SUBMIT_TOOL]
                    self.log.add("info", f"Browser ready, {len(tools) - 1} Playwright MCP tools available. Model: {MODEL}")
                    backend = llm.make_backend(prompts.SYSTEM_PROMPT, tools)
                    return await self._loop(session, backend)

    async def _loop(self, session, backend):
        backend.add_user_text(prompts.test_case_message(self.suite, self.test, self.start_url, self.data))
        nudges = 0
        while True:
            self.turns += 1
            if self.turns > MAX_TURNS:
                raise GenerationError(f"Stopped after {MAX_TURNS} model turns without a passing script")
            if time.time() > self.deadline - 60:
                raise GenerationError("Ran out of time (Lambda 15 minute limit) before a passing script was produced")

            turn = await asyncio.to_thread(backend.step)
            for key in self.usage:
                self.usage[key] += turn.usage.get(key, 0)
            self.log.job["usage"] = self.usage

            if turn.text:
                self.log.add("model", turn.text[:600])
            if turn.stop == "refusal":
                raise GenerationError("The model declined this request")
            if turn.stop == "max_tokens" and not turn.tool_calls:
                raise GenerationError("The model response exceeded the output token limit")

            if not turn.tool_calls:
                if "CANNOT_AUTOMATE:" in turn.text:
                    raise GenerationError("Cannot automate: " + turn.text.split("CANNOT_AUTOMATE:", 1)[1].strip()[:2000])
                nudges += 1
                if nudges > 2:
                    raise GenerationError("The model stopped without submitting a script")
                backend.add_user_text(
                    "Continue. When all steps are done, call submit_script with the complete spec. "
                    "If the test cannot be automated, reply starting with CANNOT_AUTOMATE:."
                )
                continue

            results = []
            for call in turn.tool_calls:
                if call.name == "submit_script":
                    self.submissions += 1
                    self.summary = call.input.get("summary", "")
                    self.log.add("verify", f"Running submitted script (attempt {self.submissions}/{MAX_SUBMISSIONS})")
                    passed, feedback = await asyncio.to_thread(self.verify, call.input.get("code", ""))
                    if passed:
                        self.log.add("success", feedback)
                        return self.last_code
                    self.log.add("verify-failed", "Script failed verification", feedback)
                    if self.submissions >= MAX_SUBMISSIONS:
                        raise GenerationError(f"Script still failing after {MAX_SUBMISSIONS} attempts. Last error:\n{feedback[:1500]}")
                    results.append(text_result(call.id, feedback, is_error=True))
                    continue

                self.log.add("tool", f"{call.name} {json.dumps(call.input)[:300]}")
                try:
                    result = await session.call_tool(call.name, call.input, read_timeout_seconds=120)
                    blocks, is_error = mcp_result_blocks(result)
                except Exception as err:  # noqa: BLE001 - report tool failures to the model
                    blocks, is_error = [{"type": "text", "text": f"Tool error: {err}"}], True
                if is_error:
                    self.log.add("tool-error", f"{call.name} failed", blocks[0].get("text", ""))
                results.append(ToolResult(call.id, blocks, is_error))
            backend.add_tool_results(results)


def generate_job(event, context):
    suite_id, test_id, job_id = event["suiteId"], event["testId"], event["jobId"]
    prefix = store.test_prefix(suite_id, test_id)
    job = store.get_json(prefix + "generation.json") or {}
    if job.get("jobId") != job_id:
        print(f"Job {job_id} superseded by {job.get('jobId')}, skipping")
        return

    suite = store.get_json(store.suite_prefix(suite_id) + "suite.json")
    test = store.get_json(prefix + "test.json")
    log = JobLog(prefix + "generation.json", job)
    job.update({"status": "running", "startedAt": store.now_iso(), "model": MODEL})
    log.add("info", f"Generating a script for '{test['name']}'")

    deadline = time.time() + context.get_remaining_time_in_millis() / 1000 - 30
    generator = Generator(suite, test, log, deadline)
    try:
        code = asyncio.run(generator.run())
    except Exception as err:  # noqa: BLE001 - record every failure on the job
        message = str(err) if isinstance(err, GenerationError) else f"{type(err).__name__}: {err}"
        if generator.last_code:
            store.put_text(prefix + "draft.spec.ts", generator.last_code)
        job.update({"status": "failed", "error": message, "finishedAt": store.now_iso(),
                    "turns": generator.turns, "submissions": generator.submissions})
        log.add("error", message)
        log.flush(force=True)
        if not isinstance(err, GenerationError):
            raise
        return

    store.put_text(prefix + "script.spec.ts", code)
    store.put_json(prefix + "script.json", {
        "jobId": job_id,
        "generatedAt": store.now_iso(),
        "definitionHash": store.definition_hash(suite, test),
        "model": MODEL,
        "summary": generator.summary,
        "turns": generator.turns,
        "submissions": generator.submissions,
        "usage": generator.usage,
    })
    store.delete_key(prefix + "draft.spec.ts")
    job.update({"status": "succeeded", "finishedAt": store.now_iso(), "turns": generator.turns,
                "submissions": generator.submissions, "error": None})
    log.add("info", "Verified script saved to S3")
    log.flush(force=True)
