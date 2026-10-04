"""What one query and one account may ask of the server (security review #5, #6)."""

import math
import re
from typing import Any

import anyio
import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session

from geotandem.api.slots import QueriesBusy, QuerySlots
from geotandem.auth import sessions
from geotandem.data import DataBackend
from geotandem.db.orm import AuthSession
from geotandem.engine import complexity

IS_NULL = {"op": "is_null", "attr": "name"}


def query(where: dict[str, Any] | None = None, **parts: Any) -> dict[str, Any]:
    return {"schema_version": "2", "source": "schulen", "where": where, **parts}


def polygon(vertices: int) -> dict[str, Any]:
    ring = [
        [
            7.4 + 0.1 * math.cos(2 * math.pi * i / vertices),
            46.95 + 0.05 * math.sin(2 * math.pi * i / vertices),
        ]
        for i in range(vertices - 1)
    ]
    return {"type": "Polygon", "coordinates": [[*ring, ring[0]]]}


def nested(depth: int) -> dict[str, Any]:
    condition: dict[str, Any] = IS_NULL
    for _ in range(depth - 1):
        condition = {"op": "not", "arg": condition}
    return condition


def configure(app: FastAPI, **changes: Any) -> None:
    state = app.state.geotandem
    state.settings = state.settings.model_copy(update=changes)


# --- #5: bounds on one query -------------------------------------------------------


TOO_LARGE = {
    "values in one list": query({"op": "in", "attr": "fid", "values": list(range(1001))}),
    "values in all conditions": query(
        {"op": "or", "args": [{"op": "in", "attr": "fid", "values": list(range(1000))}] * 6}
    ),
    "conditions": query({"op": "and", "args": [IS_NULL] * 201}),
    "nesting depth": query(nested(21)),
    "vertices of drawn geometries": query({"op": "geometry", "geometry": polygon(10_001)}),
    "text length": query({"op": "text_match", "attr": "name", "text": "x" * 501}),
    "distance_m": query(buffer={"distance_m": 1_000_001}),
    "computed columns": query(
        columns=[{"fn": "distance_to", "name": f"d{i}", "layer": "gewaesser"} for i in range(11)]
    ),
    "entries in 'order_by'": query(order_by=[{"attr": "name"}] * 101),
}


@pytest.mark.parametrize("limit", TOO_LARGE)
async def test_a_query_beyond_a_bound_is_refused_before_it_runs(
    client: httpx.AsyncClient, limit: str
) -> None:
    response = await client.post("/api/query/validate", json=TOO_LARGE[limit])
    assert (response.status_code, response.json()["code"]) == (400, "query_too_complex")
    assert response.json()["details"]["limit"] == limit


async def test_queries_at_the_bounds_run(client: httpx.AsyncClient) -> None:
    at_bounds = [
        query({"op": "in", "attr": "fid", "values": list(range(1000))}),
        query({"op": "and", "args": [IS_NULL] * 199}),  # the "and" counts too
        query(nested(20)),
        query({"op": "geometry", "geometry": polygon(10_000)}),
        query(buffer={"distance_m": 1_000_000}),
    ]
    response = await client.post("/api/query/count", json={"queries": at_bounds})
    assert response.status_code == 200, response.text


async def test_every_way_of_running_a_query_is_bounded(client: httpx.AsyncClient) -> None:
    big = TOO_LARGE["values in one list"]
    for path, body in [
        ("/api/query", big),
        ("/api/query/ids", big),
        ("/api/query/count", {"queries": [query(), big]}),
        ("/api/sessions", {"name": "x", "state_version": 1, "state": {}, "query": big}),
        ("/api/queries", {"name": "x", "state_version": 1, "state": {}, "query": big}),
    ]:
        response = await client.post(path, json=body)
        assert response.json()["code"] == "query_too_complex", path
    counted = await client.post("/api/query/count", json={"queries": [query(), big]})
    assert counted.json()["details"]["index"] == 1


async def test_a_list_beyond_sqlites_variables_is_no_server_error(
    client: httpx.AsyncClient,
) -> None:
    """150 000 values: SQLite's limit of variables, until now answered with a 500."""
    response = await client.post(
        "/api/query/count",
        json={"queries": [query({"op": "in", "attr": "fid", "values": list(range(150_000))})]},
    )
    assert (response.status_code, response.json()["code"]) == (400, "query_too_complex")


def test_vertices_are_counted_without_recursion() -> None:
    deep: list[Any] = [[7.4, 46.9]]
    for _ in range(5_000):
        deep = [deep]
    assert complexity._vertices(deep) == 1
    assert complexity._vertices(polygon(5)["coordinates"]) == 5


# --- #5: queries running at once ---------------------------------------------------


async def test_an_account_waits_for_its_own_slots_not_for_others() -> None:
    slots = QuerySlots(per_account=1, total=8, wait_s=0.05)
    async with slots.hold(1):
        with pytest.raises(QueriesBusy):
            async with slots.hold(1):
                pass
        async with slots.hold(2):  # another account is not held up
            pass
    async with slots.hold(1):  # released
        pass


