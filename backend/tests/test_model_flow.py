"""The prompt flow of the direct query (plan E2.3-E2.6, WP65).

Through the API, with the model faked behind the client factory and scripted
from the contract fixture: every case ends in its status and code, the 202
leaves while the model thinks, abort drops a late answer and keeps a queued
call from the model, one prompt per account and a bounded number of calls run
at once, the request limit counts per connection and day (P5), each level
governs the answer (WP70), another account's record does not exist, and no
log line holds the prompt.

The model call runs in a thread of ``ModelCalls``, after the 202: a test waits
for it with ``settle`` (``ModelCalls.wait``), and one that must see the record
while the model thinks holds the model on an event. Nothing sleeps.
"""

import asyncio
import json
import logging
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone
from typing import Annotated, Any

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, USER_PASSWORD, Events, sign_in, sign_in_as
from fastapi import Depends, FastAPI
from llm_stub import OllamaStub, chat
from model_fixtures import REPO, case, cases, completion, fixture
from pydantic import TypeAdapter
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from geotandem.api.model import prompt_flow
from geotandem.api.state import AppState, get_state
from geotandem.app import start
from geotandem.auth import accounts
from geotandem.auth.accounts import Account
from geotandem.auth.visibility import set_visible
from geotandem.config import Settings
from geotandem.data import DataBackend
from geotandem.db.bootstrap import bootstrap
from geotandem.db.orm import ModelAction
from geotandem.importing.run import FieldDecision, ImportDecisions, KeyReference, run_import
from geotandem.levels import CellMode, OpClass, active_level
from geotandem.llm import Completion, Endpoint, Message, ModelInfo, ToolSpec
from geotandem.llm.fake import FakeLLMClient
from geotandem.llm.openai_compat import OpenAICompatClient
from geotandem.model.record import (
    ModelActionStore,
    NewAction,
    level_snapshot,
    text_hash,
    utc_now,
)
from geotandem.model.schemas import MAX_TURNS, ConnectionSnapshot, LevelSnapshot, ModelAnswer
from geotandem.model.service import (
    MODEL_CALL_S,
    STALE_MARGIN_S,
    ModelCalls,
    PromptFlow,
    day_start,
    profile_for,
)
from geotandem.sample import DATA_DIR
from geotandem_query import QueryObject, compact

PROMPT = "/api/model/prompt"
CONNECTIONS = "/api/admin/llm/connections"
LOCAL = {"base_url": "http://127.0.0.1:11434/v1", "model": "qwen3:8b"}
REFERENCE = json.loads((REPO / "e2e/fixtures/reference-question.json").read_text("utf-8"))
ANSWER = TypeAdapter[Any](ModelAnswer)

Body = dict[str, Any]
Users = Callable[[int], Awaitable[list[httpx.AsyncClient]]]


def same_answer(stored: Body | None, case_id: str) -> bool:
    """The record keeps the model's answer (defaults filled in) as the case has it."""
    return stored is not None and ANSWER.validate_python(stored) == ANSWER.validate_python(
        case(case_id)["answer"]
    )


def canonical(data: Any) -> str:
    """JSON with sorted keys, nothing else normalised."""
    return json.dumps(data, sort_keys=True, ensure_ascii=False)


def action_url(action_id: int, step: str = "") -> str:
    return f"/api/model/actions/{action_id}" + (f"/{step}" if step else "")


class Model:
    """The model behind the client factory: answers the scripted cases in order.
    ``released`` cleared holds every call until it is set again, so a test sees
    the record while the model thinks; ``asked`` tells that a call came."""

    def __init__(self, app: FastAPI) -> None:
        self.app = app
        self.fake = FakeLLMClient()
        self.endpoints: list[Endpoint] = []
        self.asked = threading.Event()
        self.released = threading.Event()
        self.released.set()
        self.connection: Body = {}

    def __call__(self, endpoint: Endpoint) -> "Model":
        self.endpoints.append(endpoint)
        return self

    def script(self, *case_ids: str) -> None:
        self.fake.script.extend(completion(case(i)) for i in case_ids)

    async def settle(self) -> None:
        await settle(self.app)

    def complete(
        self,
        messages: Sequence[Message],
        *,
        schema: dict[str, Any] | None = None,
        schema_name: str = "answer",
        tools: Sequence[ToolSpec] = (),
        deadline: float | None = None,
    ) -> Completion:
        self.asked.set()
        assert self.released.wait(10), "the test never released the model"
        return self.fake.complete(
            messages, schema=schema, schema_name=schema_name, tools=tools, deadline=deadline
        )

    def models(self) -> list[ModelInfo]:
        return []

    def server_version(self) -> str | None:
        return None

    def close(self) -> None:
        pass


async def settle(app: FastAPI) -> None:
    """Until every model call started so far has ended."""
    await asyncio.to_thread(app.state.geotandem.model_calls.wait, 10)


async def connect(client: httpx.AsyncClient, **fields: Any) -> Body:
    response = await client.post(
        CONNECTIONS,
        json={"name": "Lokal", **LOCAL, "enabled": True, "is_default": True, **fields},
    )
    assert response.status_code == 201, response.text
    body: Body = response.json()
    return body


