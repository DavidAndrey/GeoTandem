"""An Ollama behind ``httpx2.MockTransport``: ``/v1`` plus the native extras (C3).

Records every request it sees, headers and body included, so tests can say
what left the application.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx2

Answer = dict[str, Any] | httpx2.Response | Exception | Callable[[httpx2.Request], httpx2.Response]


def chat(
    content: str | None = "ok",
    *,
    tool_calls: list[dict[str, Any]] | None = None,
    finish_reason: str = "stop",
    prompt_tokens: int = 11,
    completion_tokens: int = 7,
) -> dict[str, Any]:
    """A chat completion as ``/v1/chat/completions`` returns it."""
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = [
            {
                "id": f"call_{i}",
                "type": "function",
                "function": {"name": c["name"], "arguments": c["arguments"]},
            }
            for i, c in enumerate(tool_calls)
        ]
    return {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 0,
        "model": "qwen3:8b",
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


@dataclass
class Seen:
    method: str
    path: str
    headers: dict[str, str]
    body: Any


@dataclass
class OllamaStub:
    answers: list[Answer] = field(default_factory=list)
    """For ``/v1/chat/completions``, in order; ``chat()`` once they run out."""
    models: dict[str, tuple[str, int]] = field(
        default_factory=lambda: {"qwen3:8b": ("sha256:abc", 5_200_000_000)}
    )
    version: str | None = "0.12.3"
    """``None``: not an Ollama, ``/api/*`` answers 404 (e.g. vLLM)."""
    models_answer: httpx2.Response | Exception | None = None
    """Instead of the model list: a failure of ``/v1/models``."""
    seen: list[Seen] = field(default_factory=list)

    def chat_requests(self) -> list[Seen]:
        return [s for s in self.seen if s.path == "/v1/chat/completions"]

    def transport(self) -> httpx2.MockTransport:
        return httpx2.MockTransport(self.handle)

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content) if request.content else None
        path = request.url.path
        self.seen.append(Seen(request.method, path, dict(request.headers), body))
        if path == "/v1/models" and self.models_answer is not None:
            if isinstance(self.models_answer, Exception):
                raise self.models_answer
            return self.models_answer
        if path == "/v1/models":
            data = [
                {"id": m, "object": "model", "created": 0, "owned_by": "library"}
                for m in self.models
            ]
            return httpx2.Response(200, json={"object": "list", "data": data})
        if path == "/v1/chat/completions":
            answer: Answer = self.answers.pop(0) if self.answers else chat()
            if isinstance(answer, Exception):
                raise answer
            if isinstance(answer, httpx2.Response):
                return answer
            if callable(answer):
                return answer(request)
            return httpx2.Response(200, json=answer)
        if self.version is not None and path == "/api/version":
            return httpx2.Response(200, json={"version": self.version})
        if self.version is not None and path == "/api/tags":
            tags = [
                {"name": m, "model": m, "digest": digest, "size": size}
                for m, (digest, size) in self.models.items()
            ]
            return httpx2.Response(200, json={"models": tags})
        return httpx2.Response(404, text="404 page not found")
