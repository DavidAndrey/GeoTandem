"""The model seam (plan E2.1, WP56): adapter, guards, retries, hosts, fake."""

import ast
import json
import logging
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx2
import openai
import pytest
from llm_stub import OllamaStub, chat

from geotandem.llm import (
    Completion,
    Endpoint,
    LLMError,
    Message,
    ModelInfo,
    ToolSpec,
    classify_host,
    host_of,
)
from geotandem.llm.fake import FakeLLMClient
from geotandem.llm.openai_compat import OpenAICompatClient

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
            "accept", "accept-encoding", "authorization", "content-type",
            "content-length", "host", "user-agent",
        }  # fmt: skip


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