@pytest.fixture
async def model(client: httpx.AsyncClient, app: FastAPI) -> AsyncIterator[Model]:
    """A connection every account uses, and the fake model behind it."""
    fake = Model(app)
    fake.connection = await connect(client)
    app.state.geotandem.client_factory = fake
    yield fake
    fake.released.set()
    await settle(app)


@pytest.fixture
async def users(client: httpx.AsyncClient, app: FastAPI) -> AsyncIterator[Users]:
    """Clients signed in as further users, created by ``client`` (an administrator)."""
    made: list[httpx.AsyncClient] = []

    async def make(count: int) -> list[httpx.AsyncClient]:
        for _ in range(count):
            name = f"a.muster{len(made) + 1}"
            created = await client.post("/api/admin/users", json={"username": name, "role": "user"})
            assert created.status_code == 201, created.text
            first = created.json()["start_password"]
            other = httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            )
            made.append(other)
            login = await other.post("/api/auth/login", json={"username": name, "password": first})
            assert login.status_code == 200, login.text
            changed = await other.post(
                "/api/auth/password", json={"current": first, "new": USER_PASSWORD}
            )
            assert changed.status_code == 204, changed.text
        return made[-count:]

    yield make
    for other in made:
        await other.aclose()


@pytest.fixture
def areas(backend_of_client: DataBackend) -> None:
    """The tax rates the reference question asks about (e2e ensureAreaLayer)."""
    run = run_import(
        DATA_DIR / "gemeindedaten.csv",
        "gemeindedaten.csv",
        ImportDecisions(
            layer_name="gemeinden_steuern",
            title="Steuern je Gemeinde",
            geo=KeyReference(column="gem_nr", layer="gemeinden", attribute="gem_nr"),
            fields=[FieldDecision(source_name="steueranlage", label="Steueranlage")],
        ),
        backend_of_client,
        actor="admin",
    )
    assert run.status in ("ok", "warning"), run


async def ask(client: httpx.AsyncClient, case_id: str, **extra: Any) -> httpx.Response:
    return await client.post(PROMPT, json={"text": case(case_id)["prompt"], **extra})


async def outcome(client: httpx.AsyncClient, model: Model, case_id: str, **extra: Any) -> Body:
    """Ask ``case_id`` with its scripted answer; the record once the model answered."""
    model.script(case_id)
    response = await ask(client, case_id, **extra)
    assert response.status_code == 202, response.text
    assert response.json()["status"] == "thinking"
    await model.settle()
    polled = await client.get(action_url(response.json()["id"]))
    assert polled.status_code == 200, polled.text
    body: Body = polled.json()
    return body


def records(app: FastAPI) -> int:
    with Session(app.state.geotandem.backend.engine) as db:
        return db.scalar(select(func.count()).select_from(ModelAction)) or 0


def account_of(app: FastAPI, username: str) -> Account:
    engine = app.state.geotandem.backend.engine
    return next(a for a in accounts.list_accounts(engine) if a.username == username)


# --- every case of the fixture ---------------------------------------------------

OWN_TESTS = {"reference", "aborted", "quota_exceeded", "context_too_large"}
"""Cases with a test of their own below."""
PENDING_CASES = {
    "follow_up": "WP81",
    "follow_up_hand_edited": "WP81",
    "stale_reference": "WP81",
    "chain_reference": "WP75",
    "step_limit": "WP75",
}
"""Cases whose behaviour arrives with a later WP, which tests them and drops
them here; the etappe gate needs the WP81 ones gone by E2.6 (plan 5.2)."""
RECORD_CASES = [c["id"] for c in cases() if c["id"] not in OWN_TESTS | set(PENDING_CASES)]


def test_every_case_is_tested_or_pending() -> None:
    ids = [c["id"] for c in cases()]
    assert set(ids) == set(RECORD_CASES) | OWN_TESTS | set(PENDING_CASES)
    for case_id in RECORD_CASES:
        c = case(case_id)
        assert c["approach"] == "direct" and isinstance(c["expect"]["status"], str), case_id


@pytest.mark.parametrize("case_id", RECORD_CASES)
async def test_each_case_ends_in_its_status_and_code(
    client: httpx.AsyncClient, model: Model, backend_of_client: DataBackend, case_id: str
) -> None:
    c = case(case_id)
    setup = c.get("setup", {})
    if "hide_from_role" in setup:
        set_visible(backend_of_client.engine, setup["layer"], setup["hide_from_role"], False)
    if c.get("account_role") == "user":
        await sign_in_as(client, "m.keller")

    record = await outcome(client, model, case_id)

    expect = c["expect"]
    assert record["status"] == expect["status"]
    assert record["account"] == ("m.keller" if c.get("account_role") == "user" else "admin")
    if "refusal_code" in expect:
        assert record["refusal"]["code"] == expect["refusal_code"]
        assert expect.get("details", {}).items() <= record["refusal"]["details"].items()
        # The refused answer stays for the user to inspect (design M3).
        assert same_answer(record["answer"], case_id)
        assert record["query"] is None and record["decision"] is None
    elif "error_code" in expect:
        assert record["error"]["code"] == expect["error_code"]
        assert record["decision"] == "failed" and record["answer"] is None
    else:
        assert same_answer(record["answer"], case_id) and record["decision"] is None
    assert len(model.fake.calls) == 1


