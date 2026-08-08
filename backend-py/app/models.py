"""Persisted records.

Field names are snake_case in Python and camelCase on the wire — the React
frontend and the existing scripts.json / runs.json files both speak camelCase,
so every dump goes through `by_alias=True`.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, model_serializer
from pydantic.alias_generators import to_camel

RunStatus = Literal["queued", "running", "passed", "failed", "error"]


class Record(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    def dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True)


class DomainRecord(Record):
    """A site. Scripts, and the locator library they share, hang off one of these."""

    id: str
    #: Display label. Defaults to the host, and can be renamed.
    name: str
    #: Canonical key — the lower-cased host, e.g. "www.saucedemo.com".
    host: str
    #: Best-known entry point, used to prefill the URL box.
    base_url: str
    created_at: str
    updated_at: str


class ScriptRecord(Record):
    id: str
    name: str
    source_url: str
    prompt: str
    file_path: str
    created_at: str
    updated_at: str
    #: Owning domain. Backfilled from source_url for records written before
    #: domains existed, so old scripts.json files still load.
    domain_id: str = ""
    #: How the script came to be: a recorded journey, or free text plus the library.
    origin: Literal["record", "ai"] = "record"
    #: Pages the generation was grounded in — the library rows this script speaks for.
    page_urls: list[str] = []


class LocatorEntry(Record):
    """One element on one page, and every locator expression we've seen for it."""

    #: Stable identity across recordings — role + accessible name, not the
    #: expression. The expression is the thing that changes; the key must not.
    key: str
    #: The expression a generated test should use.
    locator: str
    #: Earlier expressions kept deliberately, when the user chose "keep both".
    alternates: list[str] = []
    role: str = ""
    name: str = ""
    tag: str = ""
    type: str | None = None
    placeholder: str | None = None
    options: list[str] | None = None
    #: True once a test using this exact expression has passed.
    verified: bool = False
    first_seen_at: str
    last_seen_at: str
    #: When this expression first went from observed to verified. Distinct from
    #: last_verified_at, which every later passing run overwrites — only this one
    #: can answer "when did we start trusting it".
    verified_since: str | None = None
    last_verified_at: str | None = None


class PageLocators(Record):
    url: str
    title: str = ""
    headings: list[str] = []
    locators: list[LocatorEntry] = []
    updated_at: str


class DomainLibrary(Record):
    """Every page ever inventoried for one domain. One JSON file per domain."""

    domain_id: str
    pages: list[PageLocators] = []
    updated_at: str


class LocatorConflict(Record):
    """An element whose locator expression changed since we last saw the page.

    Surfaced to the user rather than resolved silently: a changed expression is
    either the page moving under us, or a genuinely different element that now
    answers to the same name, and only a human can tell those apart.
    """

    page_url: str
    key: str
    role: str
    name: str
    existing_locator: str
    new_locator: str
    existing_alternates: list[str] = []
    #: True when the stored expression was proven by a passing run.
    existing_verified: bool = False


class ScriptStep(Record):
    """One line of the plain-English view of a generated spec."""

    index: int
    #: navigate | fill | click | select | check | press | assert | accessibility | other
    action: str
    #: Human sentence, e.g. "Fill Username with standard_user".
    text: str
    #: The test.step title the model wrote, when there was one.
    title: str = ""
    #: Which test the step belongs to, for grouping in the UI.
    test: str = ""
    target: str = ""
    value: str | None = None


class RunStep(Record):
    title: str
    duration_ms: int
    error: str | None = None

    @model_serializer(mode="wrap")
    def _omit_absent_error(self, handler: Any) -> dict[str, Any]:
        # A step without an error omits the key entirely, as the TS version did.
        data = handler(self)
        if data.get("error") is None:
            data.pop("error", None)
        return data


class RunTest(Record):
    """One test() within the spec — a run holds a functional test and an a11y test."""

    title: str
    status: Literal["passed", "failed"]
    duration_ms: int
    steps: list[RunStep]
    error: str | None


class LighthouseReport(Record):
    """A Lighthouse audit of the page a run exercised.

    Attached to the run but graded separately: it says nothing about whether the
    test passed, only what shape the page was in when it ran.
    """

    status: Literal["queued", "running", "done", "error", "skipped"]
    url: str = ""
    #: 0-100 per category, or None where Lighthouse could not grade one.
    scores: dict[str, int | None] = {}
    #: Human-readable metric values, e.g. {"largestContentfulPaint": "1.2 s"}.
    metrics: dict[str, str] = {}
    report_path: str | None = None
    json_path: str | None = None
    version: str = ""
    error: str | None = None
    finished_at: str | None = None


class RunRecord(Record):
    id: str
    script_id: str
    status: RunStatus
    started_at: str
    finished_at: str | None
    duration_ms: int | None
    video_path: str | None
    report_path: str
    #: Per-test breakdown.
    tests: list[RunTest]
    #: All steps flattened, kept so summaries stay cheap to render.
    steps: list[RunStep]
    error: str | None
    #: Filled in after the verdict, since an audit takes far longer than the test.
    lighthouse: LighthouseReport | None = None
