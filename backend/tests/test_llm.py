"""The model seam (plan E2.1, WP56): adapter, guards, retries, hosts, fake."""

import ast
import json
import logging
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx2
import openai
import pytest
from llm_stub import HEAD, OllamaStub, chat, dripping, flooding, raw_endpoint

from geotandem.llm import (
    Completion,
    Endpoint,
    LLMError,
    Message,
    ModelInfo,
    ToolSpec,
    classify_host,
    host_of,
    openai_compat,
)
from geotandem.llm.fake import FakeLLMClient
from geotandem.llm.openai_compat import MAX_RESPONSE_BYTES, OpenAICompatClient

SOURCE = Path(__file__).parents[1] / "src" / "geotandem"
ENDPOINT = Endpoint(base_url="http://127.0.0.1:11434/v1", model="qwen3:8b")
ASK = [Message("system", "Du bist ein Test."), Message("user", "Wie viele Schulen?")]


def client(stub: OllamaStub, endpoint: Endpoint = ENDPOINT, **kwargs: Any) -> OpenAICompatClient:
    return OpenAICompatClient(endpoint, transport=stub.transport(), **kwargs)


def error_of(call: Any) -> LLMError:
    with pytest.raises(LLMError) as caught:
        call()
    return caught.value


# --- one importer (C2) -----------------------------------------------------------


def test_only_the_adapter_imports_openai() -> None:
    importers: list[str] = []
    for path in SOURCE.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            names = (
                [a.name for a in node.names]
                if isinstance(node, ast.Import)
                else [node.module or ""]
                if isinstance(node, ast.ImportFrom)
                else []
            )
            importers += [path.name for n in names if n == "openai" or n.startswith("openai.")]
    assert importers == ["openai_compat.py"]


# --- a call ----------------------------------------------------------------------


def test_a_call_sends_the_parameters_and_keeps_what_evaluation_needs() -> None:
    stub = OllamaStub(answers=[chat("Es sind 12.", prompt_tokens=30, completion_tokens=4)])
    with client(stub) as llm:
        answer = llm.complete(ASK)

    [sent] = stub.chat_requests()
    assert sent.body["model"] == "qwen3:8b"
    assert (sent.body["temperature"], sent.body["seed"]) == (0, 42)
    assert sent.body["messages"] == [
        {"role": "system", "content": "Du bist ein Test."},
        {"role": "user", "content": "Wie viele Schulen?"},
    ]
    # Effort "default" sends nothing (C10); no schema, no tools.
    assert {"reasoning_effort", "response_format", "tools"}.isdisjoint(sent.body)
    assert answer.text == "Es sind 12."
    assert (answer.prompt_tokens, answer.completion_tokens) == (30, 4)
    assert (answer.finish_reason, answer.retries, answer.parsed) == ("stop", 0, None)
    assert answer.latency_ms >= 0


def test_an_effort_other_than_default_is_sent() -> None:
    stub = OllamaStub()
    endpoint = Endpoint(**{**ENDPOINT.__dict__, "reasoning_effort": "none", "seed": None})
    with client(stub, endpoint) as llm:
        llm.complete(ASK)
    [sent] = stub.chat_requests()
    assert sent.body["reasoning_effort"] == "none"
    assert "seed" not in sent.body


SCHEMA = {"type": "object", "properties": {"count": {"type": "integer"}}, "required": ["count"]}


def test_schema_output_is_requested_and_parsed_verbatim() -> None:
    stub = OllamaStub(answers=[chat('{"count": 12}'), chat("zwölf")])
    with client(stub) as llm:
        good = llm.complete(ASK, schema=SCHEMA, schema_name="anzahl")
        bad = llm.complete(ASK, schema=SCHEMA)

    format_ = stub.chat_requests()[0].body["response_format"]
    assert format_ == {"type": "json_schema", "json_schema": {"name": "anzahl", "schema": SCHEMA}}
    assert (good.parsed, good.parse_error) == ({"count": 12}, None)
    # A parse failure is an answer, kept verbatim, not an error and not retried.
    assert (bad.text, bad.parsed) == ("zwölf", None)
    assert bad.parse_error is not None and bad.retries == 0
    assert len(stub.chat_requests()) == 2


