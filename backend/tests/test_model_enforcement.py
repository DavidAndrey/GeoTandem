"""Enforcement of the levels on the model path (plan E2.3-E2.6, WP70; matrix 5.3).

Through the API, with the model scripted behind the client factory: the
enforcement matrix (level cell by operation class by path) shows that the
stored query runs only where the cell allows, and every other combination
answers with its exact code and runs nothing in the engine. "Runs nothing" is
observed where every query of the engine reaches the data core: the data
core's ``execute`` (``ran``), which ``run_query``, ``count_query`` and
``ids_query`` all go through and the model's validation never does.

Then the parts of the matrix rows one by one: ``execute`` takes no body and
runs the stored query, the preview (P2) needs an interactive session, undo
and the hand edit, concurrent decisions, and the start-up check.
"""

import asyncio
import threading
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import httpx
import pytest
from api_helpers import ADMIN_PASSWORD, USER_PASSWORD, sign_in, sign_in_as
from fastapi import FastAPI, Request
from model_fixtures import case, completion, fixture
from sqlalchemy import Select
from sqlalchemy.orm import Session

from geotandem.api.auth import signed_in
from geotandem.api.state import AppState
from geotandem.auth import accounts
from geotandem.auth.accounts import Account
from geotandem.auth.visibility import set_visible
from geotandem.data import DataBackend, Limits
from geotandem.db.orm import ModelAction
from geotandem.importing.run import FieldDecision, ImportDecisions, KeyReference, run_import
from geotandem.levels import CellMode, OpClass, classify, load_levels
from geotandem.llm import Completion, Endpoint
from geotandem.llm.fake import FakeLLMClient
from geotandem.model.direct import governance
from geotandem.model.record import (
    ModelActionStore,
    NewAction,
    connection_snapshot,
    level_snapshot,
)
from geotandem.model.schemas import QueryAnswer
from geotandem.model.service import MODEL_CALL_S, close_stale
from geotandem.sample import DATA_DIR
from geotandem_query import QueryObject, compact

PROMPT = "/api/model/prompt"
LEVELS = "/api/admin/levels"
OPTIONS = "/api/llm/options"
CONNECTIONS = "/api/admin/llm/connections"
LOCAL = {"base_url": "http://127.0.0.1:11434/v1", "model": "qwen3:8b"}

Body = dict[str, Any]

PRIMAR = {"op": "in", "attr": "typ", "values": ["primar"]}
PLAIN: Body = {"schema_version": "2", "source": "schulen", "where": PRIMAR}
"""Classes ``{query}``."""
NEAR: Body = {
    "schema_version": "2",
    "source": "schulen",
    "where": {
        "op": "and",
        "args": [
            PRIMAR,
            {
                "op": "related",
                "layer": "strassen",
                "predicate": "dwithin",
                "distance_m": 500,
                "where": {
                    "op": "compare",
                    "attr": "klasse",
                    "cmp": "eq",
                    "value": "kantonsstrasse_b",
                },
            },
        ],
    },
}
"""Classes ``{query, spatial}``."""
DERIVE: Body = {**PLAIN, "buffer": {"distance_m": 100}}
"""Classes ``{query, derive}``; the direct path refuses it (``not_representable``)."""
DISPLAY: Body = {**PLAIN, "symbology": {"kind": "single"}}
"""Classes ``{query, display}``; the direct path refuses it as well."""
REFERENCE: Body = case("reference")["answer"]["query"]
"""The fixture's reference answer, classes ``{query, spatial}`` (needs ``areas``)."""

SEEDED = (DERIVE, DISPLAY)
"""No model answer of the direct path carries them (D3), but a record may (the
chain, E2.5): stored through the store as the service stores an answer."""


def answer(query: Body) -> Completion:
    body = {"kind": "query", "explanation": "Primarschulen.", "assumptions": [], "query": query}
    return completion({"answer": body})


def matrix(**cells: str) -> dict[str, str]:
    """Every class ``auto`` but those named."""
    return {c.value: CellMode(cells.get(c.value, "auto")).value for c in OpClass}


def touched_classes(query: Body) -> set[OpClass]:
    """Written out for the test, not taken from ``classify``."""
    if query is NEAR or query is REFERENCE:
        return {OpClass.QUERY, OpClass.SPATIAL}
    if query is DERIVE:
        return {OpClass.QUERY, OpClass.DERIVE}
    if query is DISPLAY:
        return {OpClass.QUERY, OpClass.DISPLAY}
    return {OpClass.QUERY}


STRICTNESS = [CellMode.AUTO, CellMode.APPROVE, CellMode.OFF]


def governing(cells: dict[str, str], query: Body) -> CellMode:
    """The strictest cell among the classes the query touches (H4, M6.3)."""
    return max((CellMode(cells[c]) for c in touched_classes(query)), key=STRICTNESS.index)


