"""The seam to a language model (F-7.3, plan E2.1, C1).

Services talk to ``LLMClient`` only; ``openai_compat`` is the one module
that knows a concrete protocol. This module uses the standard library and
pydantic, nothing else, so a service or a test never needs the SDK.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Effort = Literal["default", "none", "low", "medium", "high"]
"""Reasoning effort (C10). ``default`` sends nothing; any other value is sent
on every call. Thinking on can turn a 6 s answer into a 190 s one."""

EFFORTS: tuple[Effort, ...] = ("default", "none", "low", "medium", "high")

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(frozen=True)
class Endpoint:
    """Where and how to call one model; a connection's parameters (C4).

    The API key arrives decrypted, and only here: the adapter is built for a
    call and dropped after it (C8).
    """

    base_url: str
    model: str
    api_key: str | None = field(default=None, repr=False)
    temperature: float = 0
    seed: int | None = 42
    timeout_s: float = 120
    reasoning_effort: Effort = "default"


@dataclass(frozen=True)
class ToolCall:
    """A tool call as the model wrote it: arguments verbatim, parsed if they parse."""

    id: str
    name: str
    arguments: str
    parsed: dict[str, Any] | None = None
    parse_error: str | None = None


@dataclass(frozen=True)
class Message:
    role: Role
    content: str
    tool_call_id: str | None = None
    """For ``role="tool"``: the call this answers."""
    tool_calls: tuple[ToolCall, ...] = ()
    """For ``role="assistant"``: the calls it made, so a chain can be replayed."""


@dataclass(frozen=True)
class ToolSpec:
    """A tool offered to the model: its name, what it does, its arguments' JSON schema."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class Completion:
    """One answer, with what evaluation needs kept rather than thrown away (E3, C1)."""

    text: str
    """The model's text, verbatim."""
    parsed: Any = None
    """With a JSON schema: ``text`` parsed as JSON, if it parses."""
    parse_error: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()
    finish_reason: str | None = None
    latency_ms: int = 0
    """From the first request to the answer, retries included."""
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    retries: int = 0


@dataclass(frozen=True)
class ModelInfo:
    """A model the endpoint offers. Digest and size only where Ollama tells them (C3)."""

    id: str
    digest: str | None = None
    size: int | None = None


class LLMError(Exception):
    """A call that brought no completion; ``code`` is stable, ``cause`` the verbatim
    reason without any response body (C12, C13)."""

    def __init__(self, code: str, message: str, *, cause: str = "", retries: int = 0) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.cause = cause
        self.retries = retries


class LLMClient(Protocol):
    def complete(
        self,
        messages: Sequence[Message],
        *,
        schema: dict[str, Any] | None = None,
        schema_name: str = "answer",
        tools: Sequence[ToolSpec] = (),
    ) -> Completion:
        """Ask once. With ``schema`` the answer is constrained to it (JSON-schema
        output); with ``tools`` the model may call them instead of answering."""
        ...

    def models(self) -> list[ModelInfo]:
        """What the endpoint offers (``/v1/models``, with Ollama's extras)."""
        ...

    def server_version(self) -> str | None:
        """Ollama's version when the endpoint is an Ollama, else ``None`` (C3)."""
        ...