async def test_a_hidden_layer_is_refused_as_a_missing_one(
    client: httpx.AsyncClient, model: Model, backend_of_client: DataBackend
) -> None:
    """The fixture's ``same_as``: same code, same details keys, no hint it exists."""
    hidden = case("hidden_layer")
    assert hidden["expect"]["same_as"] == "unknown_layer"
    await sign_in_as(client, "m.keller")
    missing = (await outcome(client, model, "unknown_layer"))["refusal"]
    setup = hidden["setup"]
    set_visible(backend_of_client.engine, setup["layer"], setup["hide_from_role"], False)
    kept = (await outcome(client, model, "hidden_layer"))["refusal"]
    assert kept["code"] == missing["code"] == "unknown_layer"
    assert set(kept["details"]) == set(missing["details"])
    assert setup["layer"] not in kept["details"].get("available", [])


async def test_not_representable_is_stored_as_the_refusal_it_is(
    client: httpx.AsyncClient, model: Model
) -> None:
    """The record holds the refusal and the model's query as given; offering the
    chain (``expect.offer``) is the frontend's, once the chain exists (M3.3)."""
    record = await outcome(client, model, "not_representable")
    assert (record["status"], record["refusal"]["code"]) == ("refused", "not_representable")
    assert record["answer"]["query"] == case("not_representable")["answer"]["query"]
    assert record["query"] is None and record["governance"] is None


async def test_the_reference_question_is_proposed_with_what_it_was_asked_under(
    client: httpx.AsyncClient, model: Model, app: FastAPI, areas: None
) -> None:
    record = await outcome(client, model, "reference")

    expect = case("reference")["expect"]
    assert record["status"] == "proposed" and record["decision"] is None
    # As the editor wrote it in E1, to the byte once keys are sorted: no null,
    # no empty default, 500 not 500.0 (the frontend compares it so).
    assert canonical(record["query"]) == canonical(REFERENCE)
    assert set(record["governance"]["classes"]) == set(expect["classes"])
    state: AppState = app.state.geotandem
    admin = account_of(app, "admin")
    _, profile = profile_for(state.backend, admin)
    assert record["profile_hash"] == profile.hash
    level = active_level(state.backend.engine, admin.id, admin=True)
    assert LevelSnapshot.model_validate(record["level"]) == level_snapshot(level)
    assert record["connection"]["id"] == model.connection["id"]
    assert record["prompt"] == case("reference")["prompt"]
    assert record["prompt_hash"] == text_hash(case("reference")["prompt"])
    assert record["latency_ms"] is not None
    # The model saw exactly the profile whose hash the record keeps (S4).
    [call] = model.fake.calls
    assert profile.text in call.messages[0].content
    assert model.endpoints[0].model == LOCAL["model"]


async def test_the_call_waits_at_most_the_model_call_limit(
    client: httpx.AsyncClient, model: Model
) -> None:
    url = f"{CONNECTIONS}/{model.connection['id']}"
    for timeout, expected in ((600, MODEL_CALL_S), (30, 30)):
        assert (await client.patch(url, json={"timeout_s": timeout})).status_code == 200
        before = time.monotonic()
        await outcome(client, model, "clarification")
        assert model.endpoints[-1].timeout_s == expected
        # One deadline for the whole call, retries included, from the prompt on.
        deadline = model.fake.calls[-1].deadline
        assert deadline is not None and before + expected <= deadline <= time.monotonic() + expected


def test_the_fixture_and_the_frontend_agree_on_the_model_call_limit() -> None:
    """One limit, repeated in ``panel/state.ts``: its own test holds it to the fixture too."""
    assert fixture()["limits"]["model_call_s"] == MODEL_CALL_S


async def test_each_level_governs_the_answer_and_a_new_prompt_closes_it(
    client: httpx.AsyncClient, model: Model, areas: None
) -> None:
    """E2.4 replaces P1 (WP70): ``off`` proposes for the hand, ``approve`` waits,
    ``auto`` arrives approved. A new prompt closes the open record: a
    proposal-only one ends ``proposal_only``, never ``superseded``."""
    levels = (await client.get("/api/llm/options")).json()["levels"]
    assert [lv["name"] for lv in levels] == ["Assistenz", "Prüfen", "Automatisch"]
    cells = {"Assistenz": CellMode.OFF, "Prüfen": CellMode.APPROVE, "Automatisch": CellMode.AUTO}
    statuses = {"Assistenz": "proposed", "Prüfen": "proposed", "Automatisch": "approved"}
    earlier: list[int] = []
    for level in levels:
        chosen = await client.put("/api/llm/options", json={"level_id": level["id"]})
        assert chosen.status_code == 200, chosen.text
        record = await outcome(client, model, "reference")
        assert record["status"] == statuses[level["name"]], level["name"]
        assert record["level"]["name"] == level["name"]
        assert record["governance"]["cell"] == cells[level["name"]]
        earlier.append(record["id"])
    closed = [(await client.get(action_url(i))).json() for i in earlier[:-1]]
    assert [(c["status"], c["decision"]) for c in closed] == [
        ("superseded", "proposal_only"),
        ("superseded", "superseded"),
    ]


