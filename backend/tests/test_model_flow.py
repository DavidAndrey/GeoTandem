"""The prompt flow of the direct query, proposal-only (plan E2.3-E2.6, WP65).

Through the API, with the model faked behind the client factory and scripted
from the contract fixture: every case ends in its status and code, the client
sees ``thinking`` and then the outcome, abort drops a late answer, the request
limit counts per connection and day (P5), every level only proposes (P1),
another account's record does not exist, and no log line holds the prompt.

Background tasks: ``httpx.ASGITransport`` returns a response only once the
application call is complete, background tasks included, so a test that
awaits ``POST /prompt`` finds the outcome stored. A test that must see the
record while the model thinks holds the model on an event and sends the
prompt as a task; nothing sleeps.
"""

import asyncio
import json
import logging
import threading
from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone
from typing import Annotated, Any

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, USER_PASSWORD, Events, sign_in, sign_in_as
from fastapi import Depends, FastAPI
from llm_stub import OllamaStub, chat
from model_fixtures import REPO, case, cases, completion
from pydantic import TypeAdapter
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from geotandem.api.model import prompt_flow
from geotandem.api.state import AppState, get_state
from geotandem.app import start
from geotandem.auth import accounts
from geotandem.auth.accounts import Account
from geotandem.auth.visibility import set_visible, view_for
from geotandem.catalog import model_profile
from geotandem.config import Settings
from geotandem.data import DataBackend
from geotandem.db.bootstrap import bootstrap
from geotandem.db.orm import ModelAction
from geotandem.importing.run import FieldDecision, ImportDecisions, KeyReference, run_import
from geotandem.levels import CellMode, OpClass, active_level
from geotandem.llm import Completion, Endpoint, Message, ModelInfo, ToolSpec
from geotandem.llm.fake import FakeLLMClient
from geotandem.llm.openai_compat import OpenAICompatClient
from geotandem.model.record import ModelActionStore, NewAction, level_snapshot, text_hash
from geotandem.model.schemas import ConnectionSnapshot, LevelSnapshot, ModelAnswer
from geotandem.model.service import MODEL_CALL_S, PromptFlow, day_start, utc_now
from geotandem.sample import DATA_DIR
from geotandem_query import QueryObject

PROMPT = "/api/model/prompt"
CONNECTIONS = "/api/admin/llm/connections"
LOCAL = {"base_url": "http://127.0.0.1:11434/v1", "model": "qwen3:8b"}
REFERENCE = json.loads((REPO / "e2e/fixtures/reference-question.json").read_text("utf-8"))
ANSWER = TypeAdapter[Any](ModelAnswer)

Body = dict[str, Any]


def same_answer(stored: Body | None, case_id: str) -> bool:
    """The record keeps the model's answer (defaults filled in) as the case has it."""
    return stored is not None and ANSWER.validate_python(stored) == ANSWER.validate_python(
        case(case_id)["answer"]
    )


def action_url(action_id: int, step: str = "") -> str:
    return f"/api/model/actions/{action_id}" + (f"/{step}" if step else "")


class Model:
    """The model behind the client factory: answers the scripted cases in order.
    ``released`` cleared holds every call until it is set again, so a test sees
    the record while the model thinks; ``asked`` tells that a call came."""

    def __init__(self) -> None:
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

    def complete(
        self,
        messages: Sequence[Message],
        *,
        schema: dict[str, Any] | None = None,
        schema_name: str = "answer",
        tools: Sequence[ToolSpec] = (),
    ) -> Completion:
        self.asked.set()
        assert self.released.wait(10), "the test never released the model"
        return self.fake.complete(messages, schema=schema, schema_name=schema_name, tools=tools)

    def models(self) -> list[ModelInfo]:
        return []

    def server_version(self) -> str | None:
        return None

    def close(self) -> None:
        pass


