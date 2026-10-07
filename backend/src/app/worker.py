"""Worker Lambda (container image with Chromium, Node, Playwright MCP and Lighthouse).

Invoked asynchronously by the API with {"action": "generate" | "run", ...}.
"""

import json
import time
import traceback
from pathlib import Path

from . import pw, store

CONTENT_TYPES = {
    "video.webm": "video/webm",
    "screenshot.png": "image/png",
    "trace.zip": "application/zip",
    "report.zip": "application/zip",
    "results.json": "application/json",
    "lighthouse.html": "text/html; charset=utf-8",
    "lighthouse.json": "application/json",
}


def run_job(event, context):
    suite_id, test_id, run_id = event["suiteId"], event["testId"], event["runId"]
    test_prefix = store.test_prefix(suite_id, test_id)
    prefix = store.run_prefix(suite_id, test_id, run_id)
    run = store.get_json(prefix + "run.json")
    if not run or run.get("status") != "queued":
        print(f"Run {run_id} is not queued, skipping")
        return

    suite = store.get_json(store.suite_prefix(suite_id) + "suite.json")
    test = store.get_json(test_prefix + "test.json")
    code = store.get_text(test_prefix + "script.spec.ts")
    script_meta = store.get_json(test_prefix + "script.json") or {}
    start_url = store.resolve_start_url(suite, test)

    run.update({"status": "running", "startedAt": store.now_iso(), "startUrl": start_url,
                "scriptGeneratedAt": script_meta.get("generatedAt")})
    store.put_json(prefix + "run.json", run)

    workdir = Path("/tmp/runs") / run_id
    try:
        budget = context.get_remaining_time_in_millis() / 1000 - 30
        lighthouse_reserve = 150 if run.get("lighthouse") else 0
        result = pw.run_spec(
            code,
            workdir / "playwright",
            {"TEST_DATA": json.dumps(store.test_data(test)), "START_URL": start_url},
            record=True,
            timeout_s=int(max(60, budget - lighthouse_reserve)),
        )
        store.put_text(prefix + "output.log", result["output"])
        for name, path in result["artifacts"].items():
            store.put_file(prefix + name, str(path), CONTENT_TYPES[name])
        run.update({
            "status": "passed" if result["passed"] else "failed",
            "durationMs": result["durationMs"],
            "tests": result["tests"],
            "error": "\n---\n".join(result["errors"])[:8000] or None,
        })

        if run.get("lighthouse"):
            run["lighthouseStatus"] = "running"
            store.put_json(prefix + "run.json", run)
            remaining = context.get_remaining_time_in_millis() / 1000 - 20
            started = time.time()
            scores, html_path, json_path, error = pw.run_lighthouse(
                start_url, workdir / "lighthouse", run.get("lighthousePreset", "desktop"), int(max(30, remaining)))
            if scores is not None:
                store.put_file(prefix + "lighthouse.html", str(html_path), CONTENT_TYPES["lighthouse.html"])
                store.put_file(prefix + "lighthouse.json", str(json_path), CONTENT_TYPES["lighthouse.json"])
            run.update({
                "lighthouseStatus": "done" if scores is not None else "failed",
                "lighthouseScores": scores,
                "lighthouseError": error,
                "lighthouseDurationMs": int((time.time() - started) * 1000),
            })
    except Exception as err:  # noqa: BLE001 - record the failure on the run
        traceback.print_exc()
        run.update({"status": "error", "error": f"{type(err).__name__}: {err}"})
    finally:
        run["finishedAt"] = store.now_iso()
        store.put_json(prefix + "run.json", run)


SELFCHECK_SPEC = """import { test, expect } from '@playwright/test';
test('selfcheck', async ({ page }) => {
  await page.goto(process.env.START_URL!);
  await expect(page).toHaveTitle(/Example/);
});
"""


def selfcheck(event):
    """Exercise the browser stack inside Lambda: MCP navigation, a recorded spec, and Lighthouse."""
    import asyncio
    from .generator import mcp_selfcheck

    url = event.get("url", "https://example.com/")
    report = {}
    try:
        report["mcp"] = asyncio.run(mcp_selfcheck(Path("/tmp/selfcheck/mcp"), url))
    except Exception as err:  # noqa: BLE001 - report every stage
        report["mcp"] = {"ok": False, "output": f"{type(err).__name__}: {err}"}
    result = pw.run_spec(SELFCHECK_SPEC, Path("/tmp/selfcheck/pw"), {"START_URL": url}, record=True, timeout_s=180)
    report["playwright"] = {"ok": result["passed"], "artifacts": sorted(result["artifacts"]),
                            "errors": [e[-800:] for e in result["errors"]], "output": result["output"][-800:]}
    scores, _, _, error = pw.run_lighthouse(url, Path("/tmp/selfcheck/lh"), "desktop", 180)
    report["lighthouse"] = {"ok": scores is not None, "scores": scores, "error": error}
    print(json.dumps(report))
    return report


def handler(event, context):
    action = event.get("action")
    print(f"Worker action={action} event={json.dumps(event)}")
    if action == "generate":
        # Imported lazily so run jobs don't pay for the Anthropic/MCP import cost.
        from .generator import generate_job
        generate_job(event, context)
    elif action == "run":
        run_job(event, context)
    elif action == "selfcheck":
        return selfcheck(event)
    else:
        raise ValueError(f"Unknown action {action!r}")