async def test_the_instance_has_a_total() -> None:
    slots = QuerySlots(per_account=5, total=2, wait_s=0.05)
    async with slots.hold(1), slots.hold(2):
        with pytest.raises(QueriesBusy):
            async with slots.hold(3):
                pass


async def test_a_waiting_query_gets_the_slot_once_it_is_free() -> None:
    slots = QuerySlots(per_account=1, total=8, wait_s=1)
    order = []

    async def first() -> None:
        async with slots.hold(1):
            order.append("first")
            await anyio.sleep(0.05)

    async def second() -> None:
        await anyio.sleep(0.01)
        async with slots.hold(1):
            order.append("second")

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(first)
        tasks.start_soon(second)
    assert order == ["first", "second"]


async def test_a_busy_account_is_answered_busy(client: httpx.AsyncClient, app: FastAPI) -> None:
    state = app.state.geotandem
    state.query_slots = QuerySlots(per_account=1, total=8, wait_s=0.05)
    me = (await client.get("/api/auth/me")).json()["id"]
    async with state.query_slots.hold(me):
        busy = await client.post("/api/query", json=query(limit=5))
        assert (busy.status_code, busy.json()["code"]) == (503, "busy")
        assert busy.headers["retry-after"] == "5"
        # Checking a query runs nothing and needs no slot.
        assert (await client.post("/api/query/validate", json=query())).status_code == 200
    for _ in range(3):  # each query gives its slot back
        assert (await client.post("/api/query", json=query(limit=5))).status_code == 200


# --- #6: what an account may keep --------------------------------------------------


async def test_saved_sessions_per_account_are_capped(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    configure(app, max_sessions_per_account=2)

    def session(name: str) -> dict[str, Any]:
        return {"name": name, "state_version": 1, "state": {}, "query": None}

    first = (await client.post("/api/sessions", json=session("eins"))).json()
    assert (await client.post("/api/sessions", json=session("zwei"))).status_code == 201
    full = await client.post("/api/sessions", json=session("drei"))
    assert (full.status_code, full.json()["code"]) == (409, "too_many_sessions")
    assert full.json()["details"] == {"max": 2}
    copy = await client.post(f"/api/sessions/{first['id']}/duplicate")
    assert (copy.status_code, copy.json()["code"]) == (409, "too_many_sessions")
    await client.delete(f"/api/sessions/{first['id']}")
    assert (await client.post("/api/sessions", json=session("drei"))).status_code == 201


async def test_saved_queries_per_account_are_capped(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    configure(app, max_saved_queries_per_account=1)

    def saved(name: str) -> dict[str, Any]:
        return {"name": name, "state_version": 1, "state": {}, "query": query()}

    first = (await client.post("/api/queries", json=saved("eins"))).json()
    full = await client.post("/api/queries", json=saved("zwei"))
    assert (full.status_code, full.json()["code"]) == (409, "too_many_saved_queries")
    copy = await client.post(f"/api/queries/{first['id']}/duplicate")
    assert (copy.status_code, copy.json()["code"]) == (409, "too_many_saved_queries")


async def test_listings_do_not_read_the_saved_states(
    client: httpx.AsyncClient, backend_of_client: DataBackend
) -> None:
    """A state may have 1 MB; a listing of 100 decoded them all, a second of the
    server's time for every request (security review #15)."""
    state = {"drawn": "x" * 1000}
    session = {"name": "eins", "state_version": 1, "state": state, "query": None}
    saved = {"name": "eins", "state_version": 1, "state": state, "query": query()}
    assert (await client.post("/api/sessions", json=session)).status_code == 201
    assert (await client.post("/api/queries", json=saved)).status_code == 201

    statements: list[str] = []

    def record(_conn: Any, _cursor: Any, statement: str, *_: Any) -> None:
        statements.append(statement)

    event.listen(backend_of_client.engine, "before_cursor_execute", record)
    try:
        assert len((await client.get("/api/sessions")).json()) == 1
        assert len((await client.get("/api/queries")).json()) == 1
    finally:
        event.remove(backend_of_client.engine, "before_cursor_execute", record)
    listings = [s for s in statements if "FROM analysis_session" in s or "FROM saved_query" in s]
    assert len(listings) == 2
    for statement in listings:
        assert not re.search(r"\b(analysis_session|saved_query)\.state\b", statement)


def test_logins_per_account_are_capped(backend: DataBackend) -> None:
    from datetime import timedelta

    from geotandem.auth import accounts

    account = accounts.create(backend.engine, "anna", "korrekt-pferd-batterie", "user")
    lifetime = sessions.Lifetime(timedelta(hours=1), timedelta(days=7))
    tokens = [sessions.start(backend.engine, account.id, lifetime) for _ in range(25)]
    with Session(backend.engine) as db:
        count = db.scalar(
            select(func.count()).select_from(AuthSession).where(AuthSession.user_id == account.id)
        )
    assert count == sessions.MAX_LOGINS
    assert sessions.resolve(backend.engine, tokens[-1], lifetime) is not None
    assert sessions.resolve(backend.engine, tokens[0], lifetime) is None