UNION = {
    "$defs": {
        "A": {"type": "object", "properties": {"kind": {"const": "a"}}},
        "B": {"type": "object", "properties": {"kind": {"const": "b"}}},
    },
    "oneOf": [{"$ref": "#/$defs/A"}, {"$ref": "#/$defs/B"}],
    "discriminator": {"propertyName": "kind"},
}


def refused_format() -> httpx2.Response:
    message = "Invalid schema for response_format 'answer': … Wie viele Schulen?"
    error = {"message": message, "type": "invalid_request_error", "param": "response_format"}
    return httpx2.Response(400, json={"error": error})


@pytest.fixture(autouse=True)
def _no_wrapped_endpoints() -> Iterator[None]:
    openai_compat._WRAPPED.clear()
    openai_compat._TEXT_ONLY.clear()
    yield
    openai_compat._WRAPPED.clear()
    openai_compat._TEXT_ONLY.clear()


def test_a_root_union_goes_as_it_is_where_the_endpoint_takes_it() -> None:
    """Ollama keeps the request it had: wrapping cost gemma4 15 of 330 (X-6)."""
    stub = OllamaStub(answers=[chat('{"kind": "a"}')])
    with client(stub) as llm:
        answer = llm.complete(ASK, schema=UNION)
    assert stub.chat_requests()[0].body["response_format"]["json_schema"]["schema"] == UNION
    assert answer.parsed == {"kind": "a"}


def test_a_refused_root_union_is_sent_again_wrapped_and_stays_wrapped() -> None:
    """OpenAI refuses a root combinator; the reply is unwrapped, and one that
    comes unwrapped anyway is kept."""
    stub = OllamaStub(
        answers=[refused_format(), chat('{"answer": {"kind": "a"}}'), chat('{"kind": "b"}')]
    )
    with client(stub) as llm:
        wrapped = llm.complete(ASK, schema=UNION)
    with client(stub) as llm:  # a new client, as every call builds one (C8)
        plain = llm.complete(ASK, schema=UNION)

    sent = [r.body["response_format"]["json_schema"]["schema"] for r in stub.chat_requests()]
    assert sent[0] == UNION
    assert (
        sent[1]
        == sent[2]
        == {
            "type": "object",
            "properties": {
                "answer": {"oneOf": UNION["oneOf"], "discriminator": UNION["discriminator"]}
            },
            "required": ["answer"],
            "$defs": UNION["$defs"],
        }
    )
    assert (wrapped.parsed, wrapped.text) == ({"kind": "a"}, '{"answer": {"kind": "a"}}')
    assert plain.parsed == {"kind": "b"}


def test_a_format_refused_every_way_is_a_rejection() -> None:
    """Plain, wrapped (the union only), then text only; each refused: given up,
    and nothing is remembered (X-6, X-8)."""
    stub = OllamaStub(answers=[refused_format()] * 5)
    with client(stub) as llm:
        plain = error_of(lambda: llm.complete(ASK, schema=SCHEMA))
        union = error_of(lambda: llm.complete(ASK, schema=UNION))
    assert (plain.code, plain.cause, union.code) == ("llm_rejected", "HTTP 400", "llm_rejected")
    formats = [r.body.get("response_format") is not None for r in stub.chat_requests()]
    assert formats == [True, False, True, True, False]
    assert "Schulen" not in str(plain) + str(union)
    assert not openai_compat._WRAPPED and not openai_compat._TEXT_ONLY


def rejected() -> httpx2.Response:
    """Anthropic's compatibility: a 400 that names no field (X-8)."""
    error = {"type": "invalid_request_error", "message": "json_schema.strict … Wie viele Schulen?"}
    return httpx2.Response(400, json={"error": error})


