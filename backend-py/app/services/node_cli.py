"""Locating the Node tooling this API still drives.

The generated tests are TypeScript and are executed by the real Playwright Node
CLI, so the Python process has to find both `node` and the installed package
files itself — there is no `require.resolve` here.
"""

from __future__ import annotations

import shutil
from functools import lru_cache
from pathlib import Path

from ..config import BACKEND_ROOT


class NodeToolingError(RuntimeError):
    pass


@lru_cache(maxsize=None)
def node_executable() -> str:
    node = shutil.which("node")
    if not node:
        raise NodeToolingError(
            "Node.js was not found on PATH. The generated tests are TypeScript and are "
            "run by the Playwright Node CLI, so Node is required alongside Python."
        )
    return node


@lru_cache(maxsize=None)
def resolve_package_file(package: str, *relative: str) -> str:
    """Finds `node_modules/<package>/<relative...>`, walking up from the backend root."""
    for directory in (BACKEND_ROOT, *BACKEND_ROOT.parents):
        candidate = directory.joinpath("node_modules", *package.split("/"), *relative)
        if candidate.is_file():
            return str(candidate)

    raise NodeToolingError(
        f"Could not find node_modules/{package}/{'/'.join(relative)}. "
        f"Run `npm install` in {BACKEND_ROOT.parent}."
    )


def resolve_cli(package: str) -> str:
    """Resolves a package's own cli.js so it can be spawned with `node` directly.

    Avoids `npx`, which is a .cmd on Windows and throws from a bare exec.
    """
    return resolve_package_file(package, "cli.js")


def optional_package_file(package: str, *relative: str) -> Path | None:
    try:
        return Path(resolve_package_file(package, *relative))
    except NodeToolingError:
        return None
