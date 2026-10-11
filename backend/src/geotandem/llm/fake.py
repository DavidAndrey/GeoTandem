"""A scripted ``LLMClient`` for tests of the services above the seam."""

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from geotandem.llm.client import Completion, LLMError, Message, ModelInfo, ToolSpec


@dataclass
class Call:
    messages: tuple[Message, ...]
    schema: dict[str, Any] | None
    tools: tuple[ToolSpec, ...]
    deadline: float | None = None


@dataclass
class FakeLLMClient:
    """Answers with ``script`` in order (a ``Completion`` or an ``LLMError`` to raise)
    and records every call; runs out loudly rather than inventing an answer. A
    call whose deadline has passed on ``clock`` raises ``llm_timeout`` and uses
    up no answer, as the adapter sends nothing then."""

    script: list[Completion | LLMError] = field(default_factory=list)
    offered: list[ModelInfo] = field(default_factory=list)
    version: str | None = None
    calls: list[Call] = field(default_factory=list)
    clock: Callable[[], float] = time.monotonic

    def complete(
        self,
        messages: Sequence[Message],
        *,
        schema: dict[str, Any] | None = None,
        schema_name: str = "answer",
        tools: Sequence[ToolSpec] = (),
        deadline: float | None = None,
    ) -> Completion:
        self.calls.append(Call(tuple(messages), schema, tuple(tools), deadline))
        if deadline is not None and self.clock() >= deadline:
            raise LLMError("llm_timeout", "No answer before the deadline.", cause="deadline")
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

    def close(self) -> None:
        pass
