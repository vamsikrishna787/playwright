"""Domains — the site a script belongs to, and the unit the UI is organised by.

A domain is derived from the host of whatever URL the user starts from, so the
grouping happens on its own: record two flows on saucedemo.com and both land in
the same place, sharing one locator library.
"""

from __future__ import annotations

import uuid
from urllib.parse import urlsplit, urlunsplit

from ..models import DomainRecord, ScriptRecord
from ..utils import now_iso
from .storage import domains_store, scripts_store


def host_of(url: str) -> str:
    """Lower-cased host, without credentials. Empty when the URL has none."""
    try:
        netloc = urlsplit(url.strip()).netloc
    except ValueError:
        return ""
    return netloc.rsplit("@", 1)[-1].lower()


def base_url_of(url: str) -> str:
    parts = urlsplit(url.strip())
    if not parts.netloc:
        return url.strip()
    return urlunsplit((parts.scheme or "https", parts.netloc, "/", "", ""))


def canonical_page_url(url: str) -> str:
    """The key a page is stored under in the locator library.

    Query strings and fragments are dropped: ?sort=price and ?sort=name are the
    same screen with the same controls, and keeping them apart would fill the
    library with near-identical copies of one page.
    """
    parts = urlsplit(url.strip())
    if not parts.netloc:
        return url.strip()
    path = parts.path or "/"
    if len(path) > 1:
        path = path.rstrip("/") or "/"
    return urlunsplit((parts.scheme or "https", parts.netloc.lower(), path, "", ""))


def display_name(host: str) -> str:
    return host or "Unknown site"


async def find_domain(domain_id: str) -> DomainRecord | None:
    return next((d for d in await domains_store.read() if d.id == domain_id), None)


async def find_by_host(host: str) -> DomainRecord | None:
    return next((d for d in await domains_store.read() if d.host == host), None)


async def ensure_domain(url: str) -> DomainRecord:
    """The domain for this URL, created if this is the first time we've seen the host."""
    host = host_of(url)
    if not host:
        raise ValueError(f"Could not read a site host out of {url!r}. Include http:// or https://.")

    if existing := await find_by_host(host):
        return existing

    now = now_iso()
    record = DomainRecord(
        id=str(uuid.uuid4()),
        name=display_name(host),
        host=host,
        base_url=base_url_of(url),
        created_at=now,
        updated_at=now,
    )

    # Re-check inside the write: two recordings started at once on a new host
    # would otherwise each create their own domain for it.
    def mutate(domains: list[DomainRecord]) -> list[DomainRecord]:
        if any(d.host == host for d in domains):
            return domains
        return [*domains, record]

    saved = await domains_store.update(mutate)
    return next(d for d in saved if d.host == host)


async def backfill_domains() -> None:
    """Gives every pre-domain script a home, at startup.

    Scripts written before this existed carry no domainId. Rather than hiding
    them from a UI that groups by domain, each one adopts the domain of its own
    source URL — created here if the host has never been seen.
    """
    scripts = await scripts_store.read()
    orphans = [s for s in scripts if not s.domain_id]
    if not orphans:
        return

    resolved: dict[str, str] = {}
    for script in orphans:
        host = host_of(script.source_url)
        if host in resolved:
            continue
        try:
            domain = await ensure_domain(script.source_url)
        except ValueError:
            continue
        resolved[host] = domain.id

    def mutate(current: list[ScriptRecord]) -> list[ScriptRecord]:
        return [
            script.model_copy(update={"domain_id": domain_id})
            if not script.domain_id
            and (domain_id := resolved.get(host_of(script.source_url))) is not None
            else script
            for script in current
        ]

    await scripts_store.update(mutate)