# --- 202 at once, polling and abort (P7) -------------------------------------------


async def test_the_answer_leaves_while_the_model_thinks(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    """Driven as a server drives it: the 202 and its body are sent, and the
    application call ends, while the model still holds its answer."""
    model.script("clarification")
    model.released.clear()
    body = json.dumps({"text": case("clarification")["prompt"]}).encode()
    cookies = "; ".join(f"{name}={value}" for name, value in client.cookies.items())
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": PROMPT,
        "raw_path": PROMPT.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"test"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            (b"cookie", cookies.encode()),
        ],
        "client": ("127.0.0.1", 50000),
        "server": ("test", 80),
    }
    requested = False
    closed = asyncio.Event()
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        nonlocal requested
        if not requested:
            requested = True
            return {"type": "http.request", "body": body, "more_body": False}
        await closed.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await asyncio.wait_for(app(scope, receive, send), 10)

    assert not model.released.is_set()
    start_, *parts = sent
    assert start_["type"] == "http.response.start" and start_["status"] == 202
    answer = json.loads(b"".join(p.get("body", b"") for p in parts))
    assert answer["status"] == "thinking" and parts[-1].get("more_body", False) is False
    assert await asyncio.to_thread(model.asked.wait, 10)  # the model is asked meanwhile
    thinking = (await client.get(action_url(answer["id"]))).json()
    assert thinking["status"] == "thinking"

    model.released.set()
    await model.settle()
    closed.set()
    assert (await client.get(action_url(answer["id"]))).json()["status"] == "answered"


async def test_polling_sees_thinking_then_the_outcome(
    client: httpx.AsyncClient, model: Model
) -> None:
    model.script("clarification")
    model.released.clear()
    response = await ask(client, "clarification")
    assert (response.status_code, response.json()["status"]) == (202, "thinking")
    action_id = response.json()["id"]
    assert await asyncio.to_thread(model.asked.wait, 10)

    thinking = (await client.get(action_url(action_id))).json()
    assert thinking["status"] == "thinking" and thinking["answer"] is None

    model.released.set()
    await model.settle()
    answered = (await client.get(action_url(action_id))).json()
    assert answered["status"] == "answered"
    assert same_answer(answered["answer"], "clarification")


async def test_abort_while_thinking_drops_the_late_answer(
    client: httpx.AsyncClient, model: Model, caplog: pytest.LogCaptureFixture
) -> None:
    model.script("aborted")
    model.released.clear()
    action_id = (await ask(client, "aborted")).json()["id"]
    assert await asyncio.to_thread(model.asked.wait, 10)

    aborted = await client.post(action_url(action_id, "abort"))
    assert aborted.status_code == 200, aborted.text
    assert (aborted.json()["status"], aborted.json()["decision"]) == ("aborted", "aborted")

    with caplog.at_level(logging.INFO, logger="geotandem.model"):
        model.released.set()
        await model.settle()
    expect = case("aborted")["expect"]
    final = (await client.get(action_url(action_id))).json()
    assert (final["status"], final["decision"]) == (expect["status"], expect["decision"])
    assert final["answer"] is None and final["query"] is None
    assert f"model action {action_id}: answer dropped" in caplog.text

    again = await client.post(action_url(action_id, "abort"))
    assert (again.status_code, again.json()["code"]) == (409, "already_decided")


