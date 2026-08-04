"""Crawl a page, ask Bedrock for a spec, harden it, save it."""

from __future__ import annotations

import asyncio
import re
import uuid
from typing import Any

from ..config import SCRIPTS_DIR, snapshot_file_path, spec_file_path, to_relative
from ..models import ScriptRecord
from ..utils import now_iso
from .actions import RecordedAction, format_actions
from .bedrock import generate_spec, suggest_name
from .exemplars import find_exemplars
from .explorer import PageReport, explore_page, format_journey, format_report
from .storage import scripts_store

FENCE_RE = re.compile(r"```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```")

OPTION_LOCATOR_RE = re.compile(
    r"""(getByRole\(\s*['"]option['"][^)]*\))(?!\s*\.(?:first|last|nth)\b)"""
)

PLAYWRIGHT_IMPORT_RE = re.compile(r"(import .*from '@playwright/test';\n)")

A11Y_TEST = """
test('accessibility: no WCAG 2.1 A/AA violations', async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}`);
  expect(summary).toEqual([]);
});
"""


class GenerationError(Exception):
    pass


def strip_fences(text: str) -> str:
    fenced = FENCE_RE.search(text)
    return (fenced.group(1) if fenced else text).strip()


def assert_looks_like_spec(code: str) -> None:
    if "@playwright/test" not in code or not re.search(r"\btest\s*\(", code):
        raise GenerationError(
            "The model did not return valid Playwright test code. Try rephrasing the scenario."
        )


def harden_option_locators(code: str) -> str:
    """An autocomplete search phrase almost always matches several suggestions, so a
    bare option locator dies on Playwright's strict mode. The prompt asks for
    .first(); this guarantees it, since a weaker model often forgets.
    """
    return OPTION_LOCATOR_RE.sub(r"\g<1>.first()", code)


def ensure_accessibility_test(code: str) -> str:
    """The accessibility test is a product guarantee, not a suggestion, so it is
    appended if the model dropped it rather than failing the whole generation.
    """
    if "AxeBuilder" in code:
        return code

    with_import = (
        code
        if "from '@axe-core/playwright'" in code
        else PLAYWRIGHT_IMPORT_RE.sub(
            r"\g<1>import { AxeBuilder } from '@axe-core/playwright';\n", code, count=1
        )
    )

    # Place it inside the describe block if there is one, otherwise at the end.
    last_brace = with_import.rfind("});")
    if re.search(r"test\.describe\s*\(", with_import) and last_brace != -1:
        return with_import[:last_brace] + A11Y_TEST + with_import[last_brace:]
    return f"{with_import}\n{A11Y_TEST}"


async def generate_and_save_script(
    *,
    url: str,
    prompt: str,
    name: str | None = None,
    journey: list[PageReport] | None = None,
    actions: list[RecordedAction] | None = None,
) -> dict[str, Any]:
    if journey:
        #: Pages captured while a human walked the flow; skips the automatic crawl.
        snapshot = format_journey(journey)
        # The recorded action sequence goes last so it is the freshest thing in
        # the context window, and is what the model reproduces step for step.
        if trace := format_actions(actions or []):
            snapshot = f"{snapshot}\n\n{trace}"
    else:
        # The scenario text steers what the crawler types, so autocompletes
        # surface the suggestions the generated test will actually need.
        report = await asyncio.to_thread(explore_page, url, prompt)
        snapshot = format_report(report)

    # Never let example lookup sink a generation — with none, the prompt's own
    # structure rules still stand on their own.
    try:
        exemplars = await find_exemplars(url=url)
    except Exception:
        exemplars = []

    raw = await generate_spec(url=url, prompt=prompt, snapshot=snapshot, exemplars=exemplars)
    code = ensure_accessibility_test(harden_option_locators(strip_fences(raw)))
    assert_looks_like_spec(code)

    resolved_name = (name or "").strip()
    if not resolved_name:
        try:
            resolved_name = await suggest_name(url=url, prompt=prompt)
        except Exception:
            resolved_name = ""
    if not resolved_name:
        resolved_name = f"Test for {url}"

    script_id = str(uuid.uuid4())
    absolute_path = spec_file_path(script_id)
    await asyncio.to_thread(_write_files, script_id, code, snapshot)

    now = now_iso()
    record = ScriptRecord(
        id=script_id,
        name=resolved_name,
        source_url=url,
        prompt=prompt,
        file_path=to_relative(absolute_path),
        created_at=now,
        updated_at=now,
    )

    await scripts_store.update(lambda scripts: [record, *scripts])
    return {**record.dump(), "code": code}


def _write_files(script_id: str, code: str, snapshot: str) -> None:
    # Created on demand rather than trusting startup: the directory can go missing
    # while the server is up (a cleanup script, a stale volume), and losing a
    # generated spec at the last step — after two model calls — is the worst
    # possible moment to find out.
    SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    spec_file_path(script_id).write_text(code, encoding="utf-8")
    snapshot_file_path(script_id).write_text(snapshot, encoding="utf-8")