def test_a_refused_schema_is_sent_again_as_text_only_and_stays_so() -> None:
    fenced = '```json\n{"kind": "a"}\n```'
    stub = OllamaStub(answers=[rejected(), chat(fenced), chat('{"kind": "b"}')])
    with client(stub) as llm:
        first = llm.complete(ASK, schema=UNION)
    with client(stub) as llm:  # a new client, as every call builds one (C8)
        second = llm.complete(ASK, schema=UNION)

    sent = [r.body.get("response_format") for r in stub.chat_requests()]
    assert sent[0] is not None and sent[1] is None and sent[2] is None
    # Not parsed here: parse_answer takes the fence off (X-7).
    assert (first.text, first.parsed, first.retries) == (fenced, None, 0)
    assert second.parsed == {"kind": "b"}


def test_a_400_that_text_only_does_not_cure_changes_nothing() -> None:
    """A 400 for another reason (a temperature the model refuses) is not taken
    for a format the endpoint cannot do."""
    stub = OllamaStub(answers=[rejected(), rejected(), chat('{"count": 1}')])
    with client(stub) as llm:
        error = error_of(lambda: llm.complete(ASK, schema=SCHEMA))
        again = llm.complete(ASK, schema=SCHEMA)
    assert error.code == "llm_rejected"
    assert [r.body.get("response_format") is not None for r in stub.chat_requests()] == [
        True,
        False,
        True,
    ]
    assert again.parsed == {"count": 1}


def test_a_400_without_a_schema_is_not_asked_again() -> None:
    stub = OllamaStub(answers=[rejected()] * 2)
    with client(stub) as llm:
        error = error_of(lambda: llm.complete(ASK))
    assert (error.code, len(stub.chat_requests())) == ("llm_rejected", 1)


def test_tools_are_offered_and_calls_parsed() -> None:
    calls = [
        {"name": "describe_layer", "arguments": '{"layer": "schulen"}'},
        {"name": "run_query", "arguments": "{nicht json"},
    ]
    stub = OllamaStub(answers=[chat(None, tool_calls=calls, finish_reason="tool_calls")])
    tool = ToolSpec("describe_layer", "Describe one layer.", {"type": "object"})
    with client(stub) as llm:
        answer = llm.complete(ASK, tools=[tool])

    assert stub.chat_requests()[0].body["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "describe_layer",
                "description": "Describe one layer.",
                "parameters": {"type": "object"},
            },
        }
    ]
    good, bad = answer.tool_calls
    assert (good.name, good.parsed) == ("describe_layer", {"layer": "schulen"})
    assert (bad.arguments, bad.parsed) == ("{nicht json", None) and bad.parse_error
    assert answer.text == "" and answer.finish_reason == "tool_calls"


def test_a_chain_replays_tool_calls_and_answers() -> None:
    stub = OllamaStub()
    first = chat(None, tool_calls=[{"name": "list_layers", "arguments": "{}"}])
    stub.answers.append(first)
    with client(stub) as llm:
        call = llm.complete(ASK).tool_calls[0]
        llm.complete(
            [
                *ASK,
                Message("assistant", "", tool_calls=(call,)),
                Message("tool", '{"layers": []}', tool_call_id=call.id),
            ]
        )
    replay = stub.chat_requests()[1].body["messages"]
    assert replay[2]["tool_calls"][0]["function"] == {"name": "list_layers", "arguments": "{}"}
    assert replay[3] == {"role": "tool", "content": '{"layers": []}', "tool_call_id": call.id}


# --- retries (C9) ----------------------------------------------------------------


def status(code: int) -> httpx2.Response:
    return httpx2.Response(code, json={"error": {"message": "Wie viele Schulen? (echoed)"}})


def test_transient_failures_are_retried_twice_with_backoff() -> None:
    waits: list[float] = []
    stub = OllamaStub(answers=[status(503), status(429), chat("ok")])
    with client(stub, sleep=waits.append) as llm:
        answer = llm.complete(ASK)
    assert (answer.text, answer.retries, waits) == ("ok", 2, [0.5, 1.0])


