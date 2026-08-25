"""Request and response shapes for the agent API.

Nothing here is persisted — these are wire contracts with the Node tier. Field
names are camelCase on the wire because that is what Node and the browser speak,
and snake_case in Python, so every model carries the alias generator.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Wire(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class DataField(Wire):
    """One named value the test types into the page."""

    id: str = ""
    #: Groups fields in the UI, and tells the model a billing postcode from a
    #: shipping one when both are present.
    category: str = "General"
    name: str
    value: str = ""
    secret: bool = False


class StepInput(Wire):
    """One authored step: what to do, and what should then be true."""

    index: int
    action: str
    expected: str = ""
    #: The data fields this step uses, already resolved by Node.
    data: list[DataField] = []


class GenerateRequest(Wire):
    test_name: str
    description: str = ""
    url: str
    suite_name: str = ""
    include_ada: bool = True
    steps: list[StepInput]
    data_fields: list[DataField] = []


class ChatTurn(Wire):
    role: Literal["user", "assistant"]
    text: str


class RefineRequest(Wire):
    code: str
    instruction: str
    url: str = ""
    history: list[ChatTurn] = []


class ImproveRequest(Wire):
    code: str
    #: stability | readability | coverage | performance
    goal: str = "stability"
    url: str = ""


class AdaRequest(Wire):
    code: str
    url: str = ""


class FixRequest(Wire):
    code: str
    #: Real output from the failing run, rendered by Node.
    failure: str
    url: str = ""


class ExtractRequest(Wire):
    code: str


class CodeReply(Wire):
    code: str
    reply: str = ""
    model: str = ""


class ScriptStep(Wire):
    """One line of the plain-English reading of a spec."""

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


class ExtractReply(Wire):
    steps: list[ScriptStep]


class AgentAction(Wire):
    id: str
    label: str
    description: str
    needs_instruction: bool = False


class CatalogReply(Wire):
    actions: list[AgentAction]
    model: str = ""


def dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(by_alias=True)


__all__ = [
    "AdaRequest",
    "AgentAction",
    "CatalogReply",
    "ChatTurn",
    "CodeReply",
    "DataField",
    "ExtractReply",
    "ExtractRequest",
    "Field",
    "FixRequest",
    "GenerateRequest",
    "ImproveRequest",
    "RefineRequest",
    "ScriptStep",
    "StepInput",
    "dump",
]
