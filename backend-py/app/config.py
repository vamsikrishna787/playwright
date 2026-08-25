"""Environment for the agent API.

This tier owns no disk. It holds prompts and a model client, is called by the
Node orchestration API, and forgets everything between requests — which is why
there are no data directories here any more.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parent.parent

load_dotenv(BACKEND_ROOT / ".env")

PORT = int(os.getenv("PORT") or 8000)

AWS_REGION = os.getenv("AWS_REGION") or "us-east-1"
BEDROCK_API_KEY = (os.getenv("AWS_BEARER_TOKEN_BEDROCK") or "").strip()
BEDROCK_MODEL_ID = os.getenv("BEDROCK_MODEL_ID") or "us.amazon.nova-pro-v1:0"

#: Amazon Nova caps generation at 5K output tokens and rejects anything higher
#: with a ValidationException, so this is the ceiling for a whole spec file.
MAX_OUTPUT_TOKENS = int(os.getenv("MAX_OUTPUT_TOKENS") or 5000)

#: Low, because a test file is not creative writing — the same steps should
#: produce the same script.
TEMPERATURE = float(os.getenv("TEMPERATURE") or 0.2)

#: Cap on the failure report handed to the model when fixing a broken test.
FAILURE_MAX_CHARS = 6_000

#: Largest JSON body accepted. A spec plus a failure report is the big case.
MAX_BODY_BYTES = 4 * 1024 * 1024