@pytest.mark.parametrize(
    "error",
    [
        {"message": "Wie viele Schulen? (echoed)", "type": "insufficient_quota"},
        {"message": "Wie viele Schulen?", "type": "x", "code": "credit_balance_exhausted"},
    ],
)
def test_an_exhausted_balance_is_its_own_code_and_not_retried(error: dict[str, str]) -> None:
    stub = OllamaStub(answers=[httpx2.Response(429, json={"error": error})] * 3)
    with client(stub, sleep=lambda _: None) as llm:
        found = error_of(lambda: llm.complete(ASK))
    assert (found.code, found.retries, len(stub.chat_requests())) == ("llm_quota_exhausted", 0, 1)
    # Only the listed value leaves the body (C13, X-5).
    assert found.cause in ("HTTP 429 insufficient_quota", "HTTP 429 credit_balance_exhausted")
    assert "Schulen" not in str(found)


def test_an_unlisted_error_type_stays_a_rate_limit() -> None:
    body = {"error": {"message": "slow down", "type": "requests", "code": "rate_limit_exceeded"}}
    stub = OllamaStub(answers=[httpx2.Response(429, json=body)] * 3)
    with client(stub, sleep=lambda _: None) as llm:
        found = error_of(lambda: llm.complete(ASK))
    assert (found.code, found.cause) == ("llm_rate_limited", "HTTP 429")


@pytest.mark.parametrize(
    ("first", "code", "attempts"),
    [
        (status(500), "llm_server_error", 3),
        (status(429), "llm_rate_limited", 3),
        (status(408), "llm_rejected", 3),
        (status(400), "llm_rejected", 1),
        (status(401), "llm_unauthorized", 1),
        (status(403), "llm_unauthorized", 1),
        (status(404), "llm_not_found", 1),
        (httpx2.ConnectError("Connection refused"), "llm_unreachable", 3),
        (httpx2.ReadTimeout("timed out"), "llm_timeout", 1),
        (httpx2.Response(200, text="<html>kein JSON</html>"), "llm_bad_response", 1),
    ],
)
def test_failures_map_to_codes_and_only_transient_ones_retry(
    first: Any, code: str, attempts: int
) -> None:
    stub = OllamaStub(answers=[first] * 3)
    with client(stub, sleep=lambda _: None) as llm:
        error = error_of(lambda: llm.complete(ASK))
    assert error.code == code
    assert (len(stub.chat_requests()), error.retries) == (attempts, attempts - 1)
    # The cause is verbatim but never a response body, which may echo the prompt (C13).
    assert "Schulen" not in error.cause and "Schulen" not in str(error)


class Clock:
    """Monotonic time under test control: a slow endpoint and the backoff move it."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.timeouts: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds

    def slow(self, seconds: float, then: httpx2.Response) -> Any:
        """An attempt that takes ``seconds``, or times out after the read timeout it got."""

        def answer(request: httpx2.Request) -> httpx2.Response:
            read = request.extensions["timeout"]["read"]
            self.timeouts.append(read)
            if read < seconds:
                self.now += read
                raise httpx2.ReadTimeout("timed out", request=request)
            self.now += seconds
            return then

        return answer


def test_a_slow_call_and_its_retries_end_by_the_deadline() -> None:
    clock = Clock()
    deadline = clock.now + 50
    stub = OllamaStub(answers=[clock.slow(20, status(503))] * 3)
    with client(stub, sleep=clock.sleep, clock=clock) as llm:
        error = error_of(lambda: llm.complete(ASK, deadline=deadline))
    assert error.code == "llm_timeout"
    # 20 s and a 503, 0.5 s backoff, 20 s and a 503, 1 s backoff, 8.5 s left.
    assert clock.timeouts == [pytest.approx(t) for t in (50, 29.5, 8.5)]
    assert clock.now == pytest.approx(deadline)


def test_no_retry_is_made_past_the_deadline() -> None:
    clock = Clock()
    stub = OllamaStub(answers=[clock.slow(20, status(503)), chat("zu spät")])
    with client(stub, sleep=clock.sleep, clock=clock) as llm:
        error = error_of(lambda: llm.complete(ASK, deadline=clock.now + 20.3))
    assert (error.code, error.retries, len(stub.chat_requests())) == ("llm_server_error", 0, 1)
    assert clock.now <= 1020.3


def test_an_attempt_gets_at_most_the_endpoints_timeout_and_none_after_the_deadline() -> None:
    clock = Clock()
    stub = OllamaStub(answers=[clock.slow(1, httpx2.Response(200, json=chat("ok")))])
    with client(stub, sleep=clock.sleep, clock=clock) as llm:
        assert llm.complete(ASK, deadline=clock.now + 500).text == "ok"
        assert clock.timeouts == [ENDPOINT.timeout_s]
        late = error_of(lambda: llm.complete(ASK, deadline=clock.now))
    assert late.code == "llm_timeout" and len(stub.chat_requests()) == 1


def test_the_fake_honours_the_deadline() -> None:
    fake = FakeLLMClient(script=[Completion(text="a")], clock=lambda: 10.0)
    assert error_of(lambda: fake.complete(ASK, deadline=10.0)).code == "llm_timeout"
    assert fake.complete(ASK, deadline=11.0).text == "a"
    assert [c.deadline for c in fake.calls] == [10.0, 11.0]


# --- bounded in time and size, on a real socket (security review #34) -------------

TRICKLE_S = 2.0
"""The attempt's time in the tests below; the endpoint sends a byte a second."""


