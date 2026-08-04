from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response

from ..http import ApiError, json_body, text_field
from ..services.actions import compress, summarise_actions
from ..services.generator import GenerationError, generate_and_save_script
from ..services.recorder import (
    RecordingSession,
    discard_session,
    get_session,
    start_recording,
    stop_recording,
)

router = APIRouter()


def summarise(session: RecordingSession) -> dict[str, Any]:
    """Page reports are large; the UI only needs a summary per captured page."""
    return {
        "id": session.id,
        "startUrl": session.start_url,
        "status": session.status,
        "error": session.error,
        "startedAt": session.started_at,
        "pages": [
            {
                "url": page.url,
                "title": page.title,
                "elementCount": len(page.elements),
                "axeCount": len(page.axe),
            }
            for page in session.pages
        ],
        # Extra keys the old UI ignores, so a user can see the flow was captured.
        "actionCount": len(compress(session.actions)),
        "actions": summarise_actions(session.actions),
    }


@router.post("", status_code=201)
async def create_recording(request: Request) -> dict[str, Any]:
    body = await json_body(request)
    url = text_field(body, "url")
    if not url:
        raise ApiError(400, "A starting URL is required.")

    try:
        session = await start_recording(url)
    except Exception as err:
        raise ApiError(500, str(err)) from err

    return summarise(session)


@router.get("/{session_id}")
async def read_recording(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    if not session:
        raise ApiError(404, "Recording not found.")
    return summarise(session)


@router.post("/{session_id}/stop")
async def stop(session_id: str) -> dict[str, Any]:
    session = await stop_recording(session_id)
    if not session:
        raise ApiError(404, "Recording not found.")
    return summarise(session)


@router.post("/{session_id}/generate", status_code=201)
async def generate_from_recording(session_id: str, request: Request) -> dict[str, Any]:
    body = await json_body(request)
    session = get_session(session_id)

    if not session:
        raise ApiError(404, "Recording not found.")

    prompt = text_field(body, "prompt")
    if not prompt:
        raise ApiError(400, "Describe what the test should verify.")
    if not session.pages:
        raise ApiError(400, "This recording captured no pages.")

    # Stop first so the browser closes and the page list stops moving.
    await stop_recording(session.id)

    name = body.get("name")
    try:
        script = await generate_and_save_script(
            url=session.start_url,
            prompt=prompt,
            name=name if isinstance(name, str) else None,
            journey=list(session.pages),
            actions=list(session.actions),
        )
    except GenerationError as err:
        raise ApiError(502, str(err)) from err
    except Exception as err:
        raise ApiError(500, str(err)) from err

    discard_session(session.id)
    return script


@router.delete("/{session_id}", status_code=204)
async def delete_recording(session_id: str) -> Response:
    await stop_recording(session_id)
    discard_session(session_id)
    return Response(status_code=204)
