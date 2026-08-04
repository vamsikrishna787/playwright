"""Renders a failed run as evidence the model can act on."""

from __future__ import annotations

from ..config import FAILURE_MAX_CHARS
from ..models import RunRecord
from ..utils import parse_iso
from .storage import runs_store


async def find_run(script_id: str, run_id: str | None = None) -> RunRecord | None:
    """The run to explain to the model: a specific one when the UI names it,
    otherwise the most recent finished run for the script.
    """
    runs = [run for run in await runs_store.read() if run.script_id == script_id]
    if run_id:
        return next((run for run in runs if run.id == run_id), None)

    finished = [run for run in runs if run.status not in ("queued", "running")]
    if not finished:
        return None
    return max(finished, key=lambda run: parse_iso(run.started_at))


def _trim(text: str, maximum: int) -> str:
    clean = text.replace("\r\n", "\n").strip()
    return f"{clean[:maximum]}\n... [truncated]" if len(clean) > maximum else clean


def format_failure(run: RunRecord) -> str | None:
    """Renders a failed run as the evidence the model needs to fix the file: which
    test broke, the error Playwright reported, and how far the steps got before
    it stopped. The step trace matters as much as the message — an error on step
    one is a bad locator, the same error on step four is usually a missing wait
    or a page that never appeared.

    Returns None for a run that passed; there is nothing to fix.
    """
    if run.status not in ("failed", "error"):
        return None

    lines = [
        f"Result: {run.status.upper()}" + (f" at {run.finished_at}" if run.finished_at else "")
    ]

    # An 'error' run never produced a report — the file failed to compile or
    # Playwright itself refused to start, so run.error is all there is.
    if not run.tests:
        lines += ["", "The test file did not run at all. Playwright reported:", run.error or "no output"]
        return _trim("\n".join(lines), FAILURE_MAX_CHARS)

    for test in run.tests:
        lines += ["", f"{'PASSED' if test.status == 'passed' else 'FAILED'}: {test.title}"]
        if test.status == "passed":
            continue

        if test.error:
            lines += ["Error:", test.error]

        if test.steps:
            lines.append("Steps, in order — the last one reached is where it stopped:")
            for step in test.steps:
                lines.append(f"  {'x' if step.error else 'v'} {step.title} ({step.duration_ms}ms)")
                if step.error:
                    lines.append(f"      {step.error.splitlines()[0]}")

    return _trim("\n".join(lines), FAILURE_MAX_CHARS)
