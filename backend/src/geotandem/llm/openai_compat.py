"""The one adapter: any OpenAI-compatible ``/v1`` endpoint (plan E2.1, C2, C3, C9).

Ollama, vLLM, llama.cpp, OpenAI and Anthropic's compatibility endpoint all
speak it. This is the only module that imports ``openai`` (a test counts the
imports), so nothing else can build a client that skips the guards below.

Guards, each tested on the transport actually used:

- ``trust_env=False``: no proxy variable sends the payload elsewhere.
- ``follow_redirects=False``: a redirect is refused, not followed to another host.
- Headers rebuilt from an allowlist: the SDK would add ``OPENAI_ORG_ID``,
  ``OPENAI_PROJECT_ID`` and ``OPENAI_CUSTOM_HEADERS`` from the environment to
  every request, whoever the endpoint is.
- SDK retries off; one loop here retries at most twice, on connection
  errors and 408/409/425/429/5xx only, so the count is known and reported.
"""

import json
import logging
import time
from collections.abc import Callable, Sequence
from typing import Any, Self

import httpx2
import openai

from geotandem.llm.client import (
    Completion,
    Endpoint,
    LLMError,
    Message,
    ModelInfo,
    ToolCall,
    ToolSpec,
)

log = logging.getLogger("geotandem.llm")

MAX_RETRIES = 2
RETRY_STATUS = frozenset({408, 409, 425, 429})
CONNECT_TIMEOUT_S = 5.0
PROBE_TIMEOUT_S = 5.0

_SENT_HEADERS = frozenset(
    {"accept", "accept-encoding", "content-type", "content-length", "host", "user-agent"}
)


