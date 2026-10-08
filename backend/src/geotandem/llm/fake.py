"""A scripted ``LLMClient`` for tests of the services above the seam."""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from geotandem.llm.client import Completion, LLMError, Message, ModelInfo, ToolSpec


@dataclass
class Call:
    messages: tuple[Message, ...]
    schema: dict[str, Any] | None
    tools: tuple[ToolSpec, ...]


@dataclass
class FakeLLMClient:
    """Answers with ``script`` in order (a ``Completion`` or an ``LLMError`` to raise)
    and records every call; runs out loudly rather than inventing an answer."""

    script: list[Completion | LLMError] = field(default_factory=list)
    offered: list[ModelInfo] = field(default_factory=list)
    version: str | None = None
    calls: list[Call] = field(default_factory=list)

    def complete(
        self,
        messages: Sequence[Message],
        *,
        schema: dict[str, Any] | None = None,
        schema_name: str = "answer",
        tools: Sequence[ToolSpec] = (),
    ) -> Completion:
        self.calls.append(Call(tuple(messages), schema, tuple(tools)))
        if not self.script:
            raise AssertionError("FakeLLMClient: no scripted answer left")
        answer = self.script.pop(0)
        if isinstance(answer, LLMError):
            raise answer
        return answer

    def models(self) -> list[ModelInfo]:
        return list(self.offered)

    def server_version(self) -> str | None:
        return self.version
