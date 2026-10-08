"""The connection test (plan E2.1, C12, C13): each step and its code."""

from dataclasses import replace
from typing import Any

import httpx
import httpx2
import pytest
from api_helpers import Events, sign_in_as
from fastapi import FastAPI
from llm_stub import OllamaStub, chat

from geotandem.connection_check import SCHEMA_PROMPT, TOOL_PROMPT, CheckResult, run_check
from geotandem.llm import Endpoint
from geotandem.llm.openai_compat import OpenAICompatClient

ENDPOINT = Endpoint(base_url="http://127.0.0.1:11434/v1", model="qwen3:8b", timeout_s=120)
GOOD = [
    chat('{"result": 5}'),
    chat(None, tool_calls=[{"name": "weekday_of", "arguments": '{"date": "2026-10-08"}'}]),
]


def factory(stub: OllamaStub, built: list[Endpoint] | None = None) -> Any:
    def make(endpoint: Endpoint) -> OpenAICompatClient:
        if built is not None:
            built.append(endpoint)
        return OpenAICompatClient(endpoint, transport=stub.transport(), sleep=lambda _: None)

    return make


def check(stub: OllamaStub, endpoint: Endpoint = ENDPOINT, **kwargs: Any) -> CheckResult:
    return run_check(endpoint, factory(stub), **kwargs)


def outline(result: CheckResult) -> list[tuple[str, str, str | None]]:
    return [(s.name, s.status, s.code) for s in result.steps]


def test_a_capable_ollama_is_green() -> None:
    built: list[Endpoint] = []
    stub = OllamaStub(answers=list(GOOD))
    result = run_check(ENDPOINT, factory(stub, built))
    assert result.ok
    assert [(s.name, s.status) for s in result.steps] == [
        ("url", "ok"),
        ("reachable", "ok"),
        ("authorised", "ok"),
        ("model", "ok"),
        ("server", "ok"),
        ("json_schema", "ok"),
        ("tool_call", "ok"),
    ]
    by_name = {s.name: s for s in result.steps}
    assert by_name["model"].details == {"digest": "sha256:abc", "size": 5_200_000_000}
    assert by_name["server"].details == {"ollama": "0.12.3"}
    # Reachability is capped at 5 s, generation at min(timeout, 60 s).
    assert [e.timeout_s for e in built] == [5.0, 60.0]


def test_only_synthetic_prompts_leave() -> None:
    stub = OllamaStub(answers=list(GOOD))
    check(stub)
    sent = [r.body["messages"] for r in stub.chat_requests()]
    assert sent == [
        [{"role": "user", "content": SCHEMA_PROMPT}],
        [{"role": "user", "content": TOOL_PROMPT}],
    ]


def test_another_endpoint_without_ollama_extras_is_green() -> None:
    result = check(OllamaStub(answers=list(GOOD), version=None))
    assert result.ok
    assert ("server", "skipped", None) in outline(result)


def failing(result: CheckResult) -> tuple[str, str | None]:
    assert not result.ok
    failed = [s for s in result.steps if s.status == "failed"]
    assert len(failed) == 1
    after = result.steps[result.steps.index(failed[0]) + 1 :]
    assert all(s.status == "skipped" for s in after)
    return failed[0].name, failed[0].code


@pytest.mark.parametrize(
    ("stub", "endpoint", "step", "code"),
    [
        (OllamaStub(), replace(ENDPOINT, base_url="ftp://x/v1"), "url", "llm_invalid_url"),
        (
            OllamaStub(models_answer=httpx2.ConnectError("Connection refused")),
            ENDPOINT,
            "reachable",
            "llm_unreachable",
        ),
        (
            OllamaStub(models_answer=httpx2.ConnectTimeout("timed out")),
            ENDPOINT,
            "reachable",
            "llm_timeout",
        ),
        (
            OllamaStub(models_answer=httpx2.Response(307, headers={"Location": "http://x/"})),
            ENDPOINT,
            "reachable",
            "llm_redirect",
        ),
        (
            OllamaStub(models_answer=httpx2.Response(401, json={"error": "nope"})),
            ENDPOINT,
            "authorised",
            "llm_unauthorized",
        ),
        (OllamaStub(), replace(ENDPOINT, model="llama9:70b"), "model", "llm_model_missing"),
        (
            OllamaStub(answers=[httpx2.Response(400, json={"error": "response_format"})]),
            ENDPOINT,
            "json_schema",
            "llm_schema_unsupported",
        ),
        (
            OllamaStub(answers=[httpx2.Response(401, json={"error": "nope"})]),
            ENDPOINT,
            "json_schema",
            "llm_unauthorized",
        ),
        (
            OllamaStub(answers=[GOOD[0], httpx2.Response(400, json={"error": "no tools"})]),
            ENDPOINT,
            "tool_call",
            "llm_tools_unsupported",
        ),
        (OllamaStub(answers=[chat("fünf")]), ENDPOINT, "json_schema", "llm_schema_unsupported"),
        (
            OllamaStub(answers=[chat('{"result": "5"}')]),
            ENDPOINT,
            "json_schema",
            "llm_schema_unsupported",
        ),
        (
            OllamaStub(answers=[GOOD[0], chat("Donnerstag")]),
            ENDPOINT,
            "tool_call",
            "llm_tools_unsupported",
        ),
        (
            OllamaStub(answers=[GOOD[0], httpx2.ReadTimeout("slow")]),
            ENDPOINT,
            "tool_call",
            "llm_timeout",
        ),
    ],
)
def test_each_step_fails_with_its_code(
    stub: OllamaStub, endpoint: Endpoint, step: str, code: str
) -> None:
    assert failing(check(stub, endpoint)) == (step, code)