FLIPPED = {
    CellMode.OFF: CellMode.AUTO,
    CellMode.APPROVE: CellMode.AUTO,
    CellMode.AUTO: CellMode.OFF,
}


# --- the fixtures ----------------------------------------------------------------


class Model:
    """The model behind the client factory: answers what the test scripts."""

    def __init__(self) -> None:
        self.fake = FakeLLMClient()

    def __call__(self, endpoint: Endpoint) -> FakeLLMClient:
        return self.fake


@pytest.fixture
def model(app: FastAPI) -> Model:
    fake = Model()
    app.state.geotandem.client_factory = fake
    return fake


async def settle(app: FastAPI) -> None:
    await asyncio.to_thread(app.state.geotandem.model_calls.wait, 10)


@pytest.fixture
def ran(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The engine's query log: every statement the data core executes."""
    log: list[str] = []
    backend_type = type(app.state.geotandem.backend)
    original = backend_type.execute

    def execute(self: DataBackend, stmt: Select[Any], limits: Limits) -> list[dict[str, Any]]:
        log.append(str(stmt))
        return original(self, stmt, limits)

    monkeypatch.setattr(backend_type, "execute", execute)
    return log


async def connect(client: httpx.AsyncClient, **fields: Any) -> Body:
    response = await client.post(
        CONNECTIONS,
        json={"name": "Lokal", **LOCAL, "enabled": True, "is_default": True, **fields},
    )
    assert response.status_code == 201, response.text
    body: Body = response.json()
    return body


@pytest.fixture
async def other(app: FastAPI, client: httpx.AsyncClient) -> AsyncIterator[httpx.AsyncClient]:
    """A second user, ``b.muster``, in a client of their own."""
    created = await client.post("/api/admin/users", json={"username": "b.muster", "role": "user"})
    assert created.status_code == 201, created.text
    first = created.json()["start_password"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as them:
        await them.post("/api/auth/login", json={"username": "b.muster", "password": first})
        changed = await them.post(
            "/api/auth/password", json={"current": first, "new": USER_PASSWORD}
        )
        assert changed.status_code == 204, changed.text
        yield them


def import_areas(backend: DataBackend) -> None:
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
        backend,
        actor="admin",
    )
    assert run.status in ("ok", "warning"), run


async def install_levels(client: httpx.AsyncClient, levels: list[Body]) -> dict[str, int]:
    """Replace the level set; a level of a stored name keeps its id. Name → id."""
    stored = {lv["name"]: lv["id"] for lv in (await client.get(LEVELS)).json()["levels"]}
    body = [{**lv, "id": stored.get(lv["name"])} for lv in levels]
    response = await client.put(LEVELS, json={"levels": body})
    assert response.status_code == 200, response.text
    return {lv["name"]: lv["id"] for lv in response.json()["levels"]}


def fixture_levels() -> list[Body]:
    """Assistenz, Prüfen (default), Teilautonom, Automatisch (not selectable)."""
    return [
        {k: v for k, v in level.items() if not k.startswith("_")} for level in fixture()["levels"]
    ]


async def choose(client: httpx.AsyncClient, level_id: int) -> httpx.Response:
    return await client.put(OPTIONS, json={"level_id": level_id})


def url(action_id: int, step: str = "") -> str:
    return f"/api/model/actions/{action_id}" + (f"/{step}" if step else "")


def account_of(app: FastAPI, username: str) -> Account:
    engine = app.state.geotandem.backend.engine
    return next(a for a in accounts.list_accounts(engine) if a.username == username)


async def ask(client: httpx.AsyncClient, app: FastAPI, model: Model, query: Body) -> Body:
    """Prompt with ``query`` as the model's answer; the record once it answered."""
    model.fake.script.append(answer(query))
    response = await client.post(PROMPT, json={"text": "Primarschulen bitte"})
    assert response.status_code == 202, response.text
    await settle(app)
    polled = await client.get(url(response.json()["id"]))
    body: Body = polled.json()
    return body


def seed(app: FastAPI, username: str, query: Body, level_name: str) -> Body:
    """A record with ``query`` as the service stores an answer (``PromptFlow._keep``):
    the level and connection as they are now, governance from ``classify``."""
    state: AppState = app.state.geotandem
    engine = state.backend.engine
    who = account_of(app, username)
    level = next(lv for lv in load_levels(engine) if lv.name == level_name)
    connection = state.connections.active(who.id)
    assert connection is not None
    store = ModelActionStore(engine)
    new = NewAction(
        prompt="Gepufferte Primarschulen",
        approach="direct",
        level=level_snapshot(level),
        connection=connection_snapshot(connection),
        profile_hash="p" * 64,
    )
    action = store.create(who, new)
    parsed = QueryObject.model_validate(query)
    view = store.propose(
        who,
        action.id,
        QueryAnswer(kind="query", explanation="Gepuffert.", query=query),
        query=parsed,
        governance=governance(level, classify(parsed)),
        latency_ms=1,
    )
    return view.model_dump(mode="json")


# --- the matrix (plan 5.3) ---------------------------------------------------------


@dataclass(frozen=True)
class Row:
    """A level, a query touching the classes under test, and what governs."""

    name: str
    levels: tuple[Body, ...]
    level: str
    """The level the prompt is sent under."""
    query: Body
    areas: bool = False

    @property
    def cells(self) -> dict[str, str]:
        return next(lv["matrix"] for lv in self.levels if lv["name"] == self.level)

    @property
    def cell(self) -> CellMode:
        return governing(self.cells, self.query)


PRUEFEN = next(lv for lv in fixture_levels() if lv["name"] == "Prüfen")
QUERY_OF: dict[OpClass, Body] = {
    OpClass.CATALOG: PLAIN,  # no part of a query object is catalog: its cell never governs
    OpClass.QUERY: PLAIN,
    OpClass.SPATIAL: NEAR,
    OpClass.DERIVE: DERIVE,
    OpClass.DISPLAY: DISPLAY,
}


def cell_row(op_class: OpClass, cell: CellMode) -> Row:
    level = {
        "name": "Zelle",
        "selectable": True,
        "matrix": matrix(**{op_class.value: cell.value}),
    }
    return Row(f"{op_class.value}-{cell.value}", (PRUEFEN, level), "Zelle", QUERY_OF[op_class])


def mixed(name: str, level: str, query: Body, /, **cells: str) -> Row:
    if not cells:
        return Row(name, tuple(fixture_levels()), level, query, areas=query is REFERENCE)
    custom = {"name": level, "selectable": True, "matrix": matrix(**cells)}
    return Row(name, (PRUEFEN, custom), level, query)


ROWS = [cell_row(c, m) for c in OpClass for m in CellMode] + [
    # The fixture's levels (M6.3: the strictest cell governs the whole answer).
    mixed("Assistenz-reference", "Assistenz", REFERENCE),
    mixed("Prüfen-reference", "Prüfen", REFERENCE),
    mixed("Teilautonom-reference", "Teilautonom", REFERENCE),
    mixed("Teilautonom-derive", "Teilautonom", DERIVE),
    mixed("Automatisch-reference", "Automatisch", REFERENCE),
    # Mixed cells over one query.
    mixed("query_auto-spatial_approve", "Gemischt", NEAR, spatial="approve"),
    mixed("query_approve-spatial_off", "Gemischt", NEAR, query="approve", spatial="off"),
    mixed("query_off-derive_approve", "Gemischt", DERIVE, query="off", derive="approve"),
]
PATHS = ["surface", "direct", "replay", "preview", "other_account", "level_changed"]


def test_the_rows_cover_every_cell_and_the_fixture_expectations() -> None:
    cells = {(c, r.cells[c]) for r in ROWS[:15] for c in [r.name.split("-")[0]]}
    assert len(cells) == 15
    # No part of a query object is catalog: its cell never governs (classify).
    assert {r.cell for r in ROWS[:3]} == {CellMode.AUTO}
    expect = case("reference")["expect"]["status"]
    by_name = {r.level: r for r in ROWS if r.query is REFERENCE}
    for level, status in expect.items():
        assert (by_name[level].cell is CellMode.AUTO) == (status == "approved"), level
    assert next(r for r in ROWS if r.name == "Teilautonom-derive").cell is CellMode.APPROVE


async def set_up(client: httpx.AsyncClient, app: FastAPI, model: Model, row: Row) -> Body:
    """The levels of ``row``, its level chosen, its query answered: the record."""
    await connect(client)
    if row.areas:
        import_areas(app.state.geotandem.backend)
    ids = await install_levels(client, list(row.levels))
    chosen = await choose(client, ids[row.level])
    assert chosen.status_code == 200, chosen.text
    if row.query in SEEDED:
        return seed(app, "admin", row.query, row.level)
    return await ask(client, app, model, row.query)


async def modus_a(client: httpx.AsyncClient, query: Body) -> list[int]:
    """The ids the user's own query returns (Modus A), for comparison."""
    response = await client.post("/api/query/ids", json=query)
    assert response.status_code == 200, response.text
    ids: list[int] = response.json()["ids"]
    return ids


async def run_surface(
    client: httpx.AsyncClient, record: Body, cell: CellMode, ran: list[str]
) -> None:
    """prompt → approve where asked → execute, as the interface does it."""
    if cell is CellMode.APPROVE:
        approved = await client.post(url(record["id"], "approve"))
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "approved"
    elif cell is CellMode.OFF:
        refused = await client.post(url(record["id"], "approve"))
        assert (refused.status_code, refused.json()["code"]) == (409, "class_not_allowed")
    executed = await client.post(url(record["id"], "execute"))
    if cell is CellMode.OFF:
        assert (executed.status_code, executed.json()["code"]) == (409, "not_approved")
        assert ran == []
        return
    assert executed.status_code == 200, executed.text
    body = executed.json()
    assert body["action"]["status"] == "applied"
    assert body["action"]["decision"] == ("auto" if cell is CellMode.AUTO else "accepted")
    assert body["action"]["stamp"]["count"] == len(body["result"]["features"])
    assert len(ran) == 1
    ran.clear()
    hits = sorted(f["id"] for f in body["result"]["features"])
    assert hits == await modus_a(client, record["query"])


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("row", ROWS, ids=[r.name for r in ROWS])
async def test_enforcement_matrix(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    other: httpx.AsyncClient,
    ran: list[str],
    row: Row,
    path: str,
) -> None:
    record = await set_up(client, app, model, row)
    cell = row.cell
    action_id = record["id"]
    assert record["status"] == ("approved" if cell is CellMode.AUTO else "proposed")
    assert record["governance"]["cell"] == cell.value
    assert set(record["governance"]["off"]) == {
        c for c in touched_classes(row.query) if row.cells[c] == "off"
    }
    calls = len(model.fake.calls)
    ran.clear()

    if path == "surface":
        await run_surface(client, record, cell, ran)

    elif path == "direct":
        # Past the surface: no approve; an id that does not exist is no one's.
        for step in ("approve", "execute"):
            missing = await client.post(url(9999, step))
            assert (missing.status_code, missing.json()["code"]) == (404, "not_found")
        executed = await client.post(url(action_id, "execute"))
        if cell is CellMode.AUTO:
            assert executed.status_code == 200, executed.text
            assert executed.json()["action"]["decision"] == "auto"
            assert len(ran) == 1
        else:
            assert (executed.status_code, executed.json()["code"]) == (409, "not_approved")
            assert ran == []

    elif path == "replay":
        await run_surface(client, record, cell, ran)
        before = list(ran)
        again = await client.post(url(action_id, "execute"))
        code = "not_approved" if cell is CellMode.OFF else "already_decided"
        assert (again.status_code, again.json()["code"]) == (409, code)
        approve = await client.post(url(action_id, "approve"))
        code = "class_not_allowed" if cell is CellMode.OFF else "already_decided"
        assert (approve.status_code, approve.json()["code"]) == (409, code)
        assert ran == before

    elif path == "preview":
        previewed = await client.post(url(action_id, "preview"))
        after = (await client.get(url(action_id))).json()
        if cell is CellMode.OFF:
            assert (previewed.status_code, previewed.json()["code"]) == (409, "class_not_allowed")
            assert ran == [] and after["previewed_at"] is None
        else:
            assert previewed.status_code == 200, previewed.text
            assert len(ran) == 2  # the ids and the total, nothing else
            body = previewed.json()
            assert body["ids"] == await modus_a(client, record["query"])
            assert body["count"] == len(body["ids"])
            total = await client.post("/api/query/count", json={"queries": [{"source": "schulen"}]})
            assert body["total"] == total.json()["counts"][0]
            assert after["status"] == record["status"] and after["previewed_at"] is not None
            assert after["decision"] is None

    elif path == "other_account":
        for method, step in (
            ("POST", "approve"),
            ("POST", "reject"),
            ("POST", "execute"),
            ("POST", "preview"),
            ("POST", "undo"),
            ("POST", "touched"),
        ):
            response = await other.request(method, url(action_id, step), json={})
            assert (response.status_code, response.json()["code"]) == (404, "not_found"), step
        assert ran == []
        assert (await client.get(url(action_id))).json() == record

    elif path == "level_changed":
        # The level is edited after the prompt, every class flipped: the record
        # keeps the level as it was (M7.3), the level now is never consulted.
        flipped = {c: FLIPPED[cell].value for c in row.cells}
        levels = [{**lv, "matrix": flipped} if lv["name"] == row.level else lv for lv in row.levels]
        await install_levels(client, levels)
        kept = (await client.get(url(action_id))).json()
        assert kept["level"] == record["level"] and kept["governance"] == record["governance"]
        if cell is not CellMode.AUTO:
            # Now auto, then off or approve: still no execute without approval.
            early = await client.post(url(action_id, "execute"))
            assert (early.status_code, early.json()["code"]) == (409, "not_approved")
            assert ran == []
        await run_surface(client, record, cell, ran)

    assert len(model.fake.calls) == calls, "no step after the prompt asks the model"


@pytest.mark.parametrize("role", ["user", "admin"])
async def test_a_connection_disabled_after_the_prompt_leaves_the_record_runnable(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    other: httpx.AsyncClient,
    ran: list[str],
    role: str,
) -> None:
    """D2: approve and execute call no model, the stored query runs as the
    caller, so a connection disabled since the prompt does not stop them. The
    disabled connection is never asked again: the next prompt goes to the
    default (C14)."""
    await connect(client)
    extra = await connect(client, name="Extra", is_default=False)
    await install_levels(client, fixture_levels())  # Prüfen, the default: approve
    actor = other if role == "user" else client
    chosen = await actor.put(OPTIONS, json={"connection_id": extra["id"]})
    assert chosen.status_code == 200, chosen.text
    record = await ask(actor, app, model, PLAIN)
    assert (record["connection"]["name"], record["status"]) == ("Extra", "proposed")

    disabled = await client.patch(f"{CONNECTIONS}/{extra['id']}", json={"enabled": False})
    assert disabled.status_code == 200, disabled.text
    calls = len(model.fake.calls)
    ran.clear()

    assert (await actor.post(url(record["id"], "approve"))).status_code == 200
    executed = await actor.post(url(record["id"], "execute"))
    assert executed.status_code == 200, executed.text
    assert executed.json()["action"]["decision"] == "accepted"
    assert executed.json()["action"]["connection"]["name"] == "Extra"  # as it was
    assert len(ran) == 1 and len(model.fake.calls) == calls

    after = await ask(actor, app, model, PLAIN)
    assert after["connection"]["name"] == "Lokal"


async def test_without_an_enabled_connection_nothing_is_asked_or_run(
    client: httpx.AsyncClient, app: FastAPI, model: Model, ran: list[str]
) -> None:
    await connect(client, enabled=False, is_default=False)
    response = await client.post(PROMPT, json={"text": "Primarschulen bitte"})
    assert (response.status_code, response.json()["code"]) == (409, "connection_not_available")
    assert model.fake.calls == [] and ran == []


async def test_a_level_users_may_not_choose_never_governs_their_answer(
    client: httpx.AsyncClient, app: FastAPI, model: Model, ran: list[str]
) -> None:
    """*Automatisch* is not selectable in the fixture: a user's choice of it is
    refused, and the answer is governed by the default (*Prüfen*)."""
    await connect(client)
    ids = await install_levels(client, fixture_levels())
    await sign_in_as(client, "m.keller")
    refused = await choose(client, ids["Automatisch"])
    assert (refused.status_code, refused.json()["code"]) == (400, "level_not_available")
    record = await ask(client, app, model, PLAIN)
    assert (record["level"]["name"], record["status"]) == ("Prüfen", "proposed")
    ran.clear()
    executed = await client.post(url(record["id"], "execute"))
    assert (executed.status_code, executed.json()["code"]) == (409, "not_approved")
    assert ran == []


@pytest.mark.parametrize("query", [DERIVE, DISPLAY], ids=["derive", "display"])
async def test_the_direct_path_never_stores_what_the_controls_cannot_show(
    client: httpx.AsyncClient, app: FastAPI, model: Model, ran: list[str], query: Body
) -> None:
    """The model's answer with a buffer or a symbology is refused (D3): no query
    is stored, so nothing can run, whatever the level."""
    await connect(client)
    ids = await install_levels(client, fixture_levels())
    await choose(client, ids["Automatisch"])
    record = await ask(client, app, model, query)
    assert (record["status"], record["refusal"]["code"]) == ("refused", "not_representable")
    ran.clear()
    for step in ("approve", "execute"):
        response = await client.post(url(record["id"], step))
        assert (response.status_code, response.json()["code"]) == (409, "already_decided")
    preview = await client.post(url(record["id"], "preview"))
    assert (preview.status_code, preview.json()["code"]) == (409, "already_decided")
    assert ran == []


# --- execute -------------------------------------------------------------------------


@pytest.fixture
async def auto(client: httpx.AsyncClient, app: FastAPI, model: Model) -> dict[str, int]:
    """A connection and the fixture's levels, the administrator on *Automatisch*."""
    await connect(client)
    ids = await install_levels(client, fixture_levels())
    await choose(client, ids["Automatisch"])
    return ids


async def test_execute_runs_the_stored_query_and_ignores_a_sent_one(
    client: httpx.AsyncClient, app: FastAPI, model: Model, auto: dict[str, int], ran: list[str]
) -> None:
    record = await ask(client, app, model, NEAR)
    ran.clear()
    sent = {"schema_version": "2", "source": "gemeinden"}
    executed = await client.post(url(record["id"], "execute"), json=sent)

    assert executed.status_code == 200, executed.text
    body = executed.json()
    assert len(ran) == 1 and "lyr_gemeinden" not in ran[0]
    reference = await client.post("/api/query", json=NEAR)  # Modus A, same shape
    assert body["result"]["query"] == reference.json()["query"]
    assert [f["id"] for f in body["result"]["features"]] == [
        f["id"] for f in reference.json()["features"]
    ]
    assert body["result"]["meta"]["query_hash"] == reference.json()["meta"]["query_hash"]
    action = body["action"]
    assert action["query"] == record["query"] == compact(QueryObject.model_validate(NEAR))
    stamp = action["stamp"]
    assert stamp["count"] == len(body["result"]["features"])
    assert stamp["query_hash"] == reference.json()["meta"]["query_hash"]
    # The stamp is the one the engine gives the query (sessions, saved queries).
    stored = (await client.get(url(record["id"]))).json()
    assert stored["stamp"] == stamp and "features" not in stored


async def test_execute_runs_as_the_caller(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    backend_of_client: DataBackend,
    ran: list[str],
) -> None:
    """A layer hidden from the account after the prompt: the stored query runs
    with the account's visibility now and finds no such layer."""
    await connect(client)
    ids = await install_levels(client, fixture_levels())
    await sign_in_as(client, "m.keller")
    await choose(client, ids["Prüfen"])
    record = await ask(client, app, model, NEAR)
    assert (await client.post(url(record["id"], "approve"))).status_code == 200
    set_visible(backend_of_client.engine, "strassen", "user", False)
    ran.clear()
    for method, step in (("POST", "preview"), ("POST", "execute")):
        response = await client.request(method, url(record["id"], step))
        assert (response.status_code, response.json()["code"]) == (400, "unknown_layer"), step
    assert ran == []
    assert (await client.get(url(record["id"]))).json()["status"] == "approved"


async def test_execute_keeps_the_result_size_limit(
    client: httpx.AsyncClient, app: FastAPI, model: Model, auto: dict[str, int], ran: list[str]
) -> None:
    """The test instance allows 100 features; all schools are more."""
    record = await ask(client, app, model, {"schema_version": "2", "source": "schulen"})
    executed = await client.post(url(record["id"], "execute"))
    assert (executed.status_code, executed.json()["code"]) == (413, "result_too_large")
    assert (await client.get(url(record["id"]))).json()["status"] == "approved"


async def test_reject_keeps_the_reason_and_ends_the_proposal(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    await connect(client)
    record = await ask(client, app, model, PLAIN)  # Prüfen, the default
    rejected = await client.post(url(record["id"], "reject"), json={"reason": "wrong_layer"})
    assert rejected.status_code == 200, rejected.text
    body = rejected.json()
    assert (body["status"], body["decision"], body["reject_reason"]) == (
        "rejected",
        "rejected",
        "wrong_layer",
    )
    bad = await client.post(url(record["id"], "reject"), json={"reason": "angry"})
    assert bad.status_code == 422
    for step in ("approve", "execute", "reject"):
        again = await client.post(url(record["id"], step), json={})
        assert (again.status_code, again.json()["code"]) == (409, "already_decided"), step


async def test_concurrent_approve_and_reject_have_one_winner(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    await connect(client)
    for _ in range(4):
        record = await ask(client, app, model, PLAIN)
        approve, reject = await asyncio.gather(
            client.post(url(record["id"], "approve")),
            client.post(url(record["id"], "reject"), json={"reason": "other"}),
        )
        statuses = sorted([approve.status_code, reject.status_code])
        assert statuses == [200, 409], (approve.text, reject.text)
        loser = approve if approve.status_code == 409 else reject
        assert loser.json()["code"] in ("already_decided", "not_approved")
        final = (await client.get(url(record["id"]))).json()
        winner = "approved" if approve.status_code == 200 else "rejected"
        assert final["status"] == winner


async def test_concurrent_executes_run_the_query_once(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    auto: dict[str, int],
    ran: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The first execute holds the engine; the second, meanwhile, is refused
    without running anything (the action is claimed before it runs)."""
    record = await ask(client, app, model, PLAIN)
    ran.clear()
    entered, release = threading.Event(), threading.Event()
    backend_type = type(app.state.geotandem.backend)
    logged = backend_type.execute  # the ``ran`` observer

    def held(self: DataBackend, stmt: Select[Any], limits: Limits) -> list[dict[str, Any]]:
        entered.set()
        assert release.wait(10)
        return logged(self, stmt, limits)

    monkeypatch.setattr(backend_type, "execute", held)
    first = asyncio.create_task(client.post(url(record["id"], "execute")))
    assert await asyncio.to_thread(entered.wait, 10)
    second, third = await asyncio.gather(
        client.post(url(record["id"], "execute")), client.post(url(record["id"], "execute"))
    )
    release.set()
    done = await first

    assert done.status_code == 200, done.text
    for refused in (second, third):
        assert (refused.status_code, refused.json()["code"]) == (409, "already_decided")
    assert len(ran) == 1
    replay = await client.post(url(record["id"], "execute"))
    assert (replay.status_code, replay.json()["code"]) == (409, "already_decided")
    assert len(ran) == 1


# --- governance (M6.3) ----------------------------------------------------------


async def test_a_mixed_level_names_each_class_and_why(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    """Teilautonom with a buffer: query auto, derive approve; the whole answer
    waits for approval because of derive."""
    await connect(client)
    ids = await install_levels(client, fixture_levels())
    await choose(client, ids["Teilautonom"])
    record = seed(app, "admin", DERIVE, "Teilautonom")
    assert record["governance"] == {
        "classes": ["query", "derive"],
        "cell": "approve",
        "needs_approval": ["derive"],
        "off": [],
    }
    # Every class has its cell: off, needs approval, or else auto.
    view = (await client.get(url(record["id"]))).json()
    assert view["governance"] == record["governance"]


# --- the preview (P2) ------------------------------------------------------------


async def test_the_preview_is_for_an_interactive_session_only(
    client: httpx.AsyncClient, app: FastAPI, model: Model, ran: list[str]
) -> None:
    await connect(client)
    record = await ask(client, app, model, PLAIN)  # Prüfen
    ran.clear()
    token = {"Authorization": "Bearer gt_mcp_4f1c9a7e2b8d4c6a9e1f3b5d7c9a1e3f"}

    # A token beside the login cookie, or a token alone.
    with_cookie = await client.post(url(record["id"], "preview"), headers=token)
    assert (with_cookie.status_code, with_cookie.json()["code"]) == (403, "session_required")
    for scheme in ("bearer", "Token", "Negotiate"):
        other_scheme = {"Authorization": f"{scheme} gt_mcp_4f1c9a7e"}
        refused = await client.post(url(record["id"], "preview"), headers=other_scheme)
        assert (refused.status_code, refused.json()["code"]) == (403, "session_required")
    alone = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    async with alone:
        response = await alone.post(url(record["id"], "preview"), headers=token)
    assert (response.status_code, response.json()["code"]) == (401, "not_authenticated")

    # A credential that signs in an account but is not the login cookie, as a
    # model or MCP token will (E4): the account is known, the preview refused.
    admin = account_of(app, "admin")

    def by_token(request: Request) -> Account:
        request.state.credential = "token"
        return admin

    app.dependency_overrides[signed_in] = by_token
    try:
        refused = await client.post(url(record["id"], "preview"))
        assert (refused.status_code, refused.json()["code"]) == (403, "session_required")
        assert (await client.get(url(record["id"]))).status_code == 200
    finally:
        del app.dependency_overrides[signed_in]
    assert ran == []
    assert (await client.get(url(record["id"]))).json()["previewed_at"] is None

    allowed = await client.post(url(record["id"], "preview"))
    assert allowed.status_code == 200, allowed.text
    # A reverse proxy's Basic authentication in front is no token.
    proxy = {"Authorization": "Basic cHJveHk6c2VjcmV0"}
    behind_proxy = await client.post(url(record["id"], "preview"), headers=proxy)
    assert behind_proxy.status_code == 200, behind_proxy.text


async def test_the_preview_changes_no_status_and_never_reaches_the_model(
    client: httpx.AsyncClient, app: FastAPI, model: Model, auto: dict[str, int]
) -> None:
    record = await ask(client, app, model, NEAR)
    calls = list(model.fake.calls)
    first = await client.post(url(record["id"], "preview"))
    second = await client.post(url(record["id"], "preview"))
    assert first.json() == second.json()
    view = (await client.get(url(record["id"]))).json()
    assert (view["status"], view["decision"]) == ("approved", None)
    assert view["previewed_at"] is not None
    assert model.fake.calls == calls
    # execute re-runs the stored query, never the preview's result (P2 rule 5).
    executed = (await client.post(url(record["id"], "execute"))).json()
    assert sorted(f["id"] for f in executed["result"]["features"]) == first.json()["ids"]
    after = await client.post(url(record["id"], "preview"))
    assert (after.status_code, after.json()["code"]) == (409, "already_decided")


# --- undo and the hand edit ----------------------------------------------------------


async def executed(client: httpx.AsyncClient, app: FastAPI, model: Model) -> Body:
    record = await ask(client, app, model, PLAIN)
    response = await client.post(url(record["id"], "execute"))
    assert response.status_code == 200, response.text
    action: Body = response.json()["action"]
    return action


async def test_undo_takes_back_the_last_model_change_for_the_log(
    client: httpx.AsyncClient, app: FastAPI, model: Model, auto: dict[str, int], ran: list[str]
) -> None:
    first = await executed(client, app, model)
    last = await executed(client, app, model)
    ran.clear()
    earlier = await client.post(url(first["id"], "undo"))
    assert (earlier.status_code, earlier.json()["code"]) == (409, "nothing_to_undo")
    undone = await client.post(url(last["id"], "undo"))
    assert undone.status_code == 200, undone.text
    body = undone.json()
    assert (body["status"], body["decision"]) == ("undone", "auto") and body["undone_at"]
    again = await client.post(url(last["id"], "undo"))
    assert (again.status_code, again.json()["code"]) == (409, "already_decided")
    assert ran == []  # the client restores the analysis; the server runs nothing


async def test_a_hand_edit_after_the_change_blocks_its_undo(
    client: httpx.AsyncClient, app: FastAPI, model: Model, auto: dict[str, int]
) -> None:
    action = await executed(client, app, model)
    touched = await client.post(url(action["id"], "touched"))
    assert touched.status_code == 200, touched.text
    assert (touched.json()["status"], touched.json()["decision"]) == ("applied", "auto")
    assert action["touched_at"] is None and touched.json()["touched_at"] is not None
    again = await client.post(url(action["id"], "touched"))
    assert again.status_code == 200  # the first report's time stays
    assert again.json()["touched_at"] == touched.json()["touched_at"]

    blocked = await client.post(url(action["id"], "undo"))
    assert (blocked.status_code, blocked.json()["code"]) == (409, "undo_blocked")
    assert (await client.get(url(action["id"]))).json()["status"] == "applied"


async def test_an_approved_change_is_undone_too_and_touched_needs_an_applied_one(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    await connect(client)
    record = await ask(client, app, model, PLAIN)  # Prüfen
    early = await client.post(url(record["id"], "touched"))
    assert (early.status_code, early.json()["code"]) == (409, "nothing_to_undo")
    assert (await client.post(url(record["id"], "approve"))).status_code == 200
    applied = (await client.post(url(record["id"], "execute"))).json()["action"]
    assert applied["decision"] == "accepted"
    undone = (await client.post(url(record["id"], "undo"))).json()
    assert (undone["status"], undone["decision"]) == ("undone", "accepted")
    late = await client.post(url(record["id"], "touched"))
    assert (late.status_code, late.json()["code"]) == (409, "nothing_to_undo")


# --- superseding and the start-up check ---------------------------------------------


async def test_a_new_prompt_closes_an_unexecuted_auto_answer(
    client: httpx.AsyncClient, app: FastAPI, model: Model, auto: dict[str, int], ran: list[str]
) -> None:
    first = await ask(client, app, model, PLAIN)
    assert first["status"] == "approved"
    second = await ask(client, app, model, PLAIN)
    closed = (await client.get(url(first["id"]))).json()
    assert (closed["status"], closed["decision"]) == ("superseded", "superseded")
    ran.clear()
    late = await client.post(url(first["id"], "execute"))
    assert (late.status_code, late.json()["code"]) == (409, "already_decided")
    assert ran == []
    assert (await client.get(url(second["id"]))).json()["status"] == "approved"


async def test_the_start_up_check_closes_an_auto_answer_left_unexecuted(
    client: httpx.AsyncClient, app: FastAPI, model: Model, auto: dict[str, int]
) -> None:
    """Timed from when the answer arrived (the call's start plus its latency),
    not from the prompt: a slow answer still gets its whole window."""
    record = await ask(client, app, model, PLAIN)
    engine = app.state.geotandem.backend.engine
    with Session(engine) as db, db.begin():
        row = db.get(ModelAction, record["id"])
        assert row is not None and row.called_at is not None
        row.called_at = row.created_at + timedelta(seconds=100)
        row.latency_ms = 15_000
        arrived = row.created_at + timedelta(seconds=115)

    def at(seconds: float) -> Callable[[], Any]:
        return lambda: arrived + timedelta(seconds=seconds)

    assert close_stale(engine, at(-115 + MODEL_CALL_S + 5)) == []  # by the prompt: over
    assert close_stale(engine, at(MODEL_CALL_S - 5)) == []
    assert (await client.get(url(record["id"]))).json()["status"] == "approved"
    assert close_stale(engine, at(MODEL_CALL_S + 5)) == [record["id"]]
    closed = (await client.get(url(record["id"]))).json()
    assert (closed["status"], closed["decision"]) == ("superseded", "superseded")


async def test_an_administrator_reads_but_does_not_decide_another_accounts_record(
    client: httpx.AsyncClient, app: FastAPI, model: Model, ran: list[str]
) -> None:
    await connect(client)
    await sign_in_as(client, "m.keller")
    record = await ask(client, app, model, PLAIN)
    await sign_in(client, "admin", ADMIN_PASSWORD)
    assert (await client.get(url(record["id"]))).status_code == 200
    ran.clear()
    for method, step in (("POST", "approve"), ("POST", "execute"), ("POST", "preview")):
        response = await client.request(method, url(record["id"], step))
        assert (response.status_code, response.json()["code"]) == (404, "not_found"), step
    assert ran == []
