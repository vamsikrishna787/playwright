"""Paths, tunables and environment for the API.

Mirrors the layout the TypeScript backend used, so a `data/`, `scripts/` and
`runs/` tree copied from `backend/` drops straight in here.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parent.parent

load_dotenv(BACKEND_ROOT / ".env")

PORT = int(os.getenv("PORT") or 3001)

DATA_DIR = BACKEND_ROOT / "data"
SCRIPTS_DIR = BACKEND_ROOT / "scripts"
RUNS_DIR = BACKEND_ROOT / "runs"

SCRIPTS_JSON = DATA_DIR / "scripts.json"
RUNS_JSON = DATA_DIR / "runs.json"

# Stays TypeScript: it is read by the Playwright Node CLI, not by this app.
RUNNER_CONFIG_PATH = BACKEND_ROOT / "playwright.runner.config.ts"

AWS_REGION = os.getenv("AWS_REGION") or "us-east-1"
BEDROCK_API_KEY = (os.getenv("AWS_BEARER_TOKEN_BEDROCK") or "").strip()
BEDROCK_MODEL_ID = os.getenv("BEDROCK_MODEL_ID") or "us.amazon.nova-pro-v1:0"

SNAPSHOT_MAX_CHARS = 15_000

# Proven scripts shown to the model as structural examples, and their size cap.
MAX_EXEMPLARS = 2
EXEMPLAR_MAX_CHARS = 6_000

# Cap on the failure report handed to the model when fixing a broken test.
FAILURE_MAX_CHARS = 4_000

# Largest JSON body accepted, matching the old express.json({ limit: '2mb' }).
MAX_BODY_BYTES = 2 * 1024 * 1024


def ensure_dirs() -> None:
    for directory in (DATA_DIR, SCRIPTS_DIR, RUNS_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def spec_file_name(script_id: str) -> str:
    return f"{script_id}.spec.ts"


def spec_file_path(script_id: str) -> Path:
    return SCRIPTS_DIR / spec_file_name(script_id)


# The page snapshot is kept beside the spec rather than in scripts.json so the
# index stays small, and so later edits can be grounded in the real page.
def snapshot_file_path(script_id: str) -> Path:
    return SCRIPTS_DIR / f"{script_id}.snapshot.txt"


def run_dir(script_id: str, run_id: str) -> Path:
    return RUNS_DIR / script_id / run_id


def to_relative(absolute: Path | str) -> str:
    """Backend-root-relative POSIX path, the form stored in runs.json."""
    return os.path.relpath(str(absolute), str(BACKEND_ROOT)).replace("\\", "/")
