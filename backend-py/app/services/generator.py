"""Turn what we know about a site into a saved, hardened Playwright spec.

Two ways in, one way out:

* ``generate_from_recording`` — a human walked the flow, so we have their exact
  actions and an inventory of every page they touched.
* ``generate_from_prompt``   — free text plus the domain's locator library, for
  a scenario on pages that have already been recorded at least once.

Both end in ``_save``, so a script is the same kind of thing however it was
made, and both feed the domain library so the next generation knows more than
this one did.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from typing import Any

from ..config import SCRIPTS_DIR, snapshot_file_path, spec_file_path, to_relative
from ..models import DomainRecord, ScriptRecord
from ..utils import now_iso
from .actions import RecordedAction, format_actions
from .bedrock import generate_spec, suggest_name
from .domains import canonical_page_url
from .exemplars import find_exemplars
from .explorer import PageReport, explore_page, format_journey, format_report
from .locators import Choice, format_library, merge_capture, read_library
from .storage import scripts_store

FENCE_RE = re.compile(r"```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```")

OPTION_LOCATOR_RE = re.compile(
    r"""(getByRole\(\s*['"]option['"][^)]*\))(?!\s*\.(?:first|last|nth)\b)"""
)

PLAYWRIGHT_IMPORT_RE = re.compile(r"(import .*from '@playwright/test';\n)")

#: A real axe scan, as opposed to a lone import of the builder.
AXE_USE_RE = re.compile(r"new\s+AxeBuilder\s*\(")

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

    # Place it inside the describe block if there is one, otherwise at the end.
    last_brace = with_import.rfind("});")
    if re.search(r"test\.describe\s*\(", with_import) and last_brace != -1:
        return with_import[:last_brace] + A11Y_TEST + with_import[last_brace:]
    return f"{with_import}\n{A11Y_TEST}"


async def generate_from_recording(
    *,
    domain: DomainRecord,
    url: str,
    prompt: str,
    journey: list[PageReport],
    actions: list[RecordedAction],
    name: str | None = None,
    resolutions: dict[tuple[str, str], Choice] | None = None,
) -> dict[str, Any]:
    """Generates from a recorded journey, folding it into the domain library first.

    Order matters: the library is updated before the prompt is built, so the
    user's answers on the review screen are what the model is told about.
    """
    library = await merge_capture(domain.id, journey, resolutions)

    snapshot = format_journey(journey)
    # The recorded action sequence goes last so it is the freshest thing in the
    # context window, and is what the model reproduces step for step.
    if trace := format_actions(actions):
        snapshot = f"{snapshot}\n\n{trace}"

    recorded_urls = [page.url for page in journey]

    return await _save(
        domain=domain,
        url=url,
        prompt=prompt,
        name=name,
        snapshot=snapshot,
        # The recorded pages are already described above in far more detail;
        # the library's job here is to cover the pages this session did not see.
        library_text=format_library(library, skip_urls=recorded_urls),
        page_urls=[canonical_page_url(page_url) for page_url in recorded_urls],
        origin="record",
    )


async def generate_from_prompt(
    *,
    domain: DomainRecord,
    url: str,
    prompt: str,
    name: str | None = None,
) -> dict[str, Any]:
    """Generates from free text and whatever the domain library already knows.

    If the requested page has never been recorded, it is crawled once so the
    model still writes against observed elements rather than invented ones —
    the library grows from that crawl too.
    """
    library = await read_library(domain.id)
    target = canonical_page_url(url)
    known = any(page.url == target and page.locators for page in library.pages)

    snapshot: str | None = None
    if not known:
        report = await asyncio.to_thread(explore_page, url, prompt)
        if not report.elements and not library.pages:
            raise GenerationError(
                f"Nothing could be read from {url}. Record the page once so its locators "
                "are captured, then generate from the library."
            )
        library = await merge_capture(domain.id, [report])
        snapshot = format_report(report)

    library_text = format_library(library, skip_urls=[target] if snapshot else [])
    if not snapshot and not library_text:
        raise GenerationError(
            "This site has no recorded locators yet. Record a flow first — "
            "generating from free text needs something real to point at."
        )

    return await _save(
        domain=domain,
        url=url,
        prompt=prompt,
        name=name,
        snapshot=snapshot,
        library_text=library_text,
        page_urls=[target] if snapshot else [page.url for page in library.pages],
        origin="ai",
    )


async def _save(
    *,
    domain: DomainRecord,
    url: str,
    prompt: str,
    name: str | None,
    snapshot: str | None,
    library_text: str,
    page_urls: list[str],
    origin: str,
) -> dict[str, Any]:
    # Never let example lookup sink a generation — with none, the prompt's own
    # structure rules still stand on their own.
    try:
        exemplars = await find_exemplars(url=url)
    except Exception:
        exemplars = []

    raw = await generate_spec(
        url=url,
        prompt=prompt,
        snapshot=snapshot,
        library=library_text,
        exemplars=exemplars,
    )
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
    # Both sections are kept: the enhance chat re-reads this file, and for an
    # AI-only generation the library block is the only page context there is.
    stored_snapshot = "\n\n".join(part for part in (snapshot, library_text) if part)
    await asyncio.to_thread(_write_files, script_id, code, stored_snapshot)

    now = now_iso()
    record = ScriptRecord(
        id=script_id,
        name=resolved_name,
        source_url=url,
        prompt=prompt,
        file_path=to_relative(absolute_path),
        created_at=now,
        updated_at=now,
        domain_id=domain.id,
        origin=origin,  # type: ignore[arg-type]
        page_urls=page_urls,
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
