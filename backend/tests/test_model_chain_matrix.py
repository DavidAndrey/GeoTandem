"""The enforcement matrix again, for the tool chain (plan 5.3, E2.5; WP75).

Level cell by operation class by path, as ``test_model_enforcement.py`` runs
it for the direct query, with a chain that touches the class under test: a
filter (``query``), a relation between two filters (``spatial``), a buffer
that a relation reads (``derive``, which a direct answer cannot carry, D3,
and which the chain reaches here through the model's plan). No chain step
writes a ``catalog`` or ``display`` part, so their cells never govern, as for
the direct query. The chain is governed by the union of its steps' classes,
its steps one by one by their own cells: it runs only where the cell allows,
halts before a step whose cell is ``approve``, and every other combination
answers with its exact code and runs nothing in the engine (``ran``).
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from api_helpers import USER_PASSWORD
from chain_fixtures import (
    BUFFER,
    MUNICIPALITIES,
    SCHOOLS,
    Body,
    Step,
    planned,
    record,
    run,
    settle,
    statuses,
)
from fastapi import FastAPI
from model_fixtures import case, completion
from test_model_bypass import Model
from test_model_enforcement import (
    PROMPT,
    PRUEFEN,
    STRICTNESS,
    choose,
    connect,
    fixture_levels,
    import_areas,
    install_levels,
    matrix,
    url,
)

from geotandem.data import DataBackend, Limits
from geotandem.levels import CellMode, OpClass
from geotandem.llm import Completion
from geotandem_query import QueryObject, canonical_json

CHAIN_OF: dict[OpClass, list[Step]] = {
    OpClass.CATALOG: [SCHOOLS],
    OpClass.QUERY: [SCHOOLS],
    OpClass.SPATIAL: [SCHOOLS, MUNICIPALITIES, ("within", {"of": 1, "in": 2})],
    OpClass.DERIVE: [SCHOOLS, BUFFER, ("within", {"of": 1, "in": 2})],
    OpClass.DISPLAY: [SCHOOLS],
}
"""A chain per class; catalog and display: no step writes them."""
CLASSES_OF: dict[OpClass, list[set[OpClass]]] = {
    OpClass.QUERY: [{OpClass.QUERY}],
    OpClass.SPATIAL: [{OpClass.QUERY}, {OpClass.QUERY}, {OpClass.SPATIAL}],
    OpClass.DERIVE: [{OpClass.QUERY}, {OpClass.DERIVE, OpClass.QUERY}, {OpClass.SPATIAL}],
}
"""Each step's classes, written out for the test, not taken from ``classify``."""
REFERENCE_STEPS: list[set[OpClass]] = [
    {OpClass.QUERY},
    {OpClass.DERIVE, OpClass.QUERY},
    {OpClass.SPATIAL},
    {OpClass.QUERY},
    {OpClass.SPATIAL},
]


@dataclass(frozen=True)
class Row:
    name: str
    levels: tuple[Body, ...]
    level: str
    chain: list[Step] | None
    """``None``: the fixture's reference chain (needs the tax rates)."""
    steps: list[set[OpClass]]

    @property
    def cells(self) -> dict[str, str]:
        return next(lv["matrix"] for lv in self.levels if lv["name"] == self.level)

    def cell_of(self, classes: set[OpClass]) -> CellMode:
        return max((CellMode(self.cells[c]) for c in classes), key=STRICTNESS.index)

    @property
    def step_cells(self) -> list[CellMode]:
        return [self.cell_of(classes) for classes in self.steps]

    @property
    def cell(self) -> CellMode:
        """The strictest over the union of the steps' classes (D1, H4)."""
        return self.cell_of(set().union(*self.steps))

    @property
    def halts(self) -> int:
        """Approvals the surface gives: one for a chain none of whose steps is
        ``auto``, else the start and one per further ``approve`` step."""
        cells = self.step_cells
        if self.cell is CellMode.AUTO:
            return 0
        if CellMode.AUTO not in cells:
            return 1
        return 1 + sum(c is CellMode.APPROVE for c in cells[1:])

    def answer(self) -> Completion:
        if self.chain is None:
            found = completion(case("chain_reference"))
            assert isinstance(found, Completion)
            return found
        return planned(*self.chain)


def cell_row(op_class: OpClass, cell: CellMode) -> Row:
    level = {"name": "Zelle", "selectable": True, "matrix": matrix(**{op_class.value: cell.value})}
    steps = CLASSES_OF.get(op_class, [{OpClass.QUERY}])
    return Row(
        f"{op_class.value}-{cell.value}", (PRUEFEN, level), "Zelle", CHAIN_OF[op_class], steps
    )