@pytest.mark.parametrize(
    "respond",
    [
        dripping(),  # the status line and headers, a byte at a time
        dripping(HEAD + b"Content-Length: 1000\r\n\r\n"),  # the body, a byte at a time
    ],
    ids=["headers", "body"],
)
def test_an_endpoint_that_trickles_ends_by_the_deadline(respond: Any) -> None:
    """Each byte arrives well within the read timeout, so only a deadline over
    the whole request ends the call; without it, it lasts as long as the drip."""
    with raw_endpoint(respond) as base_url:
        endpoint = Endpoint(base_url=base_url, model="m", timeout_s=TRICKLE_S)
        started = time.monotonic()
        with OpenAICompatClient(endpoint) as llm:
            error = error_of(lambda: llm.complete(ASK, deadline=started + TRICKLE_S))
        took = time.monotonic() - started
    assert (error.code, error.retries) == ("llm_timeout", 0)
    assert TRICKLE_S - 0.5 <= took < TRICKLE_S + 1.5


def test_an_attempt_without_a_call_deadline_ends_by_the_endpoints_timeout() -> None:
    with raw_endpoint(dripping()) as base_url:
        endpoint = Endpoint(base_url=base_url, model="m", timeout_s=TRICKLE_S)
        started = time.monotonic()
        with OpenAICompatClient(endpoint) as llm:
            assert error_of(lambda: llm.models()).code == "llm_timeout"
    assert time.monotonic() - started < TRICKLE_S + 1.5


@pytest.mark.parametrize("length", [False, True], ids=["streamed", "declared"])
def test_an_answer_past_the_cap_is_refused(length: bool) -> None:
    """Read in chunks and given up past the cap, not read whole first; a length
    declared beyond it is refused before the body. Not retried."""
    seen: list[int] = []
    flood = flooding(MAX_RESPONSE_BYTES * 4, length=length)

    def respond(out: Any) -> None:
        seen.append(1)
        flood(out)

    with raw_endpoint(respond) as base_url:
        endpoint = Endpoint(base_url=base_url, model="m", timeout_s=30)
        with OpenAICompatClient(endpoint, sleep=lambda _: None) as llm:
            error = error_of(lambda: llm.complete(ASK, deadline=time.monotonic() + 30))
    assert (error.code, error.cause, error.retries, len(seen)) == (
        "llm_bad_response",
        "too large",
        0,
        1,
    )


def test_an_answer_at_the_cap_is_read() -> None:
    body = json.dumps(chat("ok")).encode()
    padded = body[:-1] + b" " * (MAX_RESPONSE_BYTES - len(body)) + b"}"
    stub = OllamaStub(answers=[httpx2.Response(200, content=padded)])
    with client(stub) as llm:
        assert llm.complete(ASK).text == "ok"
    over = OllamaStub(answers=[httpx2.Response(200, content=padded + b" ")])
    with client(over) as llm:
        assert error_of(lambda: llm.complete(ASK)).cause == "too large"


