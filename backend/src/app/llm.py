"""Model backends for the generation agent, all on Amazon Bedrock.

- AnthropicBackend: Claude through the Anthropic SDK. `anthropic.claude-*` ids use the Messages-API
  endpoint (bedrock-mantle); inference-profile ids like `global.anthropic.claude-sonnet-4-6` use InvokeModel.
- ConverseBackend: any other Bedrock model with tool use (Amazon Nova, Kimi, Qwen, DeepSeek, ...)
  through the Bedrock Converse API.

Both expose the same small interface so the agent loop does not care which one is in use:
    add_user_text(text) / add_tool_results([ToolResult]) / step() -> Turn
"""

import base64
import os
from dataclasses import dataclass, field

import boto3
from botocore.config import Config

MODEL = os.environ.get("BEDROCK_MODEL_ID", "us.moonshotai.kimi-k3")
FALLBACK_MODEL = os.environ.get("BEDROCK_FALLBACK_MODEL_ID", "")
EFFORT = os.environ.get("BEDROCK_EFFORT", "high")
REGION = os.environ.get("BEDROCK_REGION") or os.environ.get("AWS_REGION", "us-east-1")
MAX_TOKENS = int(os.environ.get("BEDROCK_MAX_TOKENS", "16000"))


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict


@dataclass
class ToolResult:
    id: str
    blocks: list  # [{"type": "text", "text": ...}] or {"type": "image", "source": {...}}
    is_error: bool


@dataclass
class Turn:
    text: str
    tool_calls: list
    stop: str  # "tool_use" | "end_turn" | "max_tokens" | "refusal"
    usage: dict = field(default_factory=dict)


def is_claude(model_id):
    return "anthropic.claude" in model_id


def make_backend(system_prompt, tools):
    """tools: [{"name", "description", "input_schema"}] in JSON-schema form."""
    cls = AnthropicBackend if is_claude(MODEL) else ConverseBackend
    return cls(system_prompt, tools)


# ---------------------------------------------------------------- Claude (Anthropic SDK)

class AnthropicBackend:
    CACHE = {"type": "ephemeral"}

    def __init__(self, system_prompt, tools):
        from anthropic import AnthropicBedrock, AnthropicBedrockMantle, BetaFallbackState, BetaRefusalFallbackMiddleware

        if MODEL.startswith("anthropic."):
            # Bedrock has no server-side `fallbacks`, so refusals are retried client-side on the fallback model.
            use_fallback = FALLBACK_MODEL.startswith("anthropic.") and FALLBACK_MODEL != MODEL
            middleware = [BetaRefusalFallbackMiddleware([{"model": FALLBACK_MODEL}])] if use_fallback else None
            self.client = AnthropicBedrockMantle(aws_region=REGION, middleware=middleware, max_retries=4, timeout=600)
        else:
            self.client = AnthropicBedrock(aws_region=REGION, max_retries=4, timeout=600)
        self.fallback_state = BetaFallbackState()
        # Explicit cache breakpoints (system, tools, newest message) work on both Bedrock endpoints.
        self.system = [{"type": "text", "text": system_prompt, "cache_control": self.CACHE}]
        self.tools = [*tools[:-1], {**tools[-1], "cache_control": self.CACHE}]
        self.messages = []

    def add_user_text(self, text):
        self.messages.append({"role": "user", "content": [{"type": "text", "text": text}]})

    def add_tool_results(self, results):
        self.messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": r.id, "content": r.blocks, "is_error": r.is_error} for r in results
        ]})

    def _with_cache_breakpoint(self):
        last = self.messages[-1]
        content = [*last["content"][:-1], {**last["content"][-1], "cache_control": self.CACHE}]
        return [*self.messages[:-1], {**last, "content": content}]

    def step(self):
        with self.fallback_state:
            with self.client.beta.messages.stream(
                model=MODEL,
                max_tokens=32_000,
                system=self.system,
                tools=self.tools,
                messages=self._with_cache_breakpoint(),
                # Explicit, because Opus 4.7/4.8 run without thinking unless asked (later models default to adaptive).
                thinking={"type": "adaptive"},
                output_config={"effort": EFFORT},
            ) as stream:
                response = stream.get_final_message()
        # Append the full content (thinking blocks included) unchanged: history must stay append-only.
        self.messages.append({"role": "assistant", "content": response.content})
        usage = {k: getattr(response.usage, k, 0) or 0 for k in
                 ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")}
        return Turn(
            text="".join(b.text for b in response.content if b.type == "text").strip(),
            tool_calls=[ToolCall(b.id, b.name, b.input or {}) for b in response.content if b.type == "tool_use"],
            stop=response.stop_reason if response.stop_reason in ("tool_use", "max_tokens", "refusal") else "end_turn",
            usage=usage,
        )


# ---------------------------------------------------------------- any Bedrock model (Converse API)

class ConverseBackend:
    def __init__(self, system_prompt, tools):
        self.client = boto3.client("bedrock-runtime", region_name=REGION,
                                   config=Config(read_timeout=600, retries={"max_attempts": 5, "mode": "adaptive"}))
        self.system = [{"text": system_prompt}]
        self.tool_config = {"tools": [
            {"toolSpec": {"name": t["name"], "description": t["description"][:4000], "inputSchema": {"json": t["input_schema"]}}}
            for t in tools
        ]}
        self.messages = []

    def add_user_text(self, text):
        self.messages.append({"role": "user", "content": [{"text": text}]})

    @staticmethod
    def _content(block):
        if block["type"] == "image":
            media_type = block["source"]["media_type"]
            return {"image": {"format": media_type.split("/")[-1], "source": {"bytes": base64.b64decode(block["source"]["data"])}}}
        return {"text": block.get("text") or "(empty)"}

    def add_tool_results(self, results):
        self.messages.append({"role": "user", "content": [
            {"toolResult": {"toolUseId": r.id, "content": [self._content(b) for b in r.blocks],
                            "status": "error" if r.is_error else "success"}}
            for r in results
        ]})

    def step(self):
        response = self.client.converse(
            modelId=MODEL,
            system=self.system,
            messages=self.messages,
            toolConfig=self.tool_config,
            inferenceConfig={"maxTokens": MAX_TOKENS},
        )
        message = response["output"]["message"]
        self.messages.append(message)
        content = message.get("content", [])
        usage = response.get("usage", {})
        stop = response.get("stopReason", "end_turn")
        if stop in ("guardrail_intervened", "content_filtered"):
            stop = "refusal"
        elif stop not in ("tool_use", "max_tokens"):
            stop = "end_turn"
        return Turn(
            text="".join(c["text"] for c in content if "text" in c).strip(),
            tool_calls=[ToolCall(c["toolUse"]["toolUseId"], c["toolUse"]["name"], c["toolUse"].get("input") or {})
                        for c in content if "toolUse" in c],
            stop=stop,
            usage={
                "input_tokens": usage.get("inputTokens", 0),
                "output_tokens": usage.get("outputTokens", 0),
                "cache_read_input_tokens": usage.get("cacheReadInputTokens", 0),
                "cache_creation_input_tokens": usage.get("cacheWriteInputTokens", 0),
            },
        )