def _wire(message: Message) -> dict[str, Any]:
    wire: dict[str, Any] = {"role": message.role, "content": message.content}
    if message.tool_call_id is not None:
        wire["tool_call_id"] = message.tool_call_id
    if message.tool_calls:
        wire["tool_calls"] = [
            {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
            for c in message.tool_calls
        ]
    return wire


def _tool_call(call: Any) -> ToolCall:
    function = getattr(call, "function", None)
    name = getattr(function, "name", "") or ""
    arguments = getattr(function, "arguments", "") or ""
    try:
        parsed = json.loads(arguments) if arguments else {}
    except ValueError as exc:
        return ToolCall(call.id, name, arguments, parse_error=str(exc))
    if not isinstance(parsed, dict):
        return ToolCall(call.id, name, arguments, parse_error="arguments are not a JSON object")
    return ToolCall(call.id, name, arguments, parsed=parsed)


def _status_error(status: int, retries: int) -> LLMError:
    if 300 <= status < 400:
        code, message = "llm_redirect", "The endpoint redirected; redirects are not followed."
    elif status in (401, 403):
        code, message = "llm_unauthorized", "The endpoint refused the credentials."
    elif status == 404:
        code, message = "llm_not_found", "The endpoint or the model does not exist."
    elif status == 429:
        code, message = "llm_rate_limited", "The endpoint limits requests."
    elif status >= 500:
        code, message = "llm_server_error", "The endpoint failed."
    else:
        code, message = "llm_rejected", "The endpoint rejected the request."
    # The status only: a response body may echo the request or carry anything (C13).
    return LLMError(code, message, cause=f"HTTP {status}", retries=retries)


def _cause(exc: BaseException) -> str:
    inner = exc.__cause__ or exc.__context__
    return f"{type(inner).__name__}: {inner}" if inner else type(exc).__name__


class OpenAICompatClient:
    """An ``LLMClient`` for one endpoint. Build it for a call, close it after (C8)."""

    def __init__(
        self,
        endpoint: Endpoint,
        *,
        transport: httpx2.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.endpoint = endpoint
        self._sleep = sleep
        timeout = httpx2.Timeout(
            endpoint.timeout_s, connect=min(endpoint.timeout_s, CONNECT_TIMEOUT_S)
        )
        self._http = httpx2.Client(
            trust_env=False,
            follow_redirects=False,
            timeout=timeout,
            transport=transport,
            event_hooks={"request": [self._only_our_headers]},
        )
        self._sdk = openai.OpenAI(
            base_url=endpoint.base_url,
            # The SDK insists on a key; the header hook sends ours or none.
            api_key=endpoint.api_key or "-",
            http_client=self._http,
            max_retries=0,
            timeout=timeout,
        )

    def _only_our_headers(self, request: httpx2.Request) -> None:
        for name in list(request.headers):
            if name.lower() not in _SENT_HEADERS:
                del request.headers[name]
        if self.endpoint.api_key:
            request.headers["Authorization"] = f"Bearer {self.endpoint.api_key}"

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    # --- calls -------------------------------------------------------------------

    def _with_retries[T](self, call: Callable[[], T]) -> tuple[T, int]:
        retries = 0
        while True:
            try:
                return call(), retries
            except openai.APITimeoutError as exc:
                # A timeout is not retried: the model is slow, and asking again doubles the wait.
                raise LLMError(
                    "llm_timeout",
                    f"No answer within {self.endpoint.timeout_s:g} s.",
                    cause=_cause(exc),
                    retries=retries,
                ) from None
            except openai.APIConnectionError as exc:
                error = LLMError(
                    "llm_unreachable",
                    "The endpoint could not be reached.",
                    cause=_cause(exc),
                    retries=retries,
                )
                retryable = True
            except openai.APIStatusError as exc:
                error = _status_error(exc.status_code, retries)
                retryable = exc.status_code in RETRY_STATUS or exc.status_code >= 500
            except openai.APIError as exc:
                raise LLMError(
                    "llm_bad_response",
                    "The endpoint's answer is not a valid response.",
                    cause=type(exc).__name__,
                    retries=retries,
                ) from None
            if not retryable or retries >= MAX_RETRIES:
                raise error from None
            retries += 1
            self._sleep(0.5 * 2 ** (retries - 1))

    def complete(
        self,
        messages: Sequence[Message],
        *,
        schema: dict[str, Any] | None = None,
        schema_name: str = "answer",
        tools: Sequence[ToolSpec] = (),
    ) -> Completion:
        endpoint = self.endpoint
        request: dict[str, Any] = {
            "model": endpoint.model,
            "messages": [_wire(m) for m in messages],
            "temperature": endpoint.temperature,
        }
        if endpoint.seed is not None:
            request["seed"] = endpoint.seed
        if endpoint.reasoning_effort != "default":
            request["reasoning_effort"] = endpoint.reasoning_effort
        if schema is not None:
            request["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "schema": schema},
            }
        if tools:
            request["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                }
                for t in tools
            ]

        started = time.monotonic()
        try:
            response, retries = self._with_retries(
                lambda: self._sdk.chat.completions.create(**request)
            )
        except LLMError as exc:
            log.info(
                "llm call failed: model=%s code=%s retries=%d",
                endpoint.model,
                exc.code,
                exc.retries,
            )
            raise
        latency_ms = round((time.monotonic() - started) * 1000)

        # A 200 whose body is not JSON reaches us as text, not as a completion.
        choices = getattr(response, "choices", None)
        if not choices:
            raise LLMError("llm_bad_response", "The answer has no choices.", retries=retries)
        choice = choices[0]
        text = choice.message.content or ""
        parsed: Any = None
        parse_error: str | None = None
        if schema is not None:
            try:
                parsed = json.loads(text)
            except ValueError as exc:
                parse_error = str(exc)
        usage = getattr(response, "usage", None)
        completion = Completion(
            text=text,
            parsed=parsed,
            parse_error=parse_error,
            tool_calls=tuple(_tool_call(c) for c in choice.message.tool_calls or ()),
            finish_reason=choice.finish_reason,
            latency_ms=latency_ms,
            prompt_tokens=usage.prompt_tokens if usage else None,
            completion_tokens=usage.completion_tokens if usage else None,
            retries=retries,
        )
        # Ids, counts and times only: never the prompt or the answer (C15).
        log.info(
            "llm call: model=%s latency_ms=%d prompt_tokens=%s completion_tokens=%s "
            "tool_calls=%d parsed=%s retries=%d",
            endpoint.model,
            latency_ms,
            completion.prompt_tokens,
            completion.completion_tokens,
            len(completion.tool_calls),
            parse_error is None if schema is not None else "-",
            retries,
        )
        return completion

    # --- what the endpoint offers ------------------------------------------------

    def _root(self) -> str:
        """Ollama's native API sits beside ``/v1``."""
        url = self.endpoint.base_url.rstrip("/")
        return url.removesuffix("/v1")

    def _probe(self, path: str) -> Any:
        """GET a native Ollama path; ``None`` when the endpoint is not an Ollama."""
        try:
            response = self._http.get(self._root() + path, timeout=PROBE_TIMEOUT_S)
        except httpx2.TimeoutException as exc:
            raise LLMError(
                "llm_timeout", "No answer from the endpoint.", cause=_cause(exc)
            ) from None
        except httpx2.HTTPError as exc:
            raise LLMError(
                "llm_unreachable", "The endpoint could not be reached.", cause=_cause(exc)
            ) from None
        if response.status_code != 200:
            return None
        try:
            return response.json()
        except ValueError:
            return None

    def server_version(self) -> str | None:
        body = self._probe("/api/version")
        version = body.get("version") if isinstance(body, dict) else None
        return version if isinstance(version, str) else None

    def models(self) -> list[ModelInfo]:
        page, retries = self._with_retries(self._sdk.models.list)
        data = getattr(page, "data", None)
        if not isinstance(data, list):
            raise LLMError("llm_bad_response", "The model list is not a list.", retries=retries)
        ids = [m.id for m in data]
        extras: dict[str, tuple[str | None, int | None]] = {}
        if self.server_version() is not None:
            tags = self._probe("/api/tags")
            for tag in tags.get("models", []) if isinstance(tags, dict) else []:
                if not isinstance(tag, dict):
                    continue
                entry = (tag.get("digest"), tag.get("size"))
                for key in (tag.get("name"), tag.get("model")):
                    if isinstance(key, str):
                        extras[key] = entry
        return [ModelInfo(i, *extras.get(i, (None, None))) for i in ids]