ROWS = [cell_row(c, m) for c in OpClass for m in CellMode] + [
    Row(f"{name}-reference", tuple(fixture_levels()), name, None, REFERENCE_STEPS)
    for name in ("Assistenz", "Prüfen", "Teilautonom", "Automatisch")
]
PATHS = ["surface", "direct", "replay", "query_routes", "other_account", "level_changed"]


def test_the_rows_cover_every_cell() -> None:
    assert len({(r.name.split("-")[0], r.cells[r.name.split("-")[0]]) for r in ROWS[:15]}) == 15
    # No step writes catalog or display: their cells never govern.
    for row in ROWS[:3] + ROWS[12:15]:
        assert row.cell is CellMode.AUTO, row.name
    derive = {r.name: r for r in ROWS}
    assert derive["derive-approve"].step_cells == [CellMode.AUTO, CellMode.APPROVE, CellMode.AUTO]
    assert derive["derive-off"].cell is CellMode.OFF
    expect = case("chain_reference")["expect"]["status"]
    for level, status in expect.items():
        row = derive[f"{level}-reference"]
        assert (row.cell is CellMode.AUTO) == (status == "approved"), level


@pytest.fixture
def ran(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The engine's query log: every statement the data core executes."""
    log: list[str] = []
    backend_type = type(app.state.geotandem.backend)
    original = backend_type.execute

    def execute(self: DataBackend, stmt: Any, limits: Limits) -> list[dict[str, Any]]:
        log.append(str(stmt))
        return original(self, stmt, limits)

    monkeypatch.setattr(backend_type, "execute", execute)
    return log


@pytest.fixture
async def model(app: FastAPI, client: httpx.AsyncClient) -> AsyncIterator[Model]:
    fake = Model()
    app.state.geotandem.client_factory = fake
    yield fake
    fake.released.set()
    await settle(app)


@pytest.fixture
async def other(app: FastAPI, client: httpx.AsyncClient) -> AsyncIterator[httpx.AsyncClient]:
    created = await client.post("/api/admin/users", json={"username": "b.muster", "role": "user"})
    assert created.status_code == 201, created.text
    first = created.json()["start_password"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as them:
        await them.post("/api/auth/login", json={"username": "b.muster", "password": first})
        await them.post("/api/auth/password", json={"current": first, "new": USER_PASSWORD})
        yield them


async def set_up(client: httpx.AsyncClient, app: FastAPI, model: Model, row: Row) -> Body:
    """The levels of ``row``, its level chosen, its chain planned: the record."""
    await connect(client)
    if row.chain is None:
        import_areas(app.state.geotandem.backend)
    ids = await install_levels(client, list(row.levels))
    chosen = await choose(client, ids[row.level])
    assert chosen.status_code == 200, chosen.text
    model.fake.script.append(row.answer())
    response = await client.post(PROMPT, json={"text": "Schulen?", "approach": "chain"})
    assert response.status_code == 202, response.text
    await settle(app)
    return await record(client, response.json()["id"])


async def run_surface(
    client: httpx.AsyncClient, app: FastAPI, record_: Body, row: Row, ran: list[str]
) -> None:
    """As the interface walks it: approve where it waits, run, adopt."""
    action_id = record_["id"]
    if row.cell is CellMode.OFF:
        for method, step, code in (
            ("POST", "approve", "class_not_allowed"),
            ("POST", "run", "not_approved"),
            ("POST", "adopt", "not_approved"),
        ):
            response = await client.request(method, url(action_id, step))
            assert (response.status_code, response.json()["code"]) == (409, code), step
        assert ran == []
        return
    approvals = 0
    for _ in range(10):
        current = await record(client, action_id)
        if current["status"] == "proposed":
            waiting = [s["position"] for s in current["steps"] if s["status"] == "waiting"]
            if waiting:  # a halt: before a step whose own cell is approve
                assert row.step_cells[waiting[0] - 1] is CellMode.APPROVE
            approved = await client.post(url(action_id, "approve"))
            assert approved.status_code == 200, approved.text
            approvals += 1
        elif current["status"] == "approved":
            await run(client, app, action_id)
        else:
            break
    assert current["status"] == "done", current
    assert approvals == row.halts
    assert statuses(current) == ["ok"] * len(row.steps)
    assert len(ran) == len(row.steps) + 1  # every step counted, the result stamped
    ran.clear()
    adopted = await client.post(url(action_id, "adopt"))
    assert adopted.status_code == 200, adopted.text
    action = adopted.json()["action"]
    assert (action["status"], action["decision"]) == ("applied", "accepted")
    assert len(ran) == 1
    ran.clear()
    ids = await client.post("/api/query/ids", json=current["query"])  # Modus A, the user's
    found = sorted(f["id"] for f in adopted.json()["result"]["features"])
    assert found == ids.json()["ids"]
    ran.clear()
    last = current["steps"][-1]["query"]
    assert canonical_json(QueryObject.model_validate(current["query"])) == canonical_json(
        QueryObject.model_validate(last)
    )


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("row", ROWS, ids=[r.name for r in ROWS])
async def test_enforcement_matrix_for_chains(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    other: httpx.AsyncClient,
    ran: list[str],
    row: Row,
    path: str,
) -> None:
    proposed = await set_up(client, app, model, row)
    cell = row.cell
    action_id = proposed["id"]
    assert proposed["status"] == ("approved" if cell is CellMode.AUTO else "proposed")
    assert proposed["governance"]["cell"] == cell.value
    assert proposed["proposal_only"] == (cell is CellMode.OFF)
    assert [CellMode(s["cell"]) for s in proposed["steps"]] == row.step_cells
    assert [set(map(OpClass, s["classes"])) for s in proposed["steps"]] == row.steps
    calls = len(model.fake.calls)
    ran.clear()

    if path == "surface":
        await run_surface(client, app, proposed, row, ran)

    elif path == "direct":
        # Past the surface: run without approval, adopt before the end.
        for step in ("run", "adopt"):
            missing = await client.post(url(9999, step))
            assert (missing.status_code, missing.json()["code"]) == (404, "not_found")
        early = await client.post(url(action_id, "adopt"))
        assert (early.status_code, early.json()["code"]) == (409, "not_approved")
        started = await client.post(url(action_id, "run"))
        if cell is CellMode.AUTO:
            assert started.status_code == 202, started.text
            await settle(app)
            assert (await record(client, action_id))["status"] == "done"
            assert len(ran) == len(row.steps) + 1
        else:
            assert (started.status_code, started.json()["code"]) == (409, "not_approved")
            assert ran == []

    elif path == "replay":
        await run_surface(client, app, proposed, row, ran)
        for step in ("adopt", "run", "approve"):
            again = await client.post(url(action_id, step))
            code = "already_decided"
            if cell is CellMode.OFF:
                code = "class_not_allowed" if step == "approve" else "not_approved"
            assert (again.status_code, again.json()["code"]) == (409, code), step
        assert ran == []

    elif path == "query_routes":
        # A chain's query never runs by execute or the preview (its approval may
        # cover a step only), at every cell.
        for step in ("execute", "preview"):
            response = await client.post(url(action_id, step))
            code = "class_not_allowed" if cell is CellMode.OFF and step == "preview" else None
            assert (response.status_code, response.json()["code"]) == (
                409,
                code or "not_approved",
            ), step
        assert ran == []

    elif path == "other_account":
        for method, step, body in (
            ("POST", "approve", None),
            ("POST", "run", None),
            ("POST", "adopt", None),
            ("POST", "abort", None),
            ("PATCH", "plan", {}),
            ("POST", "reject", {}),
            ("GET", "", None),
        ):
            response = await other.request(method, url(action_id, step), json=body)
            assert (response.status_code, response.json()["code"]) == (404, "not_found"), step
        assert ran == []
        assert await record(client, action_id) == proposed

    elif path == "level_changed":
        # Every cell flipped after the prompt: the chain keeps its level (M7.3).
        flipped = {
            c: {"off": "auto", "approve": "auto", "auto": "off"}[cell.value] for c in row.cells
        }
        changed = [
            {**lv, "matrix": flipped} if lv["name"] == row.level else lv for lv in row.levels
        ]
        await install_levels(client, changed)
        kept = await record(client, action_id)
        assert kept["level"] == proposed["level"] and kept["governance"] == proposed["governance"]
        assert [s["cell"] for s in kept["steps"]] == [s["cell"] for s in proposed["steps"]]
        if cell is not CellMode.AUTO:
            early = await client.post(url(action_id, "run"))
            assert (early.status_code, early.json()["code"]) == (409, "not_approved")
            assert ran == []
        await run_surface(client, app, proposed, row, ran)

    assert len(model.fake.calls) == calls, "no step after the planning asks the model"


@pytest.mark.parametrize("cell", [CellMode.APPROVE, CellMode.AUTO], ids=["approve", "auto"])
async def test_a_connection_disabled_after_the_plan_leaves_the_chain_runnable(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    ran: list[str],
    cell: CellMode,
) -> None:
    """D2: approve, run without a re-plan and adopt call no model."""
    row = cell_row(OpClass.DERIVE, cell)
    proposed = await set_up(client, app, model, row)
    for connection in (await client.get("/api/admin/llm/connections")).json():
        off = await client.patch(
            f"/api/admin/llm/connections/{connection['id']}", json={"enabled": False}
        )
        assert off.status_code == 200, off.text
    calls = len(model.fake.calls)
    ran.clear()
    await run_surface(client, app, proposed, row, ran)
    assert len(model.fake.calls) == calls
