"""Run Playwright specs and Lighthouse inside the worker container."""

import json
import os
import re
import shlex
import shutil
import subprocess
import time
from pathlib import Path

NODE = os.environ.get("NODE_BIN", "node")
NODE_APP = Path(os.environ.get("NODE_APP", "/opt/node-app"))
PLAYWRIGHT_CLI = NODE_APP / "node_modules" / "@playwright" / "test" / "cli.js"
LIGHTHOUSE_CLI = NODE_APP / "node_modules" / "lighthouse" / "cli" / "index.js"
CHROME_PATH_FILE = Path("/opt/chrome-path")

# Lambda has no /dev/shm and no user namespaces; these flags keep Chromium stable there.
CHROMIUM_ARGS = shlex.split(os.environ.get(
    "CHROMIUM_ARGS",
    "--disable-dev-shm-usage --disable-gpu --no-zygote --single-process",
))

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def strip_ansi(text):
    return ANSI_RE.sub("", text or "")


def tail(text, limit):
    text = strip_ansi(text)
    return text if len(text) <= limit else "...(truncated)...\n" + text[-limit:]


def child_env(**extra):
    """Environment for browser/test subprocesses, without the Lambda's AWS credentials.

    Generated scripts and page content are untrusted, so they never see credentials.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("AWS_")}
    env.update(extra)
    return env


def chrome_path():
    return CHROME_PATH_FILE.read_text(encoding="utf-8").strip() if CHROME_PATH_FILE.exists() else ""


def _config_js(record):
    config = {
        "testDir": "./tests",
        "outputDir": "./test-results",
        "timeout": 180_000,
        "expect": {"timeout": 10_000},
        "retries": 0,
        "workers": 1,
        "reporter": [["list"], ["json", {"outputFile": "results.json"}]]
        + ([["html", {"outputFolder": "html-report", "open": "never"}]] if record else []),
        "use": {
            "headless": True,
            "viewport": {"width": 1280, "height": 720},
            "ignoreHTTPSErrors": True,
            "actionTimeout": 15_000,
            "navigationTimeout": 45_000,
            "video": {"mode": "on", "size": {"width": 1280, "height": 720}} if record else "off",
            "trace": "on" if record else "off",
            "screenshot": "on" if record else "only-on-failure",
            "launchOptions": {"args": CHROMIUM_ARGS},
        },
    }
    return "module.exports = " + json.dumps(config, indent=2) + ";\n"


def _collect_results(node, out):
    """Walk the Playwright JSON report (suites nest arbitrarily)."""
    for spec in node.get("specs", []):
        for test in spec.get("tests", []):
            for result in test.get("results", []):
                errors = [strip_ansi(e.get("message", "")) for e in result.get("errors", []) if e.get("message")]
                out.append({
                    "title": spec.get("title"),
                    "status": result.get("status"),
                    "durationMs": result.get("duration"),
                    "errors": errors,
                    "steps": [
                        {"title": s.get("title"), "durationMs": s.get("duration"),
                         "error": strip_ansi((s.get("error") or {}).get("message", "")) or None}
                        for s in result.get("steps", [])
                    ],
                })
    for child in node.get("suites", []):
        _collect_results(child, out)


def run_spec(code, workdir, env_vars, record, timeout_s):
    """Write a throwaway Playwright project to workdir and run the spec.

    Returns a dict with passed, durationMs, tests, errors, output and paths of produced artifacts.
    """
    workdir = Path(workdir)
    shutil.rmtree(workdir, ignore_errors=True)
    (workdir / "tests").mkdir(parents=True)
    (workdir / "tests" / "generated.spec.ts").write_text(code, encoding="utf-8")
    (workdir / "playwright.config.js").write_text(_config_js(record), encoding="utf-8")
    # Let `import { test } from '@playwright/test'` resolve from the image's node_modules.
    os.symlink(NODE_APP / "node_modules", workdir / "node_modules", target_is_directory=True)

    env = child_env(**env_vars, CI="1", FORCE_COLOR="0", NO_COLOR="1")
    started = time.time()
    try:
        proc = subprocess.run(
            [NODE, str(PLAYWRIGHT_CLI), "test", "--config", "playwright.config.js"],
            cwd=workdir, env=env, capture_output=True, text=True, timeout=timeout_s,
        )
        output = proc.stdout + ("\n" + proc.stderr if proc.stderr else "")
        timed_out = False
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or "") if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
        output += f"\n[runner] Playwright did not finish within {timeout_s}s and was stopped."
        timed_out = True
    duration_ms = int((time.time() - started) * 1000)

    tests, report = [], None
    results_file = workdir / "results.json"
    if results_file.exists():
        report = json.loads(results_file.read_text(encoding="utf-8"))
        for suite in report.get("suites", []):
            _collect_results(suite, tests)
    report_errors = [strip_ansi(e.get("message", "")) for e in (report or {}).get("errors", [])]
    stats = (report or {}).get("stats", {})

    passed = (not timed_out and bool(tests)
              and stats.get("unexpected", 1) == 0 and stats.get("expected", 0) > 0 and not report_errors)
    errors = report_errors + [e for t in tests for e in t["errors"]]
    if not passed and not errors:
        errors = ["Playwright run failed before producing results:\n" + tail(output, 4000)]

    artifacts = {"results.json": results_file if results_file.exists() else None}
    results_dir = workdir / "test-results"
    if results_dir.exists():
        for path in sorted(results_dir.rglob("*")):
            if path.suffix == ".webm":
                artifacts.setdefault("video.webm", path)
            elif path.name == "trace.zip":
                artifacts.setdefault("trace.zip", path)
            elif path.suffix == ".png":
                artifacts["screenshot.png"] = path  # last one wins: the final state
    if record and (workdir / "html-report").exists():
        artifacts["report.zip"] = Path(shutil.make_archive(str(workdir / "report"), "zip", workdir / "html-report"))

    return {
        "passed": passed,
        "timedOut": timed_out,
        "durationMs": duration_ms,
        "tests": tests,
        "errors": errors,
        "output": strip_ansi(output),
        "artifacts": {k: v for k, v in artifacts.items() if v},
    }


def run_lighthouse(url, outdir, preset, timeout_s):
    """Run the Lighthouse CLI against url. Returns (scores, html_path, json_path, error)."""
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    base = outdir / "lighthouse"
    chrome_flags = ["--headless=new", "--no-sandbox", *CHROMIUM_ARGS]
    # Lighthouse needs multiple renderer processes for accurate traces.
    chrome_flags = [f for f in chrome_flags if f != "--single-process"]
    cmd = [
        NODE, str(LIGHTHOUSE_CLI), url,
        "--output=json", "--output=html", f"--output-path={base}",
        "--quiet", "--max-wait-for-load=45000",
        f"--chrome-flags={' '.join(chrome_flags)}",
    ]
    if preset == "desktop":
        cmd.append("--preset=desktop")
    env = child_env(CHROME_PATH=chrome_path())
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return None, None, None, f"Lighthouse did not finish within {timeout_s}s"

    html_path, json_path = Path(f"{base}.report.html"), Path(f"{base}.report.json")
    if proc.returncode != 0 or not json_path.exists():
        return None, None, None, "Lighthouse failed:\n" + tail(proc.stderr or proc.stdout, 3000)

    report = json.loads(json_path.read_text(encoding="utf-8"))
    scores = {
        key: (round(cat["score"] * 100) if cat.get("score") is not None else None)
        for key, cat in report.get("categories", {}).items()
    }
    return scores, html_path, json_path, None
