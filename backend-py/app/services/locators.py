"""The per-domain locator library.

Every page the crawler or the recorder inventories is written down here, keyed
by URL, and every element on it keyed by role + accessible name. Two things fall
out of that:

* A new recording on a site we already know starts from more than it captured —
  the pages it did not visit are still described, so a generated test can reach
  them without guessing.
* When the expression for a known element changes, we can *see* that it changed
  and ask, rather than silently adopting whichever version was recorded last.

An entry becomes ``verified`` once a run that used its exact expression passed.
That is the whole point of keeping the library: proven locators are the ones
worth reusing.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Literal

from ..config import LIBRARY_MAX_CHARS, LOCATORS_DIR
from ..models import DomainLibrary, LocatorConflict, LocatorEntry, PageLocators
from ..utils import now_iso
from .domains import canonical_page_url
from .explorer import DiscoveredElement, PageReport
from .storage import JsonDocStore

Choice = Literal["original", "new", "both"]

_store: JsonDocStore[DomainLibrary] = JsonDocStore(DomainLibrary)


def _path(domain_id: str) -> Any:
    return LOCATORS_DIR / f"{domain_id}.json"


def _empty(domain_id: str) -> DomainLibrary:
    return DomainLibrary(domain_id=domain_id, pages=[], updated_at=now_iso())


def _norm(value: str | None) -> str:
    return " ".join((value or "").split()).strip()


def entry_key(el: DiscoveredElement) -> str:
    """Identity that survives a locator expression changing.

    Role plus accessible name is what a human means by "the Login button". The
    expression — which may carry exact: true, .first() or an .nth(3) that only
    holds for one particular render of the page — is what we are tracking
    changes to, so it cannot also be the thing we look the element up by.
    """
    role = (el.role or el.tag or "").lower()
    if name := _norm(el.name).lower():
        return f"{role}|{name}"
    if placeholder := _norm(el.placeholder).lower():
        return f"{role}|placeholder:{placeholder}"
    return f"{role}|expr:{el.locator}"


def entry_label(entry: LocatorEntry) -> str:
    return _norm(entry.name) or _norm(entry.placeholder) or entry.role or entry.key


#: The Playwright locator builders a stored expression may start with.
BUILDER_RE = re.compile(
    r"^(getBy(Role|Text|Label|Placeholder|TestId|AltText|Title)|locator|frameLocator)\s*\("
)


def normalise_expression(raw: str) -> str:
    """Accepts an expression in the form the UI displays it and stores the tail.

    The library renders every locator as ``page.getByRole(...)``, so that is what
    a user copying one back into the edit box will paste. Storing the ``page.``
    would break every consumer, which all prefix it themselves.
    """
    expression = raw.strip().rstrip(";").strip()
    if expression.startswith("page."):
        expression = expression[len("page.") :].strip()
    return expression


def validate_expression(raw: str) -> str:
    """Normalised expression, or ValueError with something a user can act on."""
    expression = normalise_expression(raw)
    if not expression:
        raise ValueError("A locator expression is required.")
    if not BUILDER_RE.match(expression):
        raise ValueError(
            f"{expression!r} does not start with a Playwright locator builder. Use one of "
            "getByRole, getByText, getByLabel, getByPlaceholder, getByTestId, getByAltText, "
            "getByTitle, locator or frameLocator — for example "
            "getByRole('button', { name: 'Login' })."
        )
    if expression.count("(") != expression.count(")"):
        raise ValueError(f"{expression!r} has unbalanced brackets.")
    return expression


async def read_library(domain_id: str) -> DomainLibrary:
    return await _store.read(_path(domain_id), lambda: _empty(domain_id))


async def write_library(domain_id: str, mutate: Any) -> DomainLibrary:
    return await _store.update(_path(domain_id), mutate, lambda: _empty(domain_id))


async def delete_library(domain_id: str) -> None:
    _path(domain_id).unlink(missing_ok=True)


def _find_page(library: DomainLibrary, url: str) -> PageLocators | None:
    return next((page for page in library.pages if page.url == url), None)


def _find_entry(page: PageLocators, key: str) -> LocatorEntry | None:
    return next((entry for entry in page.locators if entry.key == key), None)


def diff(library: DomainLibrary, pages: Iterable[PageReport]) -> list[LocatorConflict]:
    """Elements whose stored expression disagrees with what was just captured.

    Only elements we already knew about can conflict — a brand new one is not a
    change, it is a discovery, and gets merged without asking.
    """
    conflicts: list[LocatorConflict] = []
    # Two captured pages can share one library page once the query string is
    # dropped, and the same element must not be asked about twice.
    seen: set[tuple[str, str]] = set()

    for report in pages:
        stored = _find_page(library, canonical_page_url(report.url))
        if not stored:
            continue

        for el in report.elements:
            key = entry_key(el)
            entry = _find_entry(stored, key)
            if not entry or entry.locator == el.locator:
                continue
            if el.locator in entry.alternates:
                # Already kept as an accepted variant of this element.
                continue
            if (stored.url, key) in seen:
                continue
            seen.add((stored.url, key))

            conflicts.append(
                LocatorConflict(
                    page_url=stored.url,
                    key=key,
                    role=el.role,
                    name=_norm(el.name) or _norm(el.placeholder) or entry_label(entry),
                    existing_locator=entry.locator,
                    new_locator=el.locator,
                    existing_alternates=list(entry.alternates),
                    existing_verified=entry.verified,
                )
            )

    return conflicts


def _merge_entry(entry: LocatorEntry, el: DiscoveredElement, choice: Choice) -> LocatorEntry:
    now = now_iso()
    patch: dict[str, Any] = {
        "last_seen_at": now,
        "role": el.role or entry.role,
        "name": _norm(el.name) or entry.name,
        "tag": el.tag or entry.tag,
        "type": el.type or entry.type,
        "placeholder": el.placeholder or entry.placeholder,
        "options": el.options if el.options else entry.options,
    }

    if entry.locator == el.locator or choice == "original":
        # Keeping the stored expression: the observation still refreshes the
        # metadata above, but a rejected expression is not recorded anywhere —
        # storing it would resurface as a conflict on the very next recording.
        return entry.model_copy(update=patch)

    if choice == "both":
        # The old expression stays usable — this is the "it's a duplicate, keep
        # them both" case, where two real elements answer to the same name.
        alternates = [entry.locator, *(a for a in entry.alternates if a != entry.locator)]
        return entry.model_copy(
            update={
                **patch,
                "locator": el.locator,
                "alternates": [a for a in alternates if a != el.locator],
                # A fresh primary is unproven until something passes with it.
                "verified": False,
                "verified_since": None,
                # Kept: it still records when the old expression last passed.
                "last_verified_at": entry.last_verified_at,
            }
        )

    # Replace.
    return entry.model_copy(
        update={
            **patch,
            "locator": el.locator,
            "alternates": [a for a in entry.alternates if a != el.locator],
            "verified": False,
            "verified_since": None,
        }
    )


def _new_entry(el: DiscoveredElement, key: str) -> LocatorEntry:
    now = now_iso()
    return LocatorEntry(
        key=key,
        locator=el.locator,
        alternates=[],
        role=el.role,
        name=_norm(el.name),
        tag=el.tag,
        type=el.type,
        placeholder=el.placeholder,
        options=el.options,
        verified=False,
        first_seen_at=now,
        last_seen_at=now,
    )


def merge(
    library: DomainLibrary,
    pages: Iterable[PageReport],
    resolutions: dict[tuple[str, str], Choice] | None = None,
) -> DomainLibrary:
    """Folds a fresh capture into the library, honouring the user's choices.

    Anything the user was not asked about defaults to the new observation: the
    page as it is now is the better description of the page as it is now.
    """
    picks = resolutions or {}
    now = now_iso()
    updated_pages = list(library.pages)

    for report in pages:
        url = canonical_page_url(report.url)
        index = next((i for i, page in enumerate(updated_pages) if page.url == url), None)
        page = (
            updated_pages[index]
            if index is not None
            else PageLocators(url=url, title=report.title, locators=[], updated_at=now)
        )

        entries = list(page.locators)
        by_key = {entry.key: position for position, entry in enumerate(entries)}

        for el in report.elements:
            key = entry_key(el)
            position = by_key.get(key)
            if position is None:
                by_key[key] = len(entries)
                entries.append(_new_entry(el, key))
                continue
            entries[position] = _merge_entry(
                entries[position], el, picks.get((url, key), "new")
            )

        merged = page.model_copy(
            update={
                "title": report.title or page.title,
                "headings": report.headings or page.headings,
                "locators": entries,
                "updated_at": now,
            }
        )

        if index is None:
            updated_pages.append(merged)
        else:
            updated_pages[index] = merged

    return library.model_copy(update={"pages": updated_pages, "updated_at": now})


async def merge_capture(
    domain_id: str,
    pages: Iterable[PageReport],
    resolutions: dict[tuple[str, str], Choice] | None = None,
) -> DomainLibrary:
    captured = list(pages)
    return await write_library(domain_id, lambda lib: merge(lib, captured, resolutions))


def parse_resolutions(raw: Any) -> dict[tuple[str, str], Choice]:
    """Reads the [{pageUrl, key, choice}] list the review screen posts back."""
    picks: dict[tuple[str, str], Choice] = {}
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        page_url = item.get("pageUrl")
        key = item.get("key")
        choice = item.get("choice")
        if isinstance(page_url, str) and isinstance(key, str) and choice in ("original", "new", "both"):
            picks[(canonical_page_url(page_url), key)] = choice  # type: ignore[assignment]
    return picks


async def verify_from_code(domain_id: str, code: str) -> None:
    """Marks every library entry the passing spec actually used as verified.

    Membership is decided by looking for the expression in the file, which is
    exact enough to be meaningful: these strings are long and page-specific, and
    the generator is told to copy them verbatim. An expression the test never
    referenced stays unproven, which is the honest answer.
    """
    if not code.strip():
        return

    now = now_iso()

    def mutate(library: DomainLibrary) -> DomainLibrary:
        pages = []
        for page in library.pages:
            entries = []
            for entry in page.locators:
                candidates = [c for c in (entry.locator, *entry.alternates) if c and c in code]
                if not candidates:
                    entries.append(entry)
                    continue

                # Longest wins. Every expression here is a prefix of its own
                # chained forms — getByRole(...) sits inside getByRole(...).first()
                # — so the shorter one always "matches" a file that only used the
                # longer, and picking by length is what tells them apart.
                proven = max(candidates, key=len)
                if proven == entry.locator:
                    entries.append(
                        entry.model_copy(
                            update={
                                "verified": True,
                                # Only the first crossing is recorded; later runs
                                # confirm it, they do not re-date it.
                                "verified_since": entry.verified_since or now,
                                "last_verified_at": now,
                            }
                        )
                    )
                    continue

                # A kept-both alternate is the expression that actually works, so
                # it takes over as the one future tests are told to use.
                others = [a for a in entry.alternates if a != proven]
                entries.append(
                    entry.model_copy(
                        update={
                            "locator": proven,
                            "alternates": [entry.locator, *others],
                            "verified": True,
                            # A different expression is being trusted now, so the
                            # clock starts again rather than inheriting the old one's.
                            "verified_since": now,
                            "last_verified_at": now,
                        }
                    )
                )
            pages.append(page.model_copy(update={"locators": entries}))
        return library.model_copy(update={"pages": pages})

    await write_library(domain_id, mutate)


def summarise(library: DomainLibrary) -> dict[str, int]:
    entries = [entry for page in library.pages for entry in page.locators]
    return {
        "pageCount": len(library.pages),
        "locatorCount": len(entries),
        "verifiedCount": sum(1 for entry in entries if entry.verified),
    }


def format_library(
    library: DomainLibrary,
    *,
    skip_urls: Iterable[str] = (),
    max_chars: int = LIBRARY_MAX_CHARS,
) -> str:
    """Renders the library for the model.

    Verified entries lead each page block. They have survived a real run, so
    when the model has to choose, that is the one to choose.
    """
    skip = {canonical_page_url(url) for url in skip_urls}
    pages = [page for page in library.pages if page.url not in skip and page.locators]
    if not pages:
        return ""

    lines = [
        "DOMAIN LOCATOR LIBRARY — elements recorded on this site by earlier sessions.",
        "[verified] means a test using that exact expression has PASSED against the live",
        "page, so prefer it over anything else. Entries without the mark were observed but",
        "never proven. Copy any expression you use character for character, and never use a",
        "locator from a page your test has not navigated to yet.",
    ]

    # Newest pages first: the ones under active development are the ones being
    # tested now, and they are what a truncated library should keep.
    for page in sorted(pages, key=lambda p: p.updated_at, reverse=True):
        lines.append("")
        lines.append(f"--- PAGE {page.url}" + (f" ({page.title})" if page.title else ""))
        for entry in sorted(page.locators, key=lambda e: (not e.verified, e.key)):
            bits = [
                f"- page.{entry.locator}",
                "[verified]" if entry.verified else "",
                f"role={entry.role}" if entry.role else "",
                f"type={entry.type}" if entry.type and entry.type != "text" else "",
                f"options=[{', '.join(entry.options[:6])}]" if entry.options else "",
            ]
            lines.append("  ".join(bit for bit in bits if bit))
            if entry.alternates:
                lines.append(
                    f"    (the same element is also reachable as: "
                    f"{', '.join('page.' + a for a in entry.alternates[:3])})"
                )

    text = "\n".join(lines)
    return f"{text[:max_chars]}\n... [truncated]" if len(text) > max_chars else text


def page_urls(library: DomainLibrary) -> list[str]:
    return [page.url for page in library.pages]
