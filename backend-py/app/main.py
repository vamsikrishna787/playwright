from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import MAX_BODY_BYTES, PORT, ensure_dirs
from .http import install_error_handlers
from .routers import recordings, runs, scripts


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    ensure_dirs()
    yield


app = FastAPI(title="Playwright Test Generator API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Matches the old express.json({ limit: '2mb' })."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse({"error": "Request body too large."}, status_code=413)
    return await call_next(request)


install_error_handlers(app)


@app.get("/api/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


app.include_router(scripts.router, prefix="/api/scripts", tags=["scripts"])
app.include_router(runs.router, prefix="/api/runs", tags=["runs"])
app.include_router(recordings.router, prefix="/api/recordings", tags=["recordings"])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=PORT, reload=True)
