from __future__ import annotations

import asyncio
import shutil
from typing import Any

from fastapi import APIRouter, Request, Response

from ..config import RUNS_DIR, snapshot_file_path, spec_file_path
from ..http import ApiError, json_body, text_field
from ..models import DomainLibrary, DomainRecord, PageLocators
from ..services import locators as library_service
from ..services.domains import canonical_page_url, ensure_domain, find_domain
from ..services.generator import GenerationError, generate_from_prompt
from ..services.storage import domains_store, runs_store, scripts_store
from ..utils import now_iso

router = APIRouter()


async def _require_domain(domain_id: str) -> DomainRecord:
    domain = await find_domain(domain_id)
    if not domain:
        raise ApiError(404, "Site not found.")
    return domain


@router.get("")
async def list_domains() -> list[dict[str, Any]]:
    """Every site, with the counts the scripts page shows in each group header."""
    domains, scripts = await asyncio.gather(domains_store.read(), scripts_store.read())

    counts: dict[str, int] = {}
    for script in scripts:
        counts[script.domain_id] = counts.get(script.domain_id, 0) + 1

    libraries = await asyncio.gather(
        *(library_service.read_library(domain.id) for domain in domains)
    )

    return [
        {
            **domain.dump(),
            "scriptCount": counts.get(domain.id, 0),
            **library_service.summarise(library),
        }
        for domain, library in zip(domains, libraries)
    ]


@router.post("", status_code=201)
async def create_domain(request: Request) -> dict[str, Any]:
    """Adds a site by URL. An existing host is returned rather than duplicated."""
    body = await json_body(request)
    url = text_field(body, "url")
    if not url:
        raise ApiError(400, "A site URL is required.")

    try:
        domain = await ensure_domain(url)
    except ValueError as err:
        raise ApiError(400, str(err)) from err

    name = text_field(body, "name")
    if name and name != domain.name:
        domain = await _rename(domain.id, name)

    return domain.dump()


async def _rename(domain_id: str, name: str) -> DomainRecord:
    def mutate(domains: list[DomainRecord]) -> list[DomainRecord]:
        return [
            d.model_copy(update={"name": name, "updated_at": now_iso()}) if d.id == domain_id else d
            for d in domains
        ]

    saved = await domains_store.update(mutate)
    return next(d for d in saved if d.id == domain_id)


@router.get("/{domain_id}")
async def get_domain(domain_id: str) -> dict[str, Any]:
    domain = await _require_domain(domain_id)
    library = await library_service.read_library(domain_id)
    scripts = [s for s in await scripts_store.read() if s.domain_id == domain_id]

    return {
        **domain.dump(),
        **library_service.summarise(library),
        "scriptCount": len(scripts),
        "pages": [
            {"url": page.url, "title": page.title, "locatorCount": len(page.locators)}
            for page in library.pages
        ],
    }


@router.patch("/{domain_id}")
async def update_domain(domain_id: str, request: Request) -> dict[str, Any]:
    await _require_domain(domain_id)
    name = text_field(await json_body(request), "name")
    if not name:
        raise ApiError(400, "A name is required.")
    return (await _rename(domain_id, name)).dump()


@router.delete("/{domain_id}", status_code=204)
async def delete_domain(domain_id: str) -> Response:
    """Removes the site, every script under it, their runs, and the library."""
    await _require_domain(domain_id)

    doomed = [s.id for s in await scripts_store.read() if s.domain_id == domain_id]
    await asyncio.to_thread(_purge_scripts, doomed)

    await scripts_store.update(lambda scripts: [s for s in scripts if s.domain_id != domain_id])
    await runs_store.update(lambda runs: [r for r in runs if r.script_id not in set(doomed)])
    await library_service.delete_library(domain_id)
    await domains_store.update(lambda domains: [d for d in domains if d.id != domain_id])

    return Response(status_code=204)


def _purge_scripts(script_ids: list[str]) -> None:
    for script_id in script_ids:
        spec_file_path(script_id).unlink(missing_ok=True)
        snapshot_file_path(script_id).unlink(missing_ok=True)
        shutil.rmtree(RUNS_DIR / script_id, ignore_errors=True)


@router.get("/{domain_id}/scripts")
async def list_domain_scripts(domain_id: str) -> list[dict[str, Any]]:
    await _require_domain(domain_id)
    return [s.dump() for s in await scripts_store.read() if s.domain_id == domain_id]


@router.get("/{domain_id}/locators")
async def get_locators(domain_id: str) -> dict[str, Any]:
    domain = await _require_domain(domain_id)
    library = await library_service.read_library(domain_id)
    return {"domain": domain.dump(), **library.dump(), **library_service.summarise(library)}


@router.post("/{domain_id}/locators/delete")
async def delete_locators(domain_id: str, request: Request) -> dict[str, Any]:
    """Drops one entry, or a whole page, from the library.

    A URL is the key here, so it travels in the body — a path segment would need
    escaping at both ends and a query string is no better.
    """
    await _require_domain(domain_id)
    body = await json_body(request)

    page_url = text_field(body, "pageUrl")
    if not page_url:
        raise ApiError(400, "A page URL is required.")
    target = canonical_page_url(page_url)
    key = text_field(body, "key")

    def mutate(library: DomainLibrary) -> DomainLibrary:
        if not key:
            return library.model_copy(
                update={
                    "pages": [p for p in library.pages if p.url != target],
                    "updated_at": now_iso(),
                }
            )

        pages: list[PageLocators] = []
        for page in library.pages:
            if page.url != target:
                pages.append(page)
                continue
            kept = [entry for entry in page.locators if entry.key != key]
            pages.append(page.model_copy(update={"locators": kept, "updated_at": now_iso()}))
        return library.model_copy(update={"pages": pages, "updated_at": now_iso()})

    library = await library_service.write_library(domain_id, mutate)
    return {**library.dump(), **library_service.summarise(library)}


