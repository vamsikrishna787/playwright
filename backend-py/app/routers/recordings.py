from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response

from ..http import ApiError, json_body, text_field
from ..services import locators as library_service
from ..services.actions import compress, summarise_actions
from ..services.domains import ensure_domain, find_domain
from ..services.generator import GenerationError
from ..services.generator import generate_from_recording as generate_script
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
        "domainId": session.domain_id,
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
        "actionCount": len(compress(session.actions)),
        "actions": summarise_actions(session.actions),
    }


def _require_session(session_id: str) -> RecordingSession:
    session = get_session(session_id)
    if not session:
        raise ApiError(404, "Recording not found.")
    return session


@router.post("", status_code=201)
async def create_recording(request: Request) -> dict[str, Any]:
    body = await json_body(request)
    url = text_field(body, "url")
    if not url:
        raise ApiError(400, "A starting URL is required.")

    # A recording always belongs to a site. Given one explicitly we use it; given
    # only a URL we derive it, which is how a brand new site gets added at all.
    domain_id = text_field(body, "domainId")
    if domain_id:
        if not await find_domain(domain_id):
            raise ApiError(404, "Site not found.")
    else:
        try:
            domain_id = (await ensure_domain(url)).id
        except ValueError as err:
            raise ApiError(400, str(err)) from err

    try:
        session = await start_recording(url, domain_id)
    except Exception as err:
        raise ApiError(500, str(err)) from err

    return summarise(session)


@router.get("/{session_id}")
async def read_recording(session_id: str) -> dict[str, Any]:
    return summarise(_require_session(session_id))


@router.post("/{session_id}/stop")
async def stop(session_id: str) -> dict[str, Any]:
    session = await stop_recording(session_id)
    if not session:
        raise ApiError(404, "Recording not found.")
    return summarise(session)


@router.get("/{session_id}/conflicts")
async def read_conflicts(session_id: str) -> dict[str, Any]:
    """Locators that changed since the last time these pages were recorded.

    Read-only: nothing is written to the library until the user has answered,
    which is what makes the review meaningful rather than a notification.
    """
    session = _require_session(session_id)
    if not session.domain_id:
        return {"conflicts": []}

    library = await library_service.read_library(session.domain_id)
    conflicts = library_service.diff(library, session.pages)
    return {"conflicts": [conflict.dump() for conflict in conflicts]}


@router.post("/{session_id}/generate", status_code=201)
async def generate_from_recording(session_id: str, request: Request) -> dict[str, Any]:
    body = await json_body(request)
    session = _require_session(session_id)

    prompt = text_field(body, "prompt")
    if not prompt:
        raise ApiError(400, "Describe what the test should verify.")
    if not session.pages:
        raise ApiError(400, "This recording captured no pages.")

    domain = await find_domain(session.domain_id) if session.domain_id else None
    if not domain:
        try:
            domain = await ensure_domain(session.start_url)
        except ValueError as err:
            raise ApiError(400, str(err)) from err

    # Stop first so the browser closes and the page list stops moving.
    await stop_recording(session.id)

    name = body.get("name")
    try:
        script = await generate_script(
            domain=domain,
            url=session.start_url,
            prompt=prompt,
            name=name if isinstance(name, str) else None,
            journey=list(session.pages),
            actions=list(session.actions),
            resolutions=library_service.parse_resolutions(body.get("resolutions")),
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
