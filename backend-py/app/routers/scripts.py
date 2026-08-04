from __future__ import annotations

import asyncio
import shutil
from typing import Any

from fastapi import APIRouter, Request, Response

from ..config import RUNS_DIR, SCRIPTS_DIR, snapshot_file_path, spec_file_path
from ..http import ApiError, json_body, raw_text_field, text_field
from ..models import ScriptRecord
from ..services.bedrock import ChatTurn, edit_spec
from ..services.failure import find_run, format_failure
from ..services.generator import GenerationError, generate_and_save_script
from ..services.runner import start_run
from ..services.storage import runs_store, scripts_store
from ..utils import now_iso

router = APIRouter()


async def _find_script(script_id: str) -> ScriptRecord:
    script = next((s for s in await scripts_store.read() if s.id == script_id), None)
    if not script:
        raise ApiError(404, "Script not found.")
    return script


def _read_text(path: Any) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _write_spec(script_id: str, code: str) -> None:
    # Saving an edit must not fail just because the scripts directory went missing.
    SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    spec_file_path(script_id).write_text(code, encoding="utf-8")


@router.post("/generate", status_code=201)
async def generate(request: Request) -> dict[str, Any]:
    body = await json_body(request)
    url = text_field(body, "url")
    prompt = text_field(body, "prompt")

    if not url:
        raise ApiError(400, "A target URL is required.")
    if not prompt:
        raise ApiError(400, "A test scenario description is required.")

    name = body.get("name")
    try:
        return await generate_and_save_script(
            url=url, prompt=prompt, name=name if isinstance(name, str) else None
        )
    except GenerationError as err:
        raise ApiError(502, str(err)) from err
    except ApiError:
        raise
    except Exception as err:
        raise ApiError(500, str(err)) from err


@router.post("/run-all", status_code=202)
async def run_all() -> list[dict[str, Any]]:
    scripts = await scripts_store.read()
    if not scripts:
        raise ApiError(400, "There are no scripts to run.")

    # Queued in list order; the runner caps how many execute at once.
    runs = [await start_run(script.id) for script in scripts]
    return [run.dump() for run in runs]


@router.get("")
async def list_scripts() -> list[dict[str, Any]]:
    return [script.dump() for script in await scripts_store.read()]


@router.get("/{script_id}")
async def get_script(script_id: str) -> dict[str, Any]:
    script = await _find_script(script_id)
    code = await asyncio.to_thread(_read_text, spec_file_path(script.id))
    return {**script.dump(), "code": code}


@router.put("/{script_id}")
async def update_script(script_id: str, request: Request) -> dict[str, Any] | None:
    body = await json_body(request)
    script = await _find_script(script_id)

    code = body.get("code")
    if isinstance(code, str):
        await asyncio.to_thread(_write_spec, script.id, code)

    name = text_field(body, "name")

    def mutate(scripts: list[ScriptRecord]) -> list[ScriptRecord]:
        return [
            s.model_copy(update={"name": name or s.name, "updated_at": now_iso()})
            if s.id == script.id
            else s
            for s in scripts
        ]

    updated = await scripts_store.update(mutate)
    found = next((s for s in updated if s.id == script.id), None)
    return found.dump() if found else None


@router.post("/{script_id}/enhance")
async def enhance(script_id: str, request: Request) -> dict[str, Any]:
    body = await json_body(request)
    instruction = text_field(body, "instruction")
    if not instruction:
        raise ApiError(400, "Describe the change you want.")

    script = await _find_script(script_id)

    # Prefer the editor's current buffer over what's on disk — the user may have
    # unsaved edits they expect the assistant to build on.
    current = raw_text_field(body, "code") or await asyncio.to_thread(
        _read_text, spec_file_path(script.id)
    )

    snapshot = await asyncio.to_thread(_read_text, snapshot_file_path(script.id))

    # Attached unprompted: when the last run is red, "fix the login step" should
    # reach the model already carrying the reason it went red. A specific runId
    # from the UI wins, so a user can point at an older failure.
    run_id = body.get("runId")
    run = await find_run(script.id, run_id if isinstance(run_id, str) else None)
    failure = format_failure(run) if run else None

    raw_history = body.get("history")
    history: list[ChatTurn] = [
        turn
        for turn in (raw_history if isinstance(raw_history, list) else [])
        if isinstance(turn, dict)
        and turn.get("role") in ("user", "assistant")
        and isinstance(turn.get("text"), str)
    ][-8:]

    try:
        result = await edit_spec(
            code=current,
            instruction=instruction,
            source_url=script.source_url,
            snapshot=snapshot or None,
            failure=failure,
            history=history,
        )
    except Exception as err:
        raise ApiError(502, str(err)) from err

    return {**result, "usedFailure": bool(failure)}


@router.delete("/{script_id}", status_code=204)
async def delete_script(script_id: str) -> Response:
    await _find_script(script_id)

    await asyncio.to_thread(_purge_files, script_id)
    await scripts_store.update(lambda scripts: [s for s in scripts if s.id != script_id])
    await runs_store.update(lambda runs: [r for r in runs if r.script_id != script_id])

    return Response(status_code=204)


def _purge_files(script_id: str) -> None:
    spec_file_path(script_id).unlink(missing_ok=True)
    snapshot_file_path(script_id).unlink(missing_ok=True)
    shutil.rmtree(RUNS_DIR / script_id, ignore_errors=True)


@router.get("/{script_id}/runs")
async def list_runs(script_id: str) -> list[dict[str, Any]]:
    return [run.dump() for run in await runs_store.read() if run.script_id == script_id]


@router.post("/{script_id}/runs", status_code=202)
async def create_run(script_id: str) -> dict[str, Any]:
    script = await _find_script(script_id)
    run = await start_run(script.id)
    return run.dump()