async def connect(client: httpx.AsyncClient, **fields: Any) -> Body:
    response = await client.post(
        CONNECTIONS,
        json={"name": "Lokal", **LOCAL, "enabled": True, "is_default": True, **fields},
    )
    assert response.status_code == 201, response.text
    body: Body = response.json()
    return body


@pytest.fixture
async def model(client: httpx.AsyncClient, app: FastAPI) -> Model:
    """A connection every account uses, and the fake model behind it."""
    fake = Model()
    fake.connection = await connect(client)
    app.state.geotandem.client_factory = fake
    return fake


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
    polled = await client.get(action_url(response.json()["id"]))
    assert polled.status_code == 200, polled.text
    body: Body = polled.json()
    return body


def records(app: FastAPI) -> int:
    with Session(app.state.geotandem.backend.engine) as db:
        return db.scalar(select(func.count()).select_from(ModelAction)) or 0


def latest(app: FastAPI) -> int:
    with Session(app.state.geotandem.backend.engine) as db:
        found = db.scalar(select(func.max(ModelAction.id)))
    assert found is not None
    return found


def account_of(app: FastAPI, username: str) -> Account:
    engine = app.state.geotandem.backend.engine
    return next(a for a in accounts.list_accounts(engine) if a.username == username)


# --- every case of the fixture ---------------------------------------------------

RECORD_CASES = [
    c["id"]
    for c in cases()
    if c["approach"] == "direct"
    and "http" not in c["expect"]
    and "parent" not in c
    and c["id"] not in ("reference", "aborted")
]


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


async def test_the_reference_question_is_proposed_with_what_it_was_asked_under(
    client: httpx.AsyncClient, model: Model, app: FastAPI, areas: None
) -> None:
    record = await outcome(client, model, "reference")

    expect = case("reference")["expect"]
    assert record["status"] == "proposed" and record["decision"] is None
    assert QueryObject.model_validate(record["query"]) == QueryObject.model_validate(REFERENCE)
    assert set(record["governance"]["classes"]) == set(expect["classes"])
    state: AppState = app.state.geotandem
    admin = account_of(app, "admin")
    profile = model_profile(state.backend.engine, view_for(state.backend, admin).layer_names())
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


async def test_every_level_only_proposes_in_e2_3(
    client: httpx.AsyncClient, model: Model, areas: None
) -> None:
    """P1: also where every cell is ``auto``; an overtaken proposal ends
    ``proposal_only``, never ``superseded``."""
    levels = (await client.get("/api/llm/options")).json()["levels"]
    assert [lv["name"] for lv in levels] == ["Assistenz", "Prüfen", "Automatisch"]
    cells = {"Assistenz": CellMode.OFF, "Prüfen": CellMode.APPROVE, "Automatisch": CellMode.AUTO}
    earlier: list[int] = []
    for level in levels:
        chosen = await client.put("/api/llm/options", json={"level_id": level["id"]})
        assert chosen.status_code == 200, chosen.text
        record = await outcome(client, model, "reference")
        assert record["status"] == "proposed", level["name"]
        assert record["level"]["name"] == level["name"]
        assert record["governance"]["cell"] == cells[level["name"]]
        earlier.append(record["id"])
    for action_id in earlier[:-1]:
        before = (await client.get(action_url(action_id))).json()
        assert (before["status"], before["decision"]) == ("superseded", "proposal_only")


# --- polling and abort (P7) ------------------------------------------------------


async def test_polling_sees_thinking_then_the_outcome(
    client: httpx.AsyncClient, model: Model, app: FastAPI
) -> None:
    model.script("clarification")
    model.released.clear()
    sent = asyncio.create_task(ask(client, "clarification"))
    assert await asyncio.to_thread(model.asked.wait, 10)

    action_id = latest(app)
    thinking = (await client.get(action_url(action_id))).json()
    assert thinking["status"] == "thinking" and thinking["answer"] is None

    model.released.set()
    response = await sent
    assert response.status_code == 202
    assert (response.json()["id"], response.json()["status"]) == (action_id, "thinking")
    answered = (await client.get(action_url(action_id))).json()
    assert answered["status"] == "answered"
    assert same_answer(answered["answer"], "clarification")