async def test_an_abort_while_queued_never_reaches_the_model(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    """The pool's one thread is busy: the call waits, is aborted, never asks."""
    calls = ModelCalls(1)
    app.state.geotandem.model_calls = calls
    busy = threading.Event()
    calls._executor.submit(busy.wait, 10)  # the thread taken outside the flow
    model.script("clarification")

    action_id = (await ask(client, "clarification")).json()["id"]
    aborted = await client.post(action_url(action_id, "abort"))
    assert aborted.json()["status"] == "aborted"
    busy.set()
    await model.settle()

    assert model.fake.calls == [] and not model.asked.is_set()
    assert (await client.get(action_url(action_id))).json()["status"] == "aborted"
    # The slot came back.
    assert (await ask(client, "clarification")).status_code == 202


async def test_abort_after_the_answer_is_refused(client: httpx.AsyncClient, model: Model) -> None:
    record = await outcome(client, model, "cannot_answer")
    response = await client.post(action_url(record["id"], "abort"))
    assert response.status_code == 409
    assert (await client.get(action_url(record["id"]))).json()["status"] == "answered"


# --- what runs at once -----------------------------------------------------------


async def test_one_prompt_of_an_account_at_a_time(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    model.script("clarification")
    model.released.clear()
    assert (await ask(client, "clarification")).status_code == 202
    second = await ask(client, "clarification")
    assert (second.status_code, second.json()["code"]) == (409, "busy")
    assert second.json()["details"]["reason"] == "running"
    assert records(app) == 1
    model.released.set()
    await model.settle()


async def test_of_two_prompts_at_once_one_passes(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    model.script("clarification")
    model.released.clear()
    both = await asyncio.gather(*(ask(client, "clarification") for _ in range(2)))
    assert sorted(r.status_code for r in both) == [202, 409]
    assert records(app) == 1
    model.released.set()
    await model.settle()


async def test_model_calls_at_once_are_bounded(
    client: httpx.AsyncClient, model: Model, app: FastAPI, users: Users
) -> None:
    app.state.geotandem.model_calls = ModelCalls(1)
    [other] = await users(1)
    model.script("clarification", "clarification")
    model.released.clear()
    assert (await ask(client, "clarification")).status_code == 202

    refused = await ask(other, "clarification")

    assert (refused.status_code, refused.json()["code"]) == (503, "busy")
    assert refused.headers["Retry-After"] == "5"
    assert records(app) == 1
    model.released.set()
    await model.settle()
    assert (await ask(other, "clarification")).status_code == 202


# --- refused before any call: no record --------------------------------------------


async def test_context_too_large_answers_400_without_a_record(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    c = case("context_too_large")
    # The API's smallest context length; the fixture's 200 is below it, the effect the same.
    small = max(c["setup"]["context_length"], 256)
    patched = await client.patch(
        f"{CONNECTIONS}/{model.connection['id']}", json={"context_length": small}
    )
    assert patched.status_code == 200, patched.text

    response = await ask(client, "context_too_large")

    assert response.status_code == c["expect"]["http"]
    assert response.json()["code"] == c["expect"]["error_code"]
    assert response.json()["details"]["context_length"] == small
    assert records(app) == 0 and model.fake.calls == []


async def test_without_a_connection_nothing_is_asked(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    response = await ask(client, "clarification")
    assert (response.status_code, response.json()["code"]) == (409, "connection_not_available")
    assert response.json()["details"]["reason"] == "none"
    assert records(app) == 0


async def test_the_chain_is_not_built_yet(client: httpx.AsyncClient, model: Model) -> None:
    response = await client.post(PROMPT, json={"text": "?", "approach": "chain"})
    assert (response.status_code, response.json()["details"]["wp"]) == (501, "WP75")


# --- the request limit (P5) ------------------------------------------------------


async def limit(client: httpx.AsyncClient, model: Model, **fields: Any) -> None:
    response = await client.patch(f"{CONNECTIONS}/{model.connection['id']}", json=fields)
    assert response.status_code == 200, response.text


async def test_the_fixture_quota_case(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    c = case("quota_exceeded")
    setup = c["setup"]
    await limit(
        client,
        model,
        request_limit_enabled=True,
        request_limit_per_day=setup["request_limit_per_day"],
    )
    for _ in range(setup["requests_today"]):
        await outcome(client, model, "clarification")

    response = await ask(client, "quota_exceeded")

    assert response.status_code == c["expect"]["http"]
    assert response.json()["code"] == c["expect"]["error_code"]
    assert c["expect"]["details"].items() <= response.json()["details"].items()
    assert records(app) == setup["requests_today"]
    assert len(model.fake.calls) == setup["requests_today"]


async def test_the_limit_counts_every_request_up_to_it(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    """At the limit refused, below it not; failures count, they reached the model."""
    await limit(client, model, request_limit_enabled=True, request_limit_per_day=3)
    await outcome(client, model, "clarification")
    await outcome(client, model, "unreachable")
    await outcome(client, model, "unreadable")  # the third: exactly at the limit
    refused = await ask(client, "clarification")
    assert (refused.status_code, refused.json()["details"]["limit"]) == (429, 3)
    assert records(app) == 3

    # Raised by one: one more request, then refused again.
    await limit(client, model, request_limit_per_day=4)
    await outcome(client, model, "clarification")
    assert (await ask(client, "clarification")).status_code == 429


async def test_parallel_prompts_at_the_limit_pass_exactly_up_to_it(
    client: httpx.AsyncClient, model: Model, app: FastAPI, users: Users
) -> None:
    allowed, asking = 3, 7
    app.state.geotandem.model_calls = ModelCalls(asking)
    others = await users(asking)
    await limit(client, model, request_limit_enabled=True, request_limit_per_day=allowed)
    model.script(*["clarification"] * allowed)

    answers = await asyncio.gather(*(ask(other, "clarification") for other in others))
    await model.settle()

    codes = sorted(r.status_code for r in answers)
    assert codes == [202] * allowed + [429] * (asking - allowed)
    assert records(app) == allowed and len(model.fake.calls) == allowed


async def test_a_request_aborted_before_its_call_does_not_count(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    """P5 counts what reached the model call; a queued request aborted first did not."""
    calls = ModelCalls(1)
    app.state.geotandem.model_calls = calls
    busy = threading.Event()
    calls._executor.submit(busy.wait, 10)  # the one thread taken outside the flow
    await limit(client, model, request_limit_enabled=True, request_limit_per_day=1)

    queued = (await ask(client, "clarification")).json()["id"]
    assert (await client.post(action_url(queued, "abort"))).status_code == 200
    busy.set()
    await model.settle()
    assert model.fake.calls == []

    await outcome(client, model, "clarification")  # the day's one request
    assert (await ask(client, "clarification")).status_code == 429
    assert records(app) == 2


async def test_a_limit_that_is_off_is_never_checked(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    await limit(client, model, request_limit_enabled=False, request_limit_per_day=1)
    for _ in range(3):
        await outcome(client, model, "clarification")
    assert records(app) == 3


async def test_the_limit_counts_over_all_accounts(client: httpx.AsyncClient, model: Model) -> None:
    await limit(client, model, request_limit_enabled=True, request_limit_per_day=1)
    await outcome(client, model, "clarification")
    await sign_in_as(client, "m.keller")
    assert (await ask(client, "clarification")).status_code == 429


async def test_the_limit_starts_again_with_the_day(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    now = [datetime(2026, 10, 10, 23, 59, 0)]

    def at_now(state: Annotated[AppState, Depends(get_state)]) -> PromptFlow:
        return replace(prompt_flow(state), clock=lambda: now[0], tz=UTC)

    app.dependency_overrides[prompt_flow] = at_now
    await limit(client, model, request_limit_enabled=True, request_limit_per_day=1)
    await outcome(client, model, "clarification")
    now[0] = datetime(2026, 10, 10, 23, 59, 59)
    assert (await ask(client, "clarification")).status_code == 429
    now[0] = datetime(2026, 10, 11, 0, 0, 0)
    await outcome(client, model, "clarification")
    assert (await ask(client, "clarification")).status_code == 429


def test_the_day_is_the_calendar_day_of_the_time_zone() -> None:
    summer = timezone(timedelta(hours=2))
    assert day_start(datetime(2026, 10, 10, 21, 59), summer) == datetime(2026, 10, 9, 22, 0)
    assert day_start(datetime(2026, 10, 10, 22, 0), summer) == datetime(2026, 10, 10, 22, 0)
    assert day_start(datetime(2026, 10, 10, 23, 59), UTC) == datetime(2026, 10, 10, 0, 0)


# --- the administrator's request limit on the connection (P5, C16) ----------------


async def test_a_limit_that_is_on_needs_its_number(client: httpx.AsyncClient) -> None:
    missing = await client.post(
        CONNECTIONS, json={"name": "A", **LOCAL, "request_limit_enabled": True}
    )
    assert (missing.status_code, missing.json()["code"]) == (400, "request_limit_required")
    for bad in (0, -5):
        zero = await client.post(
            CONNECTIONS,
            json={
                "name": "A",
                **LOCAL,
                "request_limit_enabled": True,
                "request_limit_per_day": bad,
            },
        )
        assert (zero.status_code, zero.json()["code"]) == (422, "schema_violation")
    created = await connect(client, request_limit_enabled=True, request_limit_per_day=50)
    assert (created["request_limit_enabled"], created["request_limit_per_day"]) == (True, 50)
    listed = (await client.get(CONNECTIONS)).json()
    assert (listed[0]["request_limit_enabled"], listed[0]["request_limit_per_day"]) == (True, 50)


async def test_switching_the_limit_is_audited_and_keeps_the_number(
    client: httpx.AsyncClient, events: Events
) -> None:
    created = await connect(client)
    assert (created["request_limit_enabled"], created["request_limit_per_day"]) == (False, None)
    url = f"{CONNECTIONS}/{created['id']}"

    on_without = await client.patch(url, json={"request_limit_enabled": True})
    assert (on_without.status_code, on_without.json()["code"]) == (400, "request_limit_required")
    on = await client.patch(url, json={"request_limit_enabled": True, "request_limit_per_day": 5})
    assert on.status_code == 200, on.text
    off = (await client.patch(url, json={"request_limit_enabled": False})).json()
    assert (off["request_limit_enabled"], off["request_limit_per_day"]) == (False, 5)
    again = (await client.patch(url, json={"request_limit_enabled": True})).json()
    assert (again["request_limit_enabled"], again["request_limit_per_day"]) == (True, 5)
    cleared_while_on = await client.patch(url, json={"request_limit_per_day": None})
    assert cleared_while_on.json()["code"] == "request_limit_required"
    await client.patch(url, json={"request_limit_enabled": False})
    cleared = (await client.patch(url, json={"request_limit_per_day": None})).json()
    assert cleared["request_limit_per_day"] is None

    changed = [e.get("fields") for e in events if e["event"] == "llm_connection_changed"]
    assert changed[1:] == [
        ["request_limit_enabled", "request_limit_per_day"],
        ["request_limit_enabled"],
        ["request_limit_enabled"],
        ["request_limit_enabled"],
        ["request_limit_per_day"],
    ]


# --- decide (P1, D2) -------------------------------------------------------------


async def test_a_proposal_is_applied_by_hand(
    client: httpx.AsyncClient, model: Model, areas: None
) -> None:
    record = await outcome(client, model, "reference")
    url = action_url(record["id"], "decide")

    decided = await client.post(url, json={"decision": "proposal_only", "applied_by_hand": True})

    assert decided.status_code == 200, decided.text
    body = decided.json()
    assert (body["status"], body["decision"], body["applied_by_hand"]) == (
        "applied",
        "proposal_only",
        True,
    )
    assert body["decided_at"] is not None and body["applied_query"] is None
    again = await client.post(url, json={"decision": "proposal_only", "applied_by_hand": True})
    assert (again.status_code, again.json()["code"]) == (409, "already_decided")


async def test_an_adjusted_proposal_logs_the_users_query(
    client: httpx.AsyncClient, model: Model, areas: None
) -> None:
    record = await outcome(client, model, "reference")
    url = action_url(record["id"], "decide")
    edited = case("follow_up_hand_edited")["analysis"]

    without = await client.post(url, json={"decision": "adjusted"})
    by_hand = await client.post(
        url, json={"decision": "adjusted", "applied_by_hand": True, "query": edited}
    )
    with_query = await client.post(url, json={"decision": "proposal_only", "query": edited})
    for refused in (without, by_hand, with_query):
        assert (refused.status_code, refused.json()["code"]) == (400, "bad_request")

    decided = await client.post(url, json={"decision": "adjusted", "query": edited})
    assert decided.status_code == 200, decided.text
    body = decided.json()
    assert (body["status"], body["decision"], body["applied_by_hand"]) == (
        "applied",
        "adjusted",
        False,
    )
    assert canonical(body["applied_query"]) == canonical(
        compact(QueryObject.model_validate(edited))
    )
    assert "null" not in canonical(body["applied_query"])
    # The model's query stays what the model proposed.
    assert canonical(body["query"]) == canonical(REFERENCE)


async def test_only_a_proposal_is_decided(client: httpx.AsyncClient, model: Model) -> None:
    for case_id in ("unknown_layer", "clarification", "unreachable"):
        record = await outcome(client, model, case_id)
        response = await client.post(
            action_url(record["id"], "decide"), json={"decision": "proposal_only"}
        )
        assert response.status_code == 409, case_id


# --- whose record (D4) -----------------------------------------------------------


async def test_another_accounts_record_does_not_exist(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    mine = await outcome(client, model, "aborted")  # admin's proposal
    assert mine["status"] == "proposed"
    await sign_in_as(client, "m.keller")

    for method, step, body in (
        ("GET", "", None),
        ("POST", "decide", {"decision": "proposal_only", "applied_by_hand": True}),
        ("POST", "abort", None),
    ):
        for action_id in (mine["id"], 9999):
            response = await client.request(method, action_url(action_id, step), json=body)
            assert (response.status_code, response.json()["code"]) == (404, "not_found"), step
    follow = await ask(client, "follow_up", parent_action_id=mine["id"])
    assert (follow.status_code, follow.json()["code"]) == (404, "not_found")
    assert records(app) == 1 and len(model.fake.calls) == 1

    # The administrator reads the user's record (D4) but does not decide it.
    theirs = await outcome(client, model, "aborted")
    await sign_in(client, "admin", ADMIN_PASSWORD)
    assert (await client.get(action_url(theirs["id"]))).json()["account"] == "m.keller"
    decide = await client.post(
        action_url(theirs["id"], "decide"), json={"decision": "proposal_only"}
    )
    assert decide.status_code == 404
    assert (await client.post(action_url(theirs["id"], "abort"))).status_code == 404


async def test_the_reply_to_a_clarification_carries_its_question(
    client: httpx.AsyncClient, model: Model
) -> None:
    """P6, M12.2: the option alone ("500 m") means nothing; the model gets the
    parent chain as turns. The derived reference arrives with WP81."""
    clarification = case("clarification")
    parent = await outcome(client, model, "clarification")
    model.fake.calls.clear()
    option = clarification["answer"]["options"][1]

    model.script("cannot_answer")
    response = await client.post(PROMPT, json={"text": option, "parent_action_id": parent["id"]})
    assert response.status_code == 202, response.text
    await model.settle()
    record = (await client.get(action_url(response.json()["id"]))).json()

    assert record["parent_action_id"] == parent["id"]
    assert record["reference"] == "none"
    [call] = model.fake.calls
    assert [m.role for m in call.messages] == ["system", "user", "assistant", "user"]
    assert call.messages[1].content == clarification["prompt"]
    assert clarification["answer"]["question"] in call.messages[2].content
    assert all(o in call.messages[2].content for o in clarification["answer"]["options"])
    assert call.messages[3].content == option


async def test_the_turns_reach_back_over_own_records_only(
    client: httpx.AsyncClient, model: Model
) -> None:
    """At most ``MAX_TURNS`` records back, oldest first, with the user's decision."""
    parent: int | None = None
    for i in range(MAX_TURNS + 1):
        model.script("clarification")
        extra = {} if parent is None else {"parent_action_id": parent}
        response = await client.post(PROMPT, json={"text": f"Frage {i}", **extra})
        assert response.status_code == 202, response.text
        await model.settle()
        parent = response.json()["id"]
    model.fake.calls.clear()

    await outcome(client, model, "cannot_answer", parent_action_id=parent)

    [call] = model.fake.calls
    users = [m.content for m in call.messages if m.role == "user"]
    assert users[:-1] == [f"Frage {i}" for i in range(1, MAX_TURNS + 1)]


async def test_an_aborted_call_holds_the_account_until_it_ends(
    client: httpx.AsyncClient, model: Model
) -> None:
    """Abort frees the screen, not the model: the next prompt waits (409 with the
    aborted record's id) while its call still runs, and passes once it ended."""
    model.script("clarification", "clarification")
    model.released.clear()
    first = (await ask(client, "clarification")).json()["id"]
    assert await asyncio.to_thread(model.asked.wait, 10)
    assert (await client.post(action_url(first, "abort"))).status_code == 200

    again = await ask(client, "clarification")
    assert (again.status_code, again.json()["code"]) == (409, "busy")
    assert again.json()["details"] == {"reason": "running", "id": first}

    model.released.set()
    await model.settle()
    assert (await ask(client, "clarification")).status_code == 202
    await model.settle()


async def test_an_outcome_that_cannot_be_stored_ends_failed(
    client: httpx.AsyncClient, model: Model, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Never a ``thinking`` record left behind: it would hold the account."""

    def broken(*_: Any, **__: Any) -> None:
        raise RuntimeError("the database went away")

    monkeypatch.setattr(ModelActionStore, "answer", broken)
    record = await outcome(client, model, "clarification")

    assert (record["status"], record["decision"]) == ("failed", "failed")
    assert record["error"]["code"] == "internal_error"
    monkeypatch.undo()
    assert (await ask(client, "clarification")).status_code == 202
    await model.settle()


async def test_a_thinking_record_no_call_will_finish_is_closed(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    """Older than the call limit and a margin, and no call in flight: stale."""
    engine = app.state.geotandem.backend.engine
    admin = account_of(app, "admin")
    then = utc_now() - timedelta(seconds=MODEL_CALL_S + STALE_MARGIN_S + 1)
    stuck = ModelActionStore(engine, lambda: then).create(admin, new_action(), supersede=False)
    recent = ModelActionStore(engine).create(admin, new_action(), supersede=False)

    held = await ask(client, "clarification")
    assert (held.status_code, held.json()["details"]["id"]) == (409, recent.id)

    store = ModelActionStore(engine)
    closed = store.get(admin, stuck.id)
    assert (closed.status, closed.decision) == ("failed", "failed")
    assert closed.error is not None and closed.error["code"] == "llm_timeout"
    store.fail(admin, recent.id, {"code": "llm_timeout", "message": "-", "details": {}})
    model.script("clarification")
    assert (await ask(client, "clarification")).status_code == 202
    await model.settle()


# --- logs (C15) ------------------------------------------------------------------


async def test_no_log_line_holds_the_prompt_or_the_answer(
    client: httpx.AsyncClient,
    app: FastAPI,
    events: Events,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Through the real adapter, so its log lines are in it too."""
    await connect(client)
    secret_prompt = "Primarschulen bei Wohnung Musterweg 7 ZEUGE-4711"
    question = case("clarification")["answer"]["question"]
    stub = OllamaStub(
        answers=[
            chat(json.dumps(case("clarification")["answer"])),
            chat("Antwort ohne JSON ZEUGE-0815"),
        ]
    )
    app.state.geotandem.client_factory = lambda endpoint: OpenAICompatClient(
        endpoint, transport=stub.transport(), sleep=lambda _: None
    )
    with caplog.at_level(logging.INFO):
        answered = await client.post(PROMPT, json={"text": secret_prompt})
        await settle(app)
        failed = await client.post(PROMPT, json={"text": secret_prompt})
        await settle(app)
        await client.get(action_url(answered.json()["id"]))
        await client.post(action_url(failed.json()["id"], "abort"))

    assert len(stub.chat_requests()) == 2
    assert (await client.get(action_url(failed.json()["id"]))).json()["status"] == "failed"
    lines = [r.getMessage() for r in caplog.records] + [json.dumps(e) for e in events]
    assert any(f"model action {answered.json()['id']}: answered" in line for line in lines)
    text = "\n".join(lines)
    for secret in ("ZEUGE", "Musterweg", question, "Antwort ohne JSON"):
        assert secret not in text


# --- start-up (P7) ---------------------------------------------------------------


def new_action(connection_id: int = 1) -> NewAction:
    return NewAction(
        prompt="Primarschulen in Köniz",
        approach="direct",
        level=LevelSnapshot(
            id=1, name="Prüfen", matrix={c: CellMode.APPROVE for c in OpClass}, prompt_hash="1" * 64
        ),
        connection=ConnectionSnapshot(
            id=connection_id, name="Lokal", model="qwen3:8b", host="127.0.0.1", locality="local"
        ),
        profile_hash="p" * 64,
        proposal_only=True,
    )


def test_start_closes_everything_the_last_shutdown_left_thinking(settings: Settings) -> None:
    """One process: nothing in flight survives a restart, whatever its age."""
    engine = bootstrap(settings)
    anna = accounts.create(engine, "anna", USER_PASSWORD, "user")
    new = new_action()
    then = utc_now() - timedelta(seconds=MODEL_CALL_S + 1)
    lost = ModelActionStore(engine, lambda: then).create(anna, new)
    recent = ModelActionStore(engine).create(anna, new, supersede=False)
    engine.dispose()

    state = start(settings)

    store = ModelActionStore(state.backend.engine)
    for action in (lost, recent):
        closed = store.get(anna, action.id)
        assert (closed.status, closed.decision) == ("failed", "failed")
        assert closed.error is not None and closed.error["code"] == "llm_timeout"
    state.model_calls.shutdown()
    state.backend.engine.dispose()