@router.post("/{domain_id}/locators/update")
async def update_locator(domain_id: str, request: Request) -> dict[str, Any]:
    """Hand-edits one library entry: its expression, its label, its alternates.

    Recording and the review screen cover the cases the app can see for itself.
    This is for the ones it cannot — a locator that is right but ugly, an element
    whose real name never made it into the accessibility tree, an expression a
    human simply knows better than the crawler did.
    """
    await _require_domain(domain_id)
    body = await json_body(request)

    page_url = text_field(body, "pageUrl")
    key = text_field(body, "key")
    if not (page_url and key):
        raise ApiError(400, "pageUrl and key are required.")
    target = canonical_page_url(page_url)

    try:
        locator = (
            library_service.validate_expression(body["locator"])
            if isinstance(body.get("locator"), str)
            else None
        )
        alternates = (
            [library_service.validate_expression(a) for a in body["alternates"] if str(a).strip()]
            if isinstance(body.get("alternates"), list)
            else None
        )
    except ValueError as err:
        raise ApiError(400, str(err)) from err

    name = body.get("name")
    name = name.strip() if isinstance(name, str) else None

    if locator is None and alternates is None and name is None:
        raise ApiError(400, "Nothing to change.")

    found = False

    def mutate(library: DomainLibrary) -> DomainLibrary:
        nonlocal found
        pages: list[PageLocators] = []
        for page in library.pages:
            if page.url != target:
                pages.append(page)
                continue

            entries = []
            for entry in page.locators:
                if entry.key != key:
                    entries.append(entry)
                    continue

                found = True
                primary = locator if locator is not None else entry.locator
                kept = alternates if alternates is not None else entry.alternates
                patch: dict[str, Any] = {
                    "locator": primary,
                    # An alternate identical to the primary is not an alternative.
                    "alternates": list(dict.fromkeys(a for a in kept if a != primary)),
                    "last_seen_at": now_iso(),
                }
                if name is not None:
                    patch["name"] = name
                if primary != entry.locator:
                    # Proof belongs to an expression, and this one is brand new.
                    patch["verified"] = False
                    patch["last_verified_at"] = None
                entries.append(entry.model_copy(update=patch))

            pages.append(page.model_copy(update={"locators": entries, "updated_at": now_iso()}))
        return library.model_copy(update={"pages": pages, "updated_at": now_iso()})

    library = await library_service.write_library(domain_id, mutate)
    if not found:
        raise ApiError(404, "That locator is no longer in the library.")

    return {**library.dump(), **library_service.summarise(library)}


@router.post("/{domain_id}/locators/promote")
async def promote_alternate(domain_id: str, request: Request) -> dict[str, Any]:
    """Swaps a kept-both alternate into the primary slot."""
    await _require_domain(domain_id)
    body = await json_body(request)

    page_url = text_field(body, "pageUrl")
    key = text_field(body, "key")
    locator = text_field(body, "locator")
    if not (page_url and key and locator):
        raise ApiError(400, "pageUrl, key and locator are all required.")
    target = canonical_page_url(page_url)

    def mutate(library: DomainLibrary) -> DomainLibrary:
        pages: list[PageLocators] = []
        for page in library.pages:
            if page.url != target:
                pages.append(page)
                continue
            entries = []
            for entry in page.locators:
                if entry.key != key or locator not in entry.alternates:
                    entries.append(entry)
                    continue
                alternates = [entry.locator, *(a for a in entry.alternates if a != locator)]
                entries.append(
                    entry.model_copy(
                        update={
                            "locator": locator,
                            "alternates": alternates,
                            # Proof belongs to an expression, not to an element.
                            "verified": False,
                            "last_verified_at": None,
                        }
                    )
                )
            pages.append(page.model_copy(update={"locators": entries, "updated_at": now_iso()}))
        return library.model_copy(update={"pages": pages, "updated_at": now_iso()})

    library = await library_service.write_library(domain_id, mutate)
    return {**library.dump(), **library_service.summarise(library)}


@router.post("/{domain_id}/generate", status_code=201)
async def generate_with_ai(domain_id: str, request: Request) -> dict[str, Any]:
    """Free text plus the domain's own locators — no recording needed."""
    domain = await _require_domain(domain_id)
    body = await json_body(request)

    prompt = text_field(body, "prompt")
    if not prompt:
        raise ApiError(400, "Describe the test you want in plain English.")

    url = text_field(body, "url") or domain.base_url
    name = body.get("name")

    try:
        return await generate_from_prompt(
            domain=domain,
            url=url,
            prompt=prompt,
            name=name if isinstance(name, str) else None,
        )
    except GenerationError as err:
        raise ApiError(502, str(err)) from err
    except ApiError:
        raise
    except Exception as err:
        raise ApiError(500, str(err)) from err