def test_an_answer_is_asked_for_uncompressed_and_a_compressed_one_refused() -> None:
    """A compressed answer could decode to far more than the cap."""
    gzipped = httpx2.Response(200, content=bytes([31, 139]), headers={"Content-Encoding": "gzip"})
    stub = OllamaStub(answers=[gzipped])
    with client(stub) as llm:
        error = error_of(lambda: llm.complete(ASK))
    assert (error.code, error.cause) == ("llm_bad_response", "compressed")
    assert stub.seen[0].headers["accept-encoding"] == "identity"


def test_a_redirect_is_refused_not_followed() -> None:
    elsewhere = httpx2.Response(
        307, headers={"Location": "http://evil.example/v1/chat/completions"}
    )
    stub = OllamaStub(answers=[elsewhere])
    with client(stub) as llm:
        assert error_of(lambda: llm.complete(ASK)).code == "llm_redirect"
    assert [s.path for s in stub.seen] == ["/v1/chat/completions"]


# --- headers ---------------------------------------------------------------------


def test_only_our_headers_leave(monkeypatch: pytest.MonkeyPatch) -> None:
    """The SDK adds org, project and custom headers from the environment to any
    endpoint; the guard strips them. Positive control: an unguarded SDK client."""
    monkeypatch.setenv("OPENAI_ORG_ID", "org-geheim")
    monkeypatch.setenv("OPENAI_PROJECT_ID", "proj-geheim")
    monkeypatch.setenv("OPENAI_CUSTOM_HEADERS", "X-Leak: 1\nAuthorization: Bearer fremd")

    control = OllamaStub()
    unguarded = openai.OpenAI(
        base_url=ENDPOINT.base_url,
        api_key="sk-test",
        http_client=httpx2.Client(transport=control.transport()),
        max_retries=0,
    )
    unguarded.models.list()
    leaked = control.seen[0].headers
    assert leaked["openai-organization"] == "org-geheim" and leaked["x-leak"] == "1"

    stub = OllamaStub()
    keyed = Endpoint(**{**ENDPOINT.__dict__, "api_key": "sk-unser"})
    with client(stub, keyed) as llm:
        llm.complete(ASK)
    with client(stub) as llm:
        llm.models()
    with_key, without_key = stub.seen[0].headers, stub.seen[1].headers
    assert with_key["authorization"] == "Bearer sk-unser"
    assert "authorization" not in without_key
    for headers in (with_key, without_key):
        assert set(headers) <= {
            "accept", "accept-encoding", "anthropic-version", "authorization",
            "content-type", "content-length", "host", "user-agent",
        }  # fmt: skip
        # Anthropic's model list needs it; every other endpoint ignores it (X-9).
        assert headers["anthropic-version"] == "2023-06-01"


# --- what the endpoint offers (C3) -----------------------------------------------


def test_ollama_adds_version_digest_and_size() -> None:
    stub = OllamaStub(models={"qwen3:8b": ("sha256:abc", 5), "gemma3:4b": ("sha256:def", 3)})
    with client(stub) as llm:
        assert llm.server_version() == "0.12.3"
        assert llm.models() == [
            ModelInfo("qwen3:8b", "sha256:abc", 5),
            ModelInfo("gemma3:4b", "sha256:def", 3),
        ]


def test_another_endpoint_lists_models_without_extras() -> None:
    stub = OllamaStub(version=None)
    endpoint = Endpoint(base_url="http://127.0.0.1:8000/v1", model="qwen3:8b")
    with client(stub, endpoint) as llm:
        assert llm.server_version() is None
        assert llm.models() == [ModelInfo("qwen3:8b")]


# --- logs (C15) ------------------------------------------------------------------


