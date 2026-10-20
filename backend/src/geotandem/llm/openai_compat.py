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
- A call's ``deadline`` bounds all its attempts together: each gets only the
  time left (at most the endpoint's timeout), and a retry whose backoff would
  end past the deadline is not made.
- Bounded in time and size (security review #34). An attempt's timeout is a
  wall-clock limit for the whole request, not only for each read: every
  socket operation gets the time left before it (``_DeadlineBackend``), so an
  endpoint that trickles its headers or body a byte at a time ends
  ``llm_timeout`` by then. An answer is read in chunks and ends
  ``llm_bad_response`` (``cause`` "too large") past ``MAX_RESPONSE_BYTES``;
  it is asked for uncompressed, and a compressed one is refused, so the limit
  is what is decoded too.
- An exhausted balance is ``llm_quota_exhausted``, not retried. The error body
  is read for its ``type`` and ``code`` fields only, each compared against
  ``QUOTA_CODES``; nothing else of it goes further (C13, X-5).
- A schema whose root is not a plain object (the answer union is a ``oneOf``)
  goes as it is first. Only when the endpoint refuses it (400 naming
  ``param: response_format``, OpenAI) is it sent again wrapped as
  ``{"answer": …}``, and from then on wrapped for that endpoint and model.
  Wrapping for every endpoint cost gemma4:12b 15 of 330 answers, so Ollama
  keeps the request it had. The reply is unwrapped; one that came unwrapped
  is taken as it is (X-6).
"""

import json
import logging
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from typing import Any, Final, Self

# httpx2's own transport layer, same release line (httpx2 pins it).
import httpcore2
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
QUOTA_CODES = frozenset(
    {"insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached"}
)
"""Error ``type`` or ``code`` values meaning the account has no balance left
(OpenAI sends them with 429). Asking again cannot help."""
WRAP_KEY = "answer"
_WRAPPED: set[tuple[str, str]] = set()
"""Endpoints (base URL, model) that refused a root combinator: wrapped from
then on, for the life of the process. Clients are built per call (C8)."""
_COMBINATORS = ("oneOf", "anyOf", "allOf", "enum", "const", "not")
CONNECT_TIMEOUT_S = 5.0
PROBE_TIMEOUT_S = 5.0

MAX_RESPONSE_BYTES: Final = 1024 * 1024
"""What one answer of an endpoint may hold, headers aside (review #34). A
direct query's answer is a few kilobytes; the cap is far above it."""

_SENT_HEADERS = frozenset(
    {"accept", "accept-encoding", "content-type", "content-length", "host", "user-agent"}
)


class _FormatRefused(Exception):
    """A 400 that names ``response_format``: ``complete`` may wrap and ask again."""


class _Refused(Exception):
    """The endpoint's answer is refused before it is read whole: larger than
    ``MAX_RESPONSE_BYTES``, or compressed. Raised inside the transport; the SDK
    lets it pass, ``_with_retries`` makes it ``llm_bad_response``."""

    def __init__(self, cause: str) -> None:
        super().__init__(cause)
        self.cause = cause


class _Deadline(threading.local):
    """The wall-clock end (``clock()``) of the request this thread sends now;
    ``None``: none. Set by ``_Bounded`` for each request, read by every socket
    operation of it."""

    def __init__(self, clock: Callable[[], float]) -> None:
        self.clock = clock
        self.at: float | None = None

    def clamp(self, timeout: float | None, expired: type[Exception]) -> float | None:
        """``timeout``, at most the time left; ``expired`` once none is left."""
        if self.at is None:
            return timeout
        left = self.at - self.clock()
        if left <= 0:
            raise expired("deadline passed")
        return left if timeout is None else min(timeout, left)


class _DeadlineStream(httpcore2.NetworkStream):
    """A connection whose every read and write ends by the request's deadline."""

    def __init__(self, inner: httpcore2.NetworkStream, deadline: _Deadline) -> None:
        self._inner = inner
        self._deadline = deadline

    def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        return self._inner.read(max_bytes, self._deadline.clamp(timeout, httpcore2.ReadTimeout))

    def write(self, buffer: bytes, timeout: float | None = None) -> None:
        self._inner.write(buffer, self._deadline.clamp(timeout, httpcore2.WriteTimeout))

    def close(self) -> None:
        self._inner.close()

    def start_tls(
        self,
        ssl_context: Any,
        server_hostname: str | None = None,
        timeout: float | None = None,
    ) -> httpcore2.NetworkStream:
        upgraded = self._inner.start_tls(
            ssl_context, server_hostname, self._deadline.clamp(timeout, httpcore2.ConnectTimeout)
        )
        return _DeadlineStream(upgraded, self._deadline)

    def get_extra_info(self, info: str) -> Any:
        return self._inner.get_extra_info(info)


class _DeadlineBackend(httpcore2.NetworkBackend):
    """Sockets as httpx2 opens them, each operation bounded by the deadline."""

    def __init__(self, deadline: _Deadline) -> None:
        self._inner = httpcore2.SyncBackend()
        self._deadline = deadline

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore2.NetworkStream:
        stream = self._inner.connect_tcp(
            host,
            port,
            self._deadline.clamp(timeout, httpcore2.ConnectTimeout),
            local_address,
            socket_options,
        )
        return _DeadlineStream(stream, self._deadline)

    def sleep(self, seconds: float) -> None:
        self._inner.sleep(seconds)


def _network(deadline: _Deadline) -> httpx2.HTTPTransport:
    """httpx2's transport, as ``httpx2.Client(trust_env=False)`` builds it, over
    sockets bounded by ``deadline``. ``HTTPTransport`` takes no network backend,
    so its pool is replaced by one that has it (the deadline tests use real
    sockets and fail if this stops working)."""
    transport = httpx2.HTTPTransport(trust_env=False)
    transport._pool = httpcore2.ConnectionPool(
        ssl_context=httpx2.create_ssl_context(trust_env=False),
        network_backend=_DeadlineBackend(deadline),
    )
    return transport


class _Capped(httpx2.SyncByteStream):
    """An answer's body in the chunks it arrives in, up to ``MAX_RESPONSE_BYTES``."""

    def __init__(self, inner: httpx2.SyncByteStream) -> None:
        self._inner = inner

    def __iter__(self) -> Iterator[bytes]:
        seen = 0
        for chunk in self._inner:
            seen += len(chunk)
            if seen > MAX_RESPONSE_BYTES:
                raise _Refused("too large")
            yield chunk

    def close(self) -> None:
        self._inner.close()


class _Bounded(httpx2.BaseTransport):
    """Every request of the client: its timeout is a wall-clock deadline for the
    whole request (``_Deadline``), its answer is capped (``_Capped``)."""

    def __init__(self, inner: httpx2.BaseTransport, deadline: _Deadline) -> None:
        self._inner = inner
        self._deadline = deadline

    def handle_request(self, request: httpx2.Request) -> httpx2.Response:
        # The attempt's whole time (``_attempt_timeout`` sets read = total).
        limit = request.extensions.get("timeout", {}).get("read")
        self._deadline.at = None if limit is None else self._deadline.clock() + limit
        response = self._inner.handle_request(request)
        encoding = response.headers.get("content-encoding", "identity").strip().lower()
        length = response.headers.get("content-length", "")
        refused = (
            "compressed"
            if encoding not in ("", "identity")
            else "too large"
            if length.isdigit() and int(length) > MAX_RESPONSE_BYTES
            else None
        )
        if refused is not None:
            response.close()
            raise _Refused(refused)
        assert isinstance(response.stream, httpx2.SyncByteStream)
        return httpx2.Response(
            status_code=response.status_code,
            headers=response.headers,
            stream=_Capped(response.stream),
            extensions=response.extensions,
        )

    def close(self) -> None:
        self._inner.close()


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


def _quota(exc: openai.APIStatusError) -> str | None:
    """The ``QUOTA_CODES`` value the error names, else ``None``; only the
    body's ``type`` and ``code`` are looked at, and only a listed value leaves."""
    for value in (getattr(exc, "type", None), getattr(exc, "code", None)):
        if isinstance(value, str) and value in QUOTA_CODES:
            return value
    return None


def _needs_wrap(schema: dict[str, Any]) -> bool:
    return schema.get("type") != "object" or any(k in schema for k in _COMBINATORS)


def _wrapped(schema: dict[str, Any]) -> dict[str, Any]:
    """``schema`` as the one property of an object; ``$defs`` stay at the root,
    so every ``#/$defs/…`` reference resolves as before."""
    inner = {k: v for k, v in schema.items() if k != "$defs"}
    wrapper: dict[str, Any] = {
        "type": "object",
        "properties": {WRAP_KEY: inner},
        "required": [WRAP_KEY],
    }
    if "$defs" in schema:
        wrapper["$defs"] = schema["$defs"]
    return wrapper


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
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.endpoint = endpoint
        self._sleep = sleep
        self._clock = clock
        timeout = httpx2.Timeout(
            endpoint.timeout_s, connect=min(endpoint.timeout_s, CONNECT_TIMEOUT_S)
        )
        deadline = _Deadline(clock)
        self._http = httpx2.Client(
            trust_env=False,
            follow_redirects=False,
            timeout=timeout,
            # A transport given (tests) is bounded in size; the network one in time too.
            transport=_Bounded(transport or _network(deadline), deadline),
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
        # Uncompressed: the size limit is what is read and what is decoded (#34).
        request.headers["Accept-Encoding"] = "identity"

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    # --- calls -------------------------------------------------------------------

    def _attempt_timeout(self, deadline: float | None, retries: int) -> httpx2.Timeout | None:
        """What the next attempt may take: the endpoint's timeout, at most the
        time left before ``deadline``; ``None``: the client's default."""
        if deadline is None:
            return None
        left = deadline - self._clock()
        if left <= 0:
            raise LLMError(
                "llm_timeout",
                "No answer before the call's time limit.",
                cause="deadline passed",
                retries=retries,
            )
        total = min(self.endpoint.timeout_s, left)
        return httpx2.Timeout(total, connect=min(total, CONNECT_TIMEOUT_S))

    def _with_retries[T](
        self, call: Callable[[httpx2.Timeout | None], T], deadline: float | None = None
    ) -> tuple[T, int]:
        retries = 0
        while True:
            timeout = self._attempt_timeout(deadline, retries)
            try:
                return call(timeout), retries
            except _Refused as exc:
                # Not retried: the same endpoint would send the same again.
                raise LLMError(
                    "llm_bad_response",
                    "The endpoint's answer is too large or compressed.",
                    cause=exc.cause,
                    retries=retries,
                ) from None
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
                if (quota := _quota(exc)) is not None:
                    raise LLMError(
                        "llm_quota_exhausted",
                        "The endpoint's account has no balance left.",
                        cause=f"HTTP {exc.status_code} {quota}",
                        retries=retries,
                    ) from None
                if exc.status_code == 400 and getattr(exc, "param", None) == "response_format":
                    raise _FormatRefused from None
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
            backoff = 0.5 * 2**retries
            if deadline is not None and self._clock() + backoff >= deadline:
                raise error from None  # no time left for another attempt
            retries += 1
            self._sleep(backoff)

    def complete(
        self,
        messages: Sequence[Message],
        *,
        schema: dict[str, Any] | None = None,
        schema_name: str = "answer",
        tools: Sequence[ToolSpec] = (),
        deadline: float | None = None,
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
        key = (endpoint.base_url, endpoint.model)
        wrap = schema is not None and _needs_wrap(schema) and key in _WRAPPED

        def format_(wrapped: bool) -> dict[str, Any]:
            assert schema is not None
            return {
                "type": "json_schema",
                "json_schema": {
                    "name": schema_name,
                    "schema": _wrapped(schema) if wrapped else schema,
                },
            }

        if schema is not None:
            request["response_format"] = format_(wrap)
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

        def create(timeout: httpx2.Timeout | None) -> Any:
            if timeout is None:
                return self._sdk.chat.completions.create(**request)
            return self._sdk.chat.completions.create(**request, timeout=timeout)

        started = self._clock()
        try:
            try:
                response, retries = self._with_retries(create, deadline)
            except _FormatRefused:
                if schema is None or wrap or not _needs_wrap(schema):
                    raise _status_error(400, 0) from None
                _WRAPPED.add(key)
                wrap = True
                request["response_format"] = format_(True)
                try:
                    response, retries = self._with_retries(create, deadline)
                except _FormatRefused:
                    raise _status_error(400, 0) from None
        except LLMError as exc:
            log.info(
                "llm call failed: model=%s code=%s retries=%d",
                endpoint.model,
                exc.code,
                exc.retries,
            )
            raise
        latency_ms = round((self._clock() - started) * 1000)

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
            if wrap and isinstance(parsed, dict) and parsed.keys() == {WRAP_KEY}:
                parsed = parsed[WRAP_KEY]
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
        except _Refused as exc:
            raise LLMError(
                "llm_bad_response", "The endpoint's answer is too large.", cause=exc.cause
            ) from None
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
        page, retries = self._with_retries(lambda _: self._sdk.models.list())
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
