"""Request/response conventions shared by every route.

The frontend reads `body.error` on any non-2xx, so errors are rendered as
`{"error": "..."}` rather than FastAPI's default `{"detail": ...}`.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ApiError(HTTPException):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(status_code=status_code, detail=message)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(HTTPException)
    async def _http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return JSONResponse({"error": detail}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        return JSONResponse({"error": first.get("msg", "Invalid request body.")}, status_code=400)

    @app.exception_handler(Exception)
    async def _unhandled(_request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse({"error": str(exc) or exc.__class__.__name__}, status_code=500)


async def json_body(request: Request) -> dict[str, Any]:
    """The request body as a dict, or an empty one — never raises.

    Matches `req.body ?? {}`: routes do their own field checks so they can return
    the specific, user-facing message for each missing field.
    """
    try:
        parsed = await request.json()
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def text_field(body: dict[str, Any], key: str) -> str | None:
    """A non-blank string field, or None — the `typeof x === 'string' && x.trim()` test."""
    value = body.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def raw_text_field(body: dict[str, Any], key: str) -> str | None:
    """A string field kept verbatim, for code buffers where whitespace matters."""
    value = body.get(key)
    return value if isinstance(value, str) and value.strip() else None
