"""The model client.

One job: turn a system prompt plus messages into text, and turn boto3's failure
modes into something a person can act on. Every prompt lives in prompts.py, so
swapping model or provider means changing only this file.
"""

from __future__ import annotations

import asyncio
import os
import re
from functools import lru_cache
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

from ..config import (
    AWS_REGION,
    BEDROCK_API_KEY,
    BEDROCK_MODEL_ID,
    MAX_OUTPUT_TOKENS,
    TEMPERATURE,
)

# A Bedrock API key (ABSK.../bedrock-api-key-...) is a bearer token, not an IAM key
# pair. botocore reads it straight from the environment for the bedrock services, so
# it is re-exported here already trimmed. Without a key, the default AWS chain applies.
if BEDROCK_API_KEY:
    os.environ["AWS_BEARER_TOKEN_BEDROCK"] = BEDROCK_API_KEY

_REJECTION_CODES = {"AccessDeniedException", "ValidationException", "ResourceNotFoundException"}

FENCE_RE = re.compile(r"```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```")


class ModelError(RuntimeError):
    """A model call that failed for a reason the user can do something about."""


@lru_cache(maxsize=1)
def _client() -> Any:
    return boto3.client("bedrock-runtime", region_name=AWS_REGION)


def _converse_sync(**kwargs: Any) -> dict[str, Any]:
    try:
        return _client().converse(**kwargs)
    except NoCredentialsError as err:
        raise ModelError(
            'AWS credentials were not found. Run "aws configure", or set '
            f"AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in backend-py/.env. ({err})"
        ) from err
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "")
        message = err.response.get("Error", {}).get("Message", "") or str(err)

        if re.search(r"use case details", message, re.I):
            raise ModelError(
                "This AWS account has not submitted the Anthropic use case details form, so no "
                "Anthropic model on Bedrock can be called. Open the Bedrock console in "
                f"{AWS_REGION} -> Model access -> submit the Anthropic use case details, then "
                "retry in ~15 minutes. The gate covers every Anthropic model, so switching "
                "between them will not help - but non-Anthropic models (e.g. "
                "us.amazon.nova-pro-v1:0) are unaffected."
            ) from err
        if re.search(r"bearer token", message, re.I):
            raise ModelError(
                f"The Bedrock API key in backend-py/.env was rejected: {message}. These keys are "
                "time-limited - mint a fresh one in the Bedrock console under API keys, or clear "
                "AWS_BEARER_TOKEN_BEDROCK to fall back to IAM credentials."
            ) from err
        if re.search(r"throttl|too many requests", message, re.I):
            raise ModelError(
                "Bedrock throttled the request. Wait a few seconds and try again - "
                "generation and refinement both count against the same per-account quota."
            ) from err
        if code in _REJECTION_CODES:
            raise ModelError(
                f'Bedrock rejected the request for model "{BEDROCK_MODEL_ID}" in {AWS_REGION}. '
                "Check that model access is enabled for your account in that region, and that "
                f"the inference profile prefix matches your region. ({message})"
            ) from err
        raise
    except BotoCoreError as err:
        message = str(err)
        if re.search(r"credential", message, re.I):
            raise ModelError(
                'AWS credentials were not found. Run "aws configure", or set '
                f"AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in backend-py/.env. ({message})"
            ) from err
        raise


async def converse(
    *,
    system: str,
    message: str,
    history: list[dict[str, Any]] | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> str:
    """Runs the blocking boto3 call off the event loop and returns the joined text."""
    messages = [*(history or []), {"role": "user", "content": [{"text": message}]}]

    response = await asyncio.to_thread(
        _converse_sync,
        modelId=BEDROCK_MODEL_ID,
        system=[{"text": system}],
        messages=messages,
        inferenceConfig={
            "maxTokens": max_tokens or MAX_OUTPUT_TOKENS,
            "temperature": TEMPERATURE if temperature is None else temperature,
        },
    )

    content = (response.get("output") or {}).get("message", {}).get("content") or []
    text = "".join(block.get("text", "") for block in content).strip()

    if not text:
        raise ModelError("The model returned an empty response. Try again.")
    return text


def split_code_and_reply(text: str, fallback_code: str) -> tuple[str, str]:
    """Pulls the file out of a fenced answer, keeping the prose as the reply.

    No fence means the model answered in prose alone — which is a real answer for
    an edit it declined to make, so the original file is kept and the prose is
    returned as-is rather than being treated as an error.
    """
    fence = FENCE_RE.search(text)
    if not fence:
        return fallback_code, re.sub(r"\s+", " ", text).strip()

    reply = re.sub(r"\s+", " ", text.replace(fence.group(0), "")).strip()
    return fence.group(1).strip(), reply or "Updated the test."


def strip_fences(text: str) -> str:
    """The whole answer as code, for prompts that were told to return no prose."""
    fence = FENCE_RE.search(text)
    return (fence.group(1) if fence else text).strip()


def model_id() -> str:
    return BEDROCK_MODEL_ID
