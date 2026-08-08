"""Executes a generated spec and turns Playwright's JSON report into a RunRecord.

The specs are TypeScript, so they are handed to the real Playwright Node CLI.
Everything blocking (the child process, file reads) happens on a worker thread.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from ..config import (
    BACKEND_ROOT,
    RUNNER_CONFIG_PATH,
    SCRIPTS_DIR,
    run_dir,
    spec_file_name,
    spec_file_path,
    to_relative,
)
from ..models import LighthouseReport, RunRecord, RunStep, RunTest
from ..utils import now_iso
from . import lighthouse
from .locators import verify_from_code
from .node_cli import node_executable, resolve_cli
from .storage import patch_run, runs_store, scripts_store

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

# No console window flashes up on Windows, matching the old windowsHide.
_CREATION_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0

# Each run is its own Chromium process, so "Run all" over a large suite would
# thrash the machine. Runs beyond this limit sit in `queued` until a slot frees.
MAX_CONCURRENT_RUNS = 3
_slots = asyncio.Semaphore(MAX_CONCURRENT_RUNS)

#: Fire-and-forget run tasks, held so the loop cannot garbage-collect them.
_scheduled: set[asyncio.Task[None]] = set()


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def flatten_steps(steps: Iterable[dict[str, Any]] | None) -> list[RunStep]:
    if not steps:
        return []

    named = [
        step
        for step in steps
        if step.get("title") and not str(step["title"]).startswith("Before Hooks")
    ]
    return [
        RunStep(
            title=step["title"],
            duration_ms=int(step.get("duration") or 0),
            error=strip_ansi(message) if (message := (step.get("error") or {}).get("message")) else None,
        )
        for step in named
    ]


def collect_results(report: Any) -> list[tuple[str, dict[str, Any]]]:
    """Collects every spec in the report, not just the first.

    A generated file holds a functional test plus an accessibility test, and both
    must be reported.
    """
    suites = (report or {}).get("suites")
    if not isinstance(suites, list):
        return []

    found: list[tuple[str, dict[str, Any]]] = []

    def walk(suite: dict[str, Any]) -> None:
        for spec in suite.get("specs") or []:
            tests = spec.get("tests") or []
            results = (tests[0].get("results") or []) if tests else []
            if results:
                found.append((spec.get("title") or "test", results[0]))
        for child in suite.get("suites") or []:
            walk(child)

    for suite in suites:
        walk(suite)
    return found


def read_json_safe(file_path: Path) -> Any | None:
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def find_webms(directory: Path) -> list[Path]:
    try:
        return sorted(directory.rglob("*.webm"))
    except OSError:
        return []


@lru_cache(maxsize=1)
def _ffmpeg() -> tuple[str | None, bool]:
    """Locates ffmpeg and reports whether it can concatenate.

    Playwright ships its own ffmpeg, but it is built with --disable-everything and
    carries only the matroska and image2pipe demuxers — no concat. So the binary
    is probed rather than assumed, and a fuller ffmpeg on PATH is preferred.
    """
    roots: list[Path] = []
    if configured := os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
        roots.append(Path(configured))
    home = Path.home()
    roots += [
        home / "AppData" / "Local" / "ms-playwright",
        home / ".cache" / "ms-playwright",
        home / "Library" / "Caches" / "ms-playwright",
    ]

    candidates = [system] if (system := shutil.which("ffmpeg")) else []
    for root in roots:
        if not root.is_dir():
            continue
        for directory in sorted(root.glob("ffmpeg-*"), reverse=True):
            candidates += [str(b) for b in directory.glob("ffmpeg*") if b.is_file()]

    for binary in candidates:
        try:
            listed = subprocess.run(
                [binary, "-hide_banner", "-demuxers"],
                capture_output=True,
                text=True,
                timeout=30,
                creationflags=_CREATION_FLAGS,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        if re.search(r"^\s*D\S*\s+concat\b", listed, re.M):
            return binary, True

    return (candidates[0] if candidates else None), False


def videos_by_test(
    artifacts_dir: Path, results: list[dict[str, Any]]
) -> list[list[Path]]:
    """Video files grouped per test, in report order — which is test order.

    A test emits one video per page it opened, so a two-test run routinely
    produces three files.
    """
    groups: list[list[Path]] = []
    for result in results:
        found = [
            Path(a["path"])
            for a in (result.get("attachments") or [])
            if a.get("name") == "video" and a.get("path")
        ]
        groups.append([p for p in found if p.is_file()])

    if any(groups):
        return groups

    # No attachments recorded — fall back to a scan, as one undifferentiated group.
    return [find_webms(artifacts_dir)]


def _concat(ffmpeg: str, sources: list[Path], target: Path) -> bool:
    """Losslessly joins same-codec WebMs with ffmpeg's concat demuxer."""
    listing = target.parent / "sources.txt"
    listing.write_text(
        "".join(f"file '{p.resolve().as_posix()}'\n" for p in sources), encoding="utf-8"
    )
    try:
        completed = subprocess.run(
            [ffmpeg, "-y", "-nostdin", "-f", "concat", "-safe", "0",
             "-i", str(listing), "-c", "copy", str(target)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_CREATION_FLAGS,
            timeout=180,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        listing.unlink(missing_ok=True)

    return completed.returncode == 0 and target.is_file() and target.stat().st_size > 0


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return -1


def claim_video(
    artifacts_dir: Path, run_directory: Path, results: list[dict[str, Any]]
) -> Path | None:
    """Chooses the recording the viewer should see.

    Preference order:

    1. Every video joined in recorded order, so the player shows the whole run.
       Only possible with a concat-capable ffmpeg, which Playwright's bundled
       build is not — install a full ffmpeg and this switches on by itself.
    2. Otherwise the FIRST test's recording. The generator always emits the
       functional test before the accessibility test, so this is the test the
       user actually wrote. Picking the largest file instead — the previous
       behaviour — routinely surfaced the a11y scan, because a page-load scan
       compresses larger than a short scripted interaction.
    """
    groups = videos_by_test(artifacts_dir, results)
    flat = [path for group in groups for path in group]
    if not flat:
        return None

    target = run_directory / "video.webm"

    ffmpeg, can_concat = _ffmpeg()
    if len(flat) > 1 and ffmpeg and can_concat and _concat(ffmpeg, flat, target):
        return target

    first_test = next((group for group in groups if group), [])
    chosen = max(first_test or flat, key=_size)

    if chosen.resolve() == target.resolve():
        return target
    try:
        os.replace(chosen, target)
        return target
    except OSError:
        return chosen


async def start_run(script_id: str) -> RunRecord:
    run_id = str(uuid.uuid4())
    directory = run_dir(script_id, run_id)
    directory.mkdir(parents=True, exist_ok=True)

    record = RunRecord(
        id=run_id,
        script_id=script_id,
        status="queued",
        started_at=now_iso(),
        finished_at=None,
        duration_ms=None,
        video_path=None,
        report_path=to_relative(directory / "report.json"),
        tests=[],
        steps=[],
        error=None,
        # Advertised up front so the UI can show the audit as pending rather
        # than having a panel appear from nowhere a minute later.
        lighthouse=LighthouseReport(status="queued") if lighthouse.is_available() else None,
    )

    await runs_store.update(lambda runs: [record, *runs])

    task = asyncio.create_task(_schedule(script_id, run_id, directory))
    _scheduled.add(task)
    task.add_done_callback(_scheduled.discard)

    return record


async def _schedule(script_id: str, run_id: str, directory: Path) -> None:
    async with _slots:
        await runs_store.update(
            lambda runs: patch_run(runs, run_id, status="running", started_at=now_iso())
        )
        await _execute(script_id, run_id, directory)

    # Outside the slot: the test has its verdict, and an audit should not hold a
    # run slot for another half minute while the next test waits behind it.
    await _lighthouse(script_id, run_id, directory)


async def _lighthouse(script_id: str, run_id: str, directory: Path) -> None:
    """Audits the page the test starts on, and attaches the result to the run."""
    if not lighthouse.is_available():
        return

    script = next((s for s in await scripts_store.read() if s.id == script_id), None)
    url = script.source_url if script else ""
    if not url:
        return

    await runs_store.update(
        lambda runs: patch_run(
            runs, run_id, lighthouse=LighthouseReport(status="running", url=url)
        )
    )

    try:
        report = await lighthouse.audit(url, directory)
    except Exception as err:
        report = LighthouseReport(
            status="error", url=url, error=str(err), finished_at=now_iso()
        )

    await runs_store.update(lambda runs: patch_run(runs, run_id, lighthouse=report))


def _spawn(script_id: str, report_file: Path, artifacts_dir: Path, log_file: Path) -> int:
    argv = [
        node_executable(),
        resolve_cli("@playwright/test"),
        "test",
        spec_file_name(script_id),
        f"--config={RUNNER_CONFIG_PATH}",
        f"--output={artifacts_dir}",
    ]

    env = {
        **os.environ,
        "PLAYWRIGHT_JSON_OUTPUT_FILE": str(report_file),
        "FORCE_COLOR": "0",
        # The TS config reads this instead of importing the app's own config.
        "PW_SCRIPTS_DIR": str(SCRIPTS_DIR),
    }

    # PWDEBUG forces a headed browser and opens the Inspector with timeouts
    # disabled — inherited from a developer's shell it would hang every run behind
    # a window nobody is watching. Runs are always headless; recording is not.
    for inherited in ("PWDEBUG", "PLAYWRIGHT_HEADED"):
        env.pop(inherited, None)

    with open(log_file, "wb") as log:
        completed = subprocess.run(
            argv,
            cwd=str(BACKEND_ROOT),
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=_CREATION_FLAGS,
        )
    return completed.returncode


async def _execute(script_id: str, run_id: str, directory: Path) -> None:
    report_file = directory / "report.json"
    log_file = directory / "stdout.log"
    # Playwright wipes --output at startup, so it gets its own subdirectory and our
    # report/log files stay outside of it.
    artifacts_dir = directory / "artifacts"

    try:
        exit_code = await asyncio.to_thread(
            _spawn, script_id, report_file, artifacts_dir, log_file
        )
        await _finalize(
            script_id, run_id, directory, artifacts_dir, report_file, log_file, exit_code
        )
    except Exception as err:
        # Bound outside the lambda: Python unbinds `err` when the except block ends.
        message = str(err)
        await runs_store.update(
            lambda runs: patch_run(
                runs, run_id, status="error", finished_at=now_iso(), error=message
            )
        )


async def _finalize(
    script_id: str,
    run_id: str,
    directory: Path,
    artifacts_dir: Path,
    report_file: Path,
    log_file: Path,
    exit_code: int,
) -> None:
    report = await asyncio.to_thread(read_json_safe, report_file)
    collected = collect_results(report) if report else []

    if not collected:
        config_error = ""
        if isinstance(report, dict):
            errors = report.get("errors") or []
            config_error = (errors[0] or {}).get("message", "") if errors else ""

        log_text = await asyncio.to_thread(_read_text, log_file)
        tail = strip_ansi(log_text)[-4000:]

        message = (
            strip_ansi(config_error).strip()
            or tail.strip()
            or f"Playwright exited with code {exit_code} and produced no report."
        )
        await runs_store.update(
            lambda runs: patch_run(
                runs, run_id, status="error", finished_at=now_iso(), error=message
            )
        )
        return

    tests = [
        RunTest(
            title=title,
            status="passed" if result.get("status") == "passed" else "failed",
            duration_ms=int(result.get("duration") or 0),
            steps=flatten_steps(result.get("steps")),
            error=strip_ansi(first_error) if (first_error := _first_error(result)) else None,
        )
        for title, result in collected
    ]

    # The run passes only if every test in the file passed.
    status = "passed" if all(test.status == "passed" for test in tests) else "failed"
    first_failure = next((test for test in tests if test.status == "failed"), None)

    # Any test in the file may own the recording, so weigh them all.
    video_path = await asyncio.to_thread(
        claim_video, artifacts_dir, directory, [result for _, result in collected]
    )

    total = sum(test.duration_ms for test in tests)
    duration_ms = total or collected[0][1].get("duration")

    await runs_store.update(
        lambda runs: patch_run(
            runs,
            run_id,
            status=status,
            finished_at=now_iso(),
            duration_ms=duration_ms,
            video_path=to_relative(video_path) if video_path else None,
            tests=tests,
            steps=[step for test in tests for step in test.steps],
            error=first_failure.error if first_failure else None,
        )
    )

    if status == "passed":
        await _promote_locators(script_id)


async def _promote_locators(script_id: str) -> None:
    """A green run is the only real proof a locator works, so it is what marks
    the domain library verified. Every locator the spec actually used is
    promoted; the rest of the library is left as it was.
    """
    script = next((s for s in await scripts_store.read() if s.id == script_id), None)
    if not script or not script.domain_id:
        return

    code = await asyncio.to_thread(_read_text, spec_file_path(script_id))
    try:
        await verify_from_code(script.domain_id, code)
    except Exception:
        # Bookkeeping must never turn a passing run into an errored one.
        pass


def _first_error(result: dict[str, Any]) -> str | None:
    errors = result.get("errors") or []
    return (errors[0] or {}).get("message") if errors else None


def _read_text(file_path: Path) -> str:
    try:
        return file_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
