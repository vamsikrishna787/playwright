"""The agent tier.

Prompts and a model client, nothing else. It holds no state, touches no disk and
drives no browser — the Node API at :4000 owns all of that and calls in here for
the parts that need a model.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import MAX_BODY_BYTES, PORT
from .http import install_error_handlers
from .routers import agents
from .services.bedrock import model_id

app = FastAPI(title="Playwright Agent API", version="2.0.0")

# Called by the Node API rather than a browser, but left open so the agent tier
# can be poked directly with curl or the /docs page while developing.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):  # type: ignore[no-untyped-def]
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse({"error": "Request body too large."}, status_code=413)
    return await call_next(request)


install_error_handlers(app)


@app.get("/health")
async def health() -> dict[str, object]:
    return {"ok": True, "model": model_id()}


app.include_router(agents.router, prefix="/agents", tags=["agents"])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=PORT, reload=True)
