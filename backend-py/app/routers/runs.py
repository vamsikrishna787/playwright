from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterator

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from ..config import BACKEND_ROOT
from ..http import ApiError
from ..models import RunRecord
from ..services.storage import runs_store

router = APIRouter()

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
CHUNK = 64 * 1024


async def _find_run(run_id: str) -> RunRecord:
    run = next((r for r in await runs_store.read() if r.id == run_id), None)
    if not run:
        raise ApiError(404, "Run not found.")
    return run


# Must precede /{run_id}, or FastAPI matches "latest" as a run id.
@router.get("/latest")
async def latest_runs() -> dict[str, Any]:
    runs = await runs_store.read()

    # runs.json is newest-first, so the first hit per script is its latest run.
    latest: dict[str, RunRecord] = {}
    for run in runs:
        latest.setdefault(run.script_id, run)

    return {script_id: run.dump() for script_id, run in latest.items()}


@router.get("/{run_id}")
async def get_run(run_id: str) -> dict[str, Any]:
    run = await _find_run(run_id)
    return run.dump()


@router.get("/{run_id}/video")
async def get_video(run_id: str, request: Request) -> Response:
    run = await _find_run(run_id)
    if not run.video_path:
        raise ApiError(404, "No video for this run.")

    path = BACKEND_ROOT / run.video_path
    if not path.is_file():
        raise ApiError(404, "No video for this run.")

    return _serve_with_ranges(path, request, "video/webm")


@router.get("/{run_id}/lighthouse")
async def get_lighthouse(run_id: str) -> Response:
    """Lighthouse's own HTML report, served as-is for opening in a new tab."""
    run = await _find_run(run_id)
    report = run.lighthouse
    if not report or not report.report_path:
        raise ApiError(404, "No Lighthouse report for this run.")

    path = BACKEND_ROOT / report.report_path
    if not path.is_file():
        raise ApiError(404, "No Lighthouse report for this run.")

    return FileResponse(path, media_type="text/html")


@router.get("/{run_id}/report")
async def get_report(run_id: str) -> Response:
    run = await _find_run(run_id)

    path = BACKEND_ROOT / run.report_path
    if not path.is_file():
        raise ApiError(404, "No report for this run.")

    return FileResponse(path, media_type="application/json")


def _serve_with_ranges(path: Path, request: Request, media_type: str) -> Response:
    """Byte-range aware file response.

    The video player deliberately seeks past the end of the clip to force the
    browser to resolve the duration of a header-less Playwright WebM, so partial
    requests have to be answered properly or the seek bar stays dead.
    """
    size = path.stat().st_size
    match = RANGE_RE.fullmatch(request.headers.get("range", "").strip())

    if not match:
        return FileResponse(
            path, media_type=media_type, headers={"Accept-Ranges": "bytes"}
        )

    raw_start, raw_end = match.group(1), match.group(2)
    if raw_start:
        start = int(raw_start)
        end = int(raw_end) if raw_end else size - 1
    else:
        # A suffix range ("bytes=-500") asks for the final N bytes.
        length = int(raw_end or 0)
        start = max(size - length, 0)
        end = size - 1

    if start >= size or start > end:
        # Seeking beyond EOF: tell the browser how long the file really is.
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"},
        )

    end = min(end, size - 1)

    def stream() -> Iterator[bytes]:
        remaining = end - start + 1
        with path.open("rb") as handle:
            handle.seek(start)
            while remaining > 0:
                chunk = handle.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(
        stream(),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(end - start + 1),
            "Accept-Ranges": "bytes",
        },
    )
