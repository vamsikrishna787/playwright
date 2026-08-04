"""Picks earlier passing specs to show the model as house style."""

from __future__ import annotations

import asyncio
from urllib.parse import urlparse

from ..config import EXEMPLAR_MAX_CHARS, MAX_EXEMPLARS, spec_file_path
from ..models import RunRecord, ScriptRecord
from ..utils import parse_iso
from .storage import runs_store, scripts_store


def _host_of(url: str) -> str:
    try:
        return urlparse(url).netloc
    except ValueError:
        return ""


async def _proven_scripts(exclude_id: str | None = None) -> list[ScriptRecord]:
    """Scripts whose most recent finished run passed.

    A script that has never run, or whose last run failed, is not a pattern worth
    teaching — showing the model a broken file is worse than showing it none.
    """
    scripts, runs = await asyncio.gather(scripts_store.read(), runs_store.read())

    latest: dict[str, RunRecord] = {}
    for run in runs:
        # A run still in flight says nothing about the script yet.
        if run.status in ("queued", "running"):
            continue
        held = latest.get(run.script_id)
        if not held or parse_iso(run.started_at) > parse_iso(held.started_at):
            latest[run.script_id] = run

    return [
        script
        for script in scripts
        if script.id != exclude_id
        and (found := latest.get(script.id)) is not None
        and found.status == "passed"
    ]


async def find_exemplars(*, url: str, exclude_id: str | None = None) -> list[str]:
    """Picks a couple of previously-passing specs to show alongside the generation
    request. Same-site scripts rank first: they exercise the same DOM, so their
    waiting and assertion patterns transfer directly. Newest wins after that,
    which makes the library self-improving — fix a script, run it green, and it
    becomes the example the next generation follows.
    """
    proven = await _proven_scripts(exclude_id)
    if not proven:
        return []

    host = _host_of(url)
    ranked = sorted(
        proven,
        key=lambda script: (_host_of(script.source_url) != host, -parse_iso(script.updated_at)),
    )

    picked: list[str] = []
    for script in ranked:
        if len(picked) >= MAX_EXEMPLARS:
            break
        code = await asyncio.to_thread(_read_spec, script.id)
        # Oversized files are skipped rather than truncated: half a spec teaches a
        # structure that does not close its own braces.
        if not code.strip() or len(code) > EXEMPLAR_MAX_CHARS:
            continue
        picked.append(code.strip())

    return picked


def _read_spec(script_id: str) -> str:
    try:
        return spec_file_path(script_id).read_text(encoding="utf-8")
    except OSError:
        return ""
