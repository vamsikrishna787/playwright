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


class ScriptRecord(Record):
    id: str
    name: str
    source_url: str
    prompt: str
    file_path: str
    created_at: str
    updated_at: str


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