def test_a_reachable_step_after_401_is_still_ok() -> None:
    stub = OllamaStub(models_answer=httpx2.Response(401, json={"error": "nope"}))
    assert ("reachable", "ok", None) in outline(check(stub))


def test_a_missing_model_names_what_is_offered() -> None:
    result = check(OllamaStub(), replace(ENDPOINT, model="llama9:70b"))
    model = next(s for s in result.steps if s.name == "model")
    assert model.details == {"model": "llama9:70b", "offered": ["qwen3:8b"]}


def test_an_unreadable_key_breaks_authorisation() -> None:
    result = check(OllamaStub(answers=list(GOOD)), credentials_unreadable=True)
    assert failing(result) == ("authorised", "credentials_unreadable")


def test_no_response_body_is_echoed() -> None:
    echo = httpx2.Response(500, json={"error": "secret-internal-detail at /srv/x"})
    result = check(OllamaStub(answers=[echo] * 3))
    assert "secret-internal-detail" not in result.model_dump_json()


# --- over HTTP ---------------------------------------------------------------------


URL = "/api/admin/llm/connections"
LOCAL = {"base_url": "http://127.0.0.1:11434/v1", "model": "qwen3:8b"}


def use_stub(app: FastAPI, stub: OllamaStub) -> None:
    app.state.geotandem.client_factory = factory(stub)


async def test_a_saved_connection_keeps_its_latest_test(
    client: httpx.AsyncClient, app: FastAPI, events: Events
) -> None:
    created = (await client.post(URL, json={"name": "Ollama", **LOCAL})).json()
    use_stub(app, OllamaStub(answers=list(GOOD)))
    response = await client.post(f"{URL}/{created['id']}/test")
    assert response.status_code == 200 and response.json()["ok"] is True
    stored = (await client.get(f"{URL}/{created['id']}")).json()["last_test"]
    assert stored["ok"] is True and len(stored["steps"]) == 7

    [event] = [e for e in events if e["event"] == "llm_connection_tested"]
    assert (event["id"], event["host"], event["ok"], event["code"]) == (
        created["id"],
        "127.0.0.1",
        True,
        None,
    )


async def test_a_failing_test_is_still_200(client: httpx.AsyncClient, app: FastAPI) -> None:
    created = (await client.post(URL, json={"name": "Ollama", **LOCAL})).json()
    use_stub(app, OllamaStub(models_answer=httpx2.ConnectError("refused")))
    response = await client.post(f"{URL}/{created['id']}/test")
    assert response.status_code == 200
    assert response.json()["ok"] is False


async def test_a_draft_is_tested_and_not_kept(client: httpx.AsyncClient, app: FastAPI) -> None:
    stub = OllamaStub(answers=list(GOOD))
    use_stub(app, stub)
    response = await client.post(f"{URL}/test", json={**LOCAL, "api_key": "sk-entwurf"})
    assert response.json()["ok"] is True
    assert stub.seen[0].headers["authorization"] == "Bearer sk-entwurf"
    assert (await client.get(URL)).json() == []


async def test_a_draft_of_a_saved_connection_reuses_its_key(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    body = {"name": "Cloud", **LOCAL, "api_key": "sk-gespeichert"}
    created = (await client.post(URL, json=body)).json()
    stub = OllamaStub(answers=list(GOOD))
    use_stub(app, stub)
    draft = {**LOCAL, "model": "qwen3:8b", "connection_id": created["id"]}
    assert (await client.post(f"{URL}/test", json=draft)).json()["ok"] is True
    assert stub.seen[0].headers["authorization"] == "Bearer sk-gespeichert"


async def test_only_administrators_test(client: httpx.AsyncClient) -> None:
    await sign_in_as(client, "m.keller")
    assert (await client.post(f"{URL}/test", json=LOCAL)).status_code == 403
