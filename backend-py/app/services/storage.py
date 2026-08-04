"""Two JSON files standing in for a database.

Reads and writes are serialised per file by an asyncio lock, and every write
lands atomically, so a crash mid-save cannot leave a half-written index behind.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Callable, Generic, TypeVar

from ..config import RUNS_JSON, SCRIPTS_JSON
from ..models import RunRecord, ScriptRecord

M = TypeVar("M", bound=Any)


class JsonFileStore(Generic[M]):
    def __init__(self, file_path: Path, model: type[M]) -> None:
        self._path = file_path
        self._model = model
        self._lock = asyncio.Lock()

    async def read(self) -> list[M]:
        async with self._lock:
            return await asyncio.to_thread(self._load)

    async def update(self, mutate: Callable[[list[M]], list[M]]) -> list[M]:
        async with self._lock:
            nxt = mutate(await asyncio.to_thread(self._load))
            await asyncio.to_thread(self._save, nxt)
            return nxt

    def _load(self) -> list[M]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        return [self._model.model_validate(item) for item in raw]

    def _save(self, records: list[M]) -> None:
        payload = json.dumps([r.model_dump(by_alias=True) for r in records], indent=2)

        # Write beside the target so the replace stays on one filesystem, then
        # swap it in — os.replace is atomic on both Windows and POSIX.
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle, temp_path = tempfile.mkstemp(dir=self._path.parent, suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as file:
                file.write(payload)
            os.replace(temp_path, self._path)
        except BaseException:
            Path(temp_path).unlink(missing_ok=True)
            raise


scripts_store: JsonFileStore[ScriptRecord] = JsonFileStore(SCRIPTS_JSON, ScriptRecord)
runs_store: JsonFileStore[RunRecord] = JsonFileStore(RUNS_JSON, RunRecord)


def patch_run(runs: list[RunRecord], run_id: str, **patch: Any) -> list[RunRecord]:
    return [run.model_copy(update=patch) if run.id == run_id else run for run in runs]
