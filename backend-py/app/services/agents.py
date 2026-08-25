"""The agents themselves: generate a spec, and the four ways to change one.

Each is a prompt plus a validation pass. The validation is the part that matters:
a weaker model will drop the accessibility test, forget a step tag, or answer
with the file wrapped in prose, and all three are cheap to repair here rather
than surfacing as a broken script the user has to debug.
"""

from __future__ import annotations

import re

from ..config import FAILURE_MAX_CHARS
from ..models import (
    AdaRequest,
    CodeReply,
    FixRequest,
    GenerateRequest,
    ImproveRequest,
    RefineRequest,
)
from . import prompts
from .bedrock import ModelError, converse, model_id, split_code_and_reply, strip_fences

#: A real axe scan, as opposed to a lone import of the builder.
AXE_USE_RE = re.compile(r"new\s+AxeBuilder\s*\(")
PLAYWRIGHT_IMPORT_RE = re.compile(r"(import .*from '@playwright/test';\n)")

OPTION_LOCATOR_RE = re.compile(
    r"""(getByRole\(\s*['"]option['"][^)]*\))(?!\s*\.(?:first|last|nth)\b)"""
)

STEP_TAG_RE = re.compile(r"test\.step\(\s*['\"`]\s*\[S(\d+)\]")


class AgentError(Exception):
    """Bad output from a model, phrased for the person who pressed the button."""


def _assert_is_spec(code: str) -> None:
    if "@playwright/test" not in code or not re.search(r"\btest\s*\(", code):
        raise AgentError(
            "The model did not return valid Playwright test code. Try again, or "
            "reword the steps so the intent is clearer."
        )


def _harden_option_locators(code: str) -> str:
    """An autocomplete phrase almost always matches several suggestions, so a bare
    option locator dies on Playwright's strict mode. The prompt asks for .first();
    this guarantees it, since a weaker model often forgets.
    """
    return OPTION_LOCATOR_RE.sub(r"\g<1>.first()", code)


def _ensure_accessibility_test(code: str) -> str:
    """The accessibility test is a product guarantee, not a suggestion, so it is
    appended if the model dropped it rather than failing the whole generation.

    The check is for the instantiation, not the name: a model that writes the
    import and then forgets the test is common, and matching "AxeBuilder"
    anywhere would see its own import and conclude the scan was already there.
    """
    if AXE_USE_RE.search(code):
        return code

    with_import = (
        code
        if "from '@axe-core/playwright'" in code
        else PLAYWRIGHT_IMPORT_RE.sub(
            r"\g<1>import { AxeBuilder } from '@axe-core/playwright';\n", code, count=1
        )
    )

    block = f"\n{prompts.A11Y_BLOCK}\n"

    # Inside the describe block if there is one, otherwise at the end of the file.
    last_brace = with_import.rfind("});")
    if re.search(r"test\.describe\s*\(", with_import) and last_brace != -1:
        return with_import[:last_brace] + block + with_import[last_brace:]
    return f"{with_import}\n{block}"


def missing_step_tags(code: str, expected: int) -> list[int]:
    """Which authored steps the model failed to tag.

    Reported rather than repaired: the tags are how the UI maps a live run back
    to the user's step list, and guessing which generated block was meant to be
    [S4] would put the wrong step in front of them. A warning is honest; a wrong
    mapping is not.
    """
    found = {int(match.group(1)) for match in STEP_TAG_RE.finditer(code)}
    return [index for index in range(1, expected + 1) if index not in found]


def _warn_about_tags(code: str, expected: int) -> str:
    missing = missing_step_tags(code, expected)
    if not missing:
        return ""

    listed = ", ".join(f"S{index}" for index in missing)
    return (
        f" Note: the model did not tag {listed}, so live progress will not light up "
        "for those steps. Re-generating usually fixes it."
    )


# ---------------------------------------------------------------------------
# Generate
# ---------------------------------------------------------------------------


async def generate(request: GenerateRequest) -> CodeReply:
    if not request.steps:
        raise AgentError("There are no steps to generate from.")

    message = prompts.build_generate_message(
        test_name=request.test_name,
        description=request.description,
        url=request.url,
        suite_name=request.suite_name,
        include_ada=request.include_ada,
        steps=request.steps,
        data_fields=request.data_fields,
    )

    text = await converse(system=prompts.GENERATE_SYSTEM, message=message)

    code = strip_fences(text)
    _assert_is_spec(code)
    code = _harden_option_locators(code)
    if request.include_ada:
        code = _ensure_accessibility_test(code)

    reply = f"Generated a spec for {len(request.steps)} step(s)."
    return CodeReply(code=code, reply=reply + _warn_about_tags(code, len(request.steps)), model=model_id())


# ---------------------------------------------------------------------------
# Change an existing spec
# ---------------------------------------------------------------------------


async def _edit(*, system: str, code: str, url: str, instruction: str, failure: str = "",
                history: list[dict] | None = None) -> CodeReply:
    message = prompts.build_edit_message(
        code=code, url=url, instruction=instruction, failure=failure
    )
    text = await converse(system=system, message=message, history=history)

    updated, reply = split_code_and_reply(text, code)
    if updated != code:
        _assert_is_spec(updated)
        updated = _harden_option_locators(updated)

    return CodeReply(code=updated, reply=reply, model=model_id())


async def refine(request: RefineRequest) -> CodeReply:
    if not request.instruction.strip():
        raise AgentError("Describe the change you want.")

    # Prior turns carry only the prose, never old code — the current file is sent
    # fresh in the message, so replaying earlier code would just conflict with it.
    history = [
        {"role": turn.role, "content": [{"text": turn.text}]} for turn in request.history[-8:]
    ]

    return await _edit(
        system=prompts.REFINE_SYSTEM,
        code=request.code,
        url=request.url,
        instruction=f"Requested change: {request.instruction}",
        history=history,
    )


async def improve(request: ImproveRequest) -> CodeReply:
    goal = request.goal.strip().lower() or "stability"
    brief = prompts.IMPROVE_GOALS.get(goal)
    if not brief:
        known = ", ".join(sorted(prompts.IMPROVE_GOALS))
        raise AgentError(f'Unknown improvement goal "{goal}". Known goals: {known}.')

    return await _edit(
        system=prompts.IMPROVE_SYSTEM,
        code=request.code,
        url=request.url,
        instruction=brief,
    )


async def ada(request: AdaRequest) -> CodeReply:
    result = await _edit(
        system=prompts.ADA_SYSTEM,
        code=request.code,
        url=request.url,
        instruction="Strengthen the accessibility coverage of this file as instructed.",
    )
    # The one guarantee of this endpoint: it never returns a file with no scan.
    return CodeReply(
        code=_ensure_accessibility_test(result.code), reply=result.reply, model=result.model
    )


async def fix(request: FixRequest) -> CodeReply:
    if not request.failure.strip():
        raise AgentError("There is no failure to diagnose.")

    return await _edit(
        system=prompts.FIX_SYSTEM,
        code=request.code,
        url=request.url,
        instruction="Fix the failure above.",
        failure=request.failure[:FAILURE_MAX_CHARS],
    )


__all__ = ["AgentError", "ModelError", "ada", "fix", "generate", "improve", "refine"]
