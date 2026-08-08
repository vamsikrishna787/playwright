"""Lighthouse audit for the page a test exercises.

Runs *after* the Playwright run has already been graded, never as part of it. An
audit takes roughly half a minute, and the pass/fail of a test must not wait on
a performance measurement to be reported.

One audit at a time, globally. Lighthouse measures how fast a page loads on the
machine it runs on, so two audits racing each other — or racing a Playwright run
— would each report the other's CPU contention as the page being slow.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from ..config import LIGHTHOUSE_ENABLED, LIGHTHOUSE_TIMEOUT, to_relative
from ..models import LighthouseReport
from ..utils import now_iso
from .node_cli import node_executable, optional_package_file

_CREATION_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0

_slot = asyncio.Semaphore(1)

#: Lighthouse category id -> the camelCase key the wire format uses.
CATEGORIES = {
    "performance": "performance",
    "accessibility": "accessibility",
    "best-practices": "bestPractices",
    "seo": "seo",
}

#: The metrics worth putting in front of someone who is not reading the full
#: report. Lighthouse's own ids, mapped to the keys the UI renders.
METRICS = {
    "first-contentful-paint": "firstContentfulPaint",
    "largest-contentful-paint": "largestContentfulPaint",
    "total-blocking-time": "totalBlockingTime",
    "cumulative-layout-shift": "cumulativeLayoutShift",
    "speed-index": "speedIndex",
}


def _chrome_path() -> str | None:
    """Playwright's Chromium, so Lighthouse needs no browser of its own.

    Imported lazily: resolving it starts Playwright's driver, which is not worth
    doing at module import when auditing may be switched off.
    """
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            return playwright.chromium.executable_path
    except Exception:
        return None


def _cli() -> Path | None:
    return optional_package_file("lighthouse", "cli", "index.js")


def is_available() -> bool:
    return LIGHTHOUSE_ENABLED and _cli() is not None


def _score(raw: Any) -> int | None:
    """Lighthouse scores are 0–1 floats, or null for a category it could not grade."""
    return round(raw * 100) if isinstance(raw, (int, float)) else None


def _parse(payload: dict[str, Any]) -> dict[str, Any]:
    categories = payload.get("categories") or {}
    audits = payload.get("audits") or {}

    return {
        "scores": {
            name: _score((categories.get(category) or {}).get("score"))
            for category, name in CATEGORIES.items()
        },
        "metrics": {
            name: (audits.get(audit_id) or {}).get("displayValue") or ""
            for audit_id, name in METRICS.items()
        },
        "final_url": payload.get("finalDisplayedUrl") or payload.get("finalUrl") or "",
        "version": payload.get("lighthouseVersion") or "",
    }


def _audit_sync(url: str, directory: Path) -> LighthouseReport:
    cli = _cli()
    if not cli:
        return LighthouseReport(
            status="error",
            url=url,
            error="Lighthouse is not installed. Run: npm install -D lighthouse",
            finished_at=now_iso(),
        )

    chrome = _chrome_path()
    # Lighthouse writes <path>.report.json and <path>.report.html from one base.
    base = directory / "lighthouse"

    argv = [
        node_executable(),
        str(cli),
        url,
        "--output=json",
        "--output=html",
        f"--output-path={base}",
        f"--only-categories={','.join(CATEGORIES)}",  # dict iterates its ids
        # A new headless Chrome, isolated from any profile on the machine, so an
        # extension or a warm cache cannot colour the numbers.
        "--chrome-flags=--headless=new --no-sandbox --disable-gpu",
        "--quiet",
    ]

    env = {**os.environ}
    if chrome:
        env["CHROME_PATH"] = chrome

    try:
        completed = subprocess.run(
            argv,
            cwd=str(directory),
            env=env,
            capture_output=True,
            text=True,
            timeout=LIGHTHOUSE_TIMEOUT,
            creationflags=_CREATION_FLAGS,
        )
    except subprocess.TimeoutExpired:
        return LighthouseReport(
            status="error",
            url=url,
            error=f"Lighthouse did not finish within {LIGHTHOUSE_TIMEOUT}s.",
            finished_at=now_iso(),
        )
    except OSError as err:
        return LighthouseReport(status="error", url=url, error=str(err), finished_at=now_iso())

    json_path = base.with_suffix(".report.json")
    html_path = base.with_suffix(".report.html")

    try:
        payload = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # No parseable report: the CLI's own stderr is the only useful diagnosis.
        tail = (completed.stderr or completed.stdout or "").strip()[-1500:]
        return LighthouseReport(
            status="error",
            url=url,
            error=tail or f"Lighthouse exited with code {completed.returncode}.",
            finished_at=now_iso(),
        )

    parsed = _parse(payload)
    if runtime_error := (payload.get("runtimeError") or {}).get("message"):
        return LighthouseReport(
            status="error", url=url, error=runtime_error, finished_at=now_iso()
        )

    return LighthouseReport(
        status="done",
        url=parsed["final_url"] or url,
        scores=parsed["scores"],
        metrics=parsed["metrics"],
        report_path=to_relative(html_path) if html_path.is_file() else None,
        json_path=to_relative(json_path),
        version=parsed["version"],
        finished_at=now_iso(),
    )


async def audit(url: str, directory: Path) -> LighthouseReport:
    """Queues an audit and returns its result. Blocking work stays off the loop."""
    async with _slot:
        return await asyncio.to_thread(_audit_sync, url, directory)
