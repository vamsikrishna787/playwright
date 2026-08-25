"""The agent API.

Every endpoint is the same shape: facts in, a complete test file out. Nothing is
stored — the Node tier decides what to keep.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..http import ApiError
from ..models import (
    AdaRequest,
    AgentAction,
    CatalogReply,
    CodeReply,
    ExtractReply,
    ExtractRequest,
    FixRequest,
    GenerateRequest,
    ImproveRequest,
    RefineRequest,
)
from ..services import agents, steps
from ..services.bedrock import ModelError, model_id

router = APIRouter()

#: Advertised to the UI so a new agent here needs no frontend change to appear.
ACTIONS = [
    AgentAction(
        id="refine",
        label="Refine with an instruction",
        description="Describe a change in plain English and get the updated file back.",
        needs_instruction=True,
    ),
    AgentAction(
        id="improve",
        label="Improve",
        description="A hardening pass for stability, readability, coverage or speed. "
        "Never changes what the test verifies.",
    ),
    AgentAction(
        id="ada",
        label="Deepen accessibility",
        description="Extends the axe scan past the landing page and adds keyboard and "
        "accessible-name checks for the controls the test uses.",
    ),
    AgentAction(
        id="fix",
        label="Fix the last failure",
        description="Reads the real output of the failing run and repairs the cause.",
    ),
]


def _guard(call):  # type: ignore[no-untyped-def]
    """Turns the two expected failure modes into clean 4xx/5xx bodies.

    A bad prompt result is the user's problem to reword (400); a model that will
    not answer at all is the operator's (502). Anything else is a real bug and is
    left to the unhandled handler, stack trace and all.
    """

    async def run(*args, **kwargs):  # type: ignore[no-untyped-def]
        try:
            return await call(*args, **kwargs)
        except agents.AgentError as err:
            raise ApiError(400, str(err)) from err
        except ModelError as err:
            raise ApiError(502, str(err)) from err

    return run


@router.get("/catalog", response_model=CatalogReply)
async def catalog() -> CatalogReply:
    return CatalogReply(actions=ACTIONS, model=model_id())


@router.post("/generate", response_model=CodeReply)
async def generate(request: GenerateRequest) -> CodeReply:
    return await _guard(agents.generate)(request)


@router.post("/refine", response_model=CodeReply)
async def refine(request: RefineRequest) -> CodeReply:
    return await _guard(agents.refine)(request)


@router.post("/improve", response_model=CodeReply)
async def improve(request: ImproveRequest) -> CodeReply:
    return await _guard(agents.improve)(request)


@router.post("/ada", response_model=CodeReply)
async def ada(request: AdaRequest) -> CodeReply:
    return await _guard(agents.ada)(request)


@router.post("/fix", response_model=CodeReply)
async def fix(request: FixRequest) -> CodeReply:
    return await _guard(agents.fix)(request)


@router.post("/steps/extract", response_model=ExtractReply)
async def extract(request: ExtractRequest) -> ExtractReply:
    """Reads the script rather than asking a model: instant, free, and it can
    never describe a test that is not the one on screen."""
    return ExtractReply(steps=steps.extract(request.code))