def test_logs_hold_counts_never_prompts_or_answers(caplog: pytest.LogCaptureFixture) -> None:
    stub = OllamaStub(answers=[chat("Geheime Antwort"), status(400)])
    with caplog.at_level(logging.INFO, logger="geotandem.llm"), client(stub) as llm:
        llm.complete(ASK)
        error_of(lambda: llm.complete(ASK))
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "model=qwen3:8b" in text and "code=llm_rejected" in text
    assert "Schulen" not in text and "Geheime" not in text and "Du bist" not in text


# --- the real transport: proxy variables (C9) -------------------------------------


class Recorder(BaseHTTPRequestHandler):
    seen: list[tuple[str, str]]

    def do_GET(self) -> None:
        self.seen.append((self.path, self.headers.get("Authorization", "")))
        body = json.dumps({"object": "list", "data": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_: Any) -> None:
        pass


def serve() -> tuple[ThreadingHTTPServer, list[tuple[str, str]]]:
    seen: list[tuple[str, str]] = []
    handler = type("Handler", (Recorder,), {"seen": seen})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, seen


@pytest.fixture
def servers() -> Iterator[tuple[str, list[tuple[str, str]], str, list[tuple[str, str]]]]:
    endpoint, at_endpoint = serve()
    proxy, at_proxy = serve()
    yield (
        f"http://127.0.0.1:{endpoint.server_port}",
        at_endpoint,
        f"http://127.0.0.1:{proxy.server_port}",
        at_proxy,
    )
    endpoint.shutdown()
    proxy.shutdown()


def test_proxy_variables_are_ignored(
    servers: tuple[str, list[tuple[str, str]], str, list[tuple[str, str]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """httpx2 reads no .netrc unless asked (``NetRCAuth``), so proxies are the vector."""
    endpoint, at_endpoint, proxy, at_proxy = servers
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    for name in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.setenv(name, proxy)

    # Positive control: a client trusting the environment goes through the proxy.
    with httpx2.Client() as trusting:
        trusting.get(f"{endpoint}/v1/models")
    assert len(at_proxy) == 1 and at_endpoint == []

    at_proxy.clear()
    with OpenAICompatClient(Endpoint(base_url=f"{endpoint}/v1", model="m")) as llm:
        llm.models()
    assert at_proxy == []
    assert at_endpoint == [("/v1/models", ""), ("/api/version", "")]


# --- hosts (C5) ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "locality"),
    [
        ("http://127.0.0.1:11434/v1", "local"),
        ("http://[::1]:11434/v1", "local"),
        ("http://LOCALHOST:8000/v1", "local"),
        ("http://host.docker.internal:11434/v1", "local"),
        ("http://gpu-01.intern:11434/v1", "local"),
        ("http://gpu-02.intern:11434/v1", "external"),
        ("https://api.openai.com/v1", "external"),
        ("http://127.0.0.2:11434/v1", "external"),
        ("http://localhost.evil.example/v1", "external"),
    ],
)
def test_locality_is_the_host_compared_literally(url: str, locality: str) -> None:
    assert classify_host(url, ["GPU-01.intern ", ""]) == locality


@pytest.mark.parametrize(
    "url",
    [
        "ftp://127.0.0.1/v1",
        "127.0.0.1:11434/v1",
        "http:///v1",
        "http://anna:geheim@127.0.0.1/v1",
        "http://127.0.0.1:99999/v1",
        "http://127.0.0.1/v1?key=x",
    ],
)
def test_malformed_urls_are_refused(url: str) -> None:
    assert error_of(lambda: host_of(url)).code == "llm_invalid_url"


# --- the fake --------------------------------------------------------------------


def test_the_fake_answers_from_its_script_and_records() -> None:
    fake = FakeLLMClient(script=[Completion(text="a"), LLMError("llm_timeout", "slow")])
    assert fake.complete(ASK).text == "a"
    assert error_of(lambda: fake.complete(ASK, schema=SCHEMA)).code == "llm_timeout"
    assert [c.schema for c in fake.calls] == [None, SCHEMA]
    with pytest.raises(AssertionError):
        fake.complete(ASK)
