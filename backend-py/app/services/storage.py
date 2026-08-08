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

from ..config import DOMAINS_JSON, RUNS_JSON, SCRIPTS_JSON
from ..models import DomainRecord, RunRecord, ScriptRecord

M = TypeVar("M", bound=Any)
D = TypeVar("D", bound=Any)


def _atomic_write(path: Path, payload: str) -> None:
    # Write beside the target so the replace stays on one filesystem, then
    # swap it in — os.replace is atomic on both Windows and POSIX.
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(payload)
        os.replace(temp_path, path)
    except BaseException:
        Path(temp_path).unlink(missing_ok=True)
        raise


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
        _atomic_write(self._path, payload)


class JsonDocStore(Generic[D]):
    """One document per file, addressed by path — the locator libraries.

    Same guarantees as JsonFileStore, but the lock is per file rather than per
    store, so two domains never wait on each other.
    """

    def __init__(self, model: type[D]) -> None:
        self._model = model
        self._locks: dict[Path, asyncio.Lock] = {}

    def _lock_for(self, path: Path) -> asyncio.Lock:
        # Safe without a guard: the event loop never suspends inside setdefault.
        return self._locks.setdefault(path, asyncio.Lock())

    async def read(self, path: Path, fallback: Callable[[], D]) -> D:
        async with self._lock_for(path):
            return await asyncio.to_thread(self._load, path, fallback)

    async def update(self, path: Path, mutate: Callable[[D], D], fallback: Callable[[], D]) -> D:
        async with self._lock_for(path):
            nxt = mutate(await asyncio.to_thread(self._load, path, fallback))
            await asyncio.to_thread(self._save, path, nxt)
            return nxt

    def _load(self, path: Path, fallback: Callable[[], D]) -> D:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return fallback()
        return self._model.model_validate(raw)

    def _save(self, path: Path, document: D) -> None:
        _atomic_write(path, json.dumps(document.model_dump(by_alias=True), indent=2))


scripts_store: JsonFileStore[ScriptRecord] = JsonFileStore(SCRIPTS_JSON, ScriptRecord)
runs_store: JsonFileStore[RunRecord] = JsonFileStore(RUNS_JSON, RunRecord)
domains_store: JsonFileStore[DomainRecord] = JsonFileStore(DOMAINS_JSON, DomainRecord)


def patch_run(runs: list[RunRecord], run_id: str, **patch: Any) -> list[RunRecord]:
    return [run.model_copy(update=patch) if run.id == run_id else run for run in runs]