async def test_abort_while_thinking_drops_the_late_answer(
    client: httpx.AsyncClient, model: Model, app: FastAPI, caplog: pytest.LogCaptureFixture
) -> None:
    model.script("aborted")
    model.released.clear()
    sent = asyncio.create_task(ask(client, "aborted"))
    assert await asyncio.to_thread(model.asked.wait, 10)
    action_id = latest(app)

    aborted = await client.post(action_url(action_id, "abort"))
    assert aborted.status_code == 200, aborted.text
    assert (aborted.json()["status"], aborted.json()["decision"]) == ("aborted", "aborted")

    with caplog.at_level(logging.INFO, logger="geotandem.model"):
        model.released.set()
        assert (await sent).status_code == 202
    expect = case("aborted")["expect"]
    final = (await client.get(action_url(action_id))).json()
    assert (final["status"], final["decision"]) == (expect["status"], expect["decision"])
    assert final["answer"] is None and final["query"] is None
    assert f"model action {action_id}: answer dropped (already_decided)" in caplog.text

    again = await client.post(action_url(action_id, "abort"))
    assert (again.status_code, again.json()["code"]) == (409, "already_decided")


async def test_abort_after_the_answer_is_refused(client: httpx.AsyncClient, model: Model) -> None:
    record = await outcome(client, model, "cannot_answer")
    response = await client.post(action_url(record["id"], "abort"))
    assert response.status_code == 409
    assert (await client.get(action_url(record["id"]))).json()["status"] == "answered"


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
    assert QueryObject.model_validate(body["applied_query"]) == QueryObject.model_validate(edited)
    # The model's query stays what the model proposed.
    assert QueryObject.model_validate(body["query"]) == QueryObject.model_validate(REFERENCE)


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


async def test_a_follow_up_is_linked_to_its_parent_without_context_yet(
    client: httpx.AsyncClient, model: Model
) -> None:
    """P6: the link is stored; turns and the derived reference arrive with WP81."""
    parent = await outcome(client, model, "clarification")
    model.fake.calls.clear()

    record = await outcome(
        client,
        model,
        "cannot_answer",
        parent_action_id=parent["id"],
        analysis=case("follow_up")["analysis"],
    )

    assert record["parent_action_id"] == parent["id"]
    assert record["reference"] == "none"
    [call] = model.fake.calls
    assert [m.role for m in call.messages] == ["system", "user"]
    assert call.messages[1].content == case("cannot_answer")["prompt"]


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
        failed = await client.post(PROMPT, json={"text": secret_prompt})
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


def test_start_closes_what_the_last_shutdown_left_thinking(settings: Settings) -> None:
    engine = bootstrap(settings)
    anna = accounts.create(engine, "anna", USER_PASSWORD, "user")
    new = NewAction(
        prompt="Primarschulen in Köniz",
        approach="direct",
        level=LevelSnapshot(
            id=1, name="Prüfen", matrix={c: CellMode.APPROVE for c in OpClass}, prompt_hash="1" * 64
        ),
        connection=ConnectionSnapshot(
            id=1, name="Lokal", model="qwen3:8b", host="127.0.0.1", locality="local"
        ),
        profile_hash="p" * 64,
        proposal_only=True,
    )
    then = utc_now() - timedelta(seconds=MODEL_CALL_S + 1)
    lost = ModelActionStore(engine, lambda: then).create(anna, new)
    recent = ModelActionStore(engine).create(anna, new, supersede=False)
    engine.dispose()

    state = start(settings)

    store = ModelActionStore(state.backend.engine)
    closed = store.get(anna, lost.id)
    assert (closed.status, closed.decision) == ("failed", "failed")
    assert closed.error is not None and closed.error["code"] == "llm_timeout"
    assert store.get(anna, recent.id).status == "thinking"
    state.backend.engine.dispose()
