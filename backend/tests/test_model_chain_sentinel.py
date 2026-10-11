"""No row content reaches the model through a tool chain (D9, D10; plan WP74, S7).

The application as it runs, through its API (WP75): its data core with the
sample, a model connection set up through the API, the administrator's level
(*Teilautonom*: the run halts before the buffer, so the next stretch of the
run reads the views of the steps before from the record), read-only view and
layer profile, and a scripted model. Sentinels sit where a leak would carry
them: in attribute values of the layers the chain reads (one shaped like a
name, as ``kantonsstrasse_b`` is), in the coordinates of every feature a step
finds, and in a layer kept from the model, by name and by its rows. The chain
is planned, edited by the user, run, re-planned after an empty step and after
an engine error, and every message the model receives, every turn, every
re-plan input, is searched.

A step that names the hidden layer is refused exactly as one that names a
missing layer, and an engine error whose details carry a name-shaped value
reaches the model without it.

Then D10: the connection's data release, flipped through the API, leaves the
model's input the same, byte for byte.
"""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from chain_fixtures import drive, record, settle
from fastapi import FastAPI
from sqlalchemy import select, update
from test_model_direct import same_refusal
from test_model_enforcement import (
    CONNECTIONS,
    PROMPT,
    account_of,
    connect,
    fixture_levels,
    install_levels,
    url,
)
from test_profile import SENTINELS, sentinel_csv

from geotandem.api.state import AppState
from geotandem.catalog import AttributeUpdate, update_attribute
from geotandem.data import Limits
from geotandem.engine import ids_query, run_query
from geotandem.engine.compile import FID, GEOM
from geotandem.engine.errors import UnknownAttribute
from geotandem.importing.run import ImportDecisions, XYReference, run_import
from geotandem.llm import Completion
from geotandem.llm.fake import FakeLLMClient
from geotandem.model.chain import run as chain_run
from geotandem.model.schemas import Refusal
from geotandem.model.service import read_view
from geotandem_query import QueryObject

Body = dict[str, Any]

NAME_SHAPED = "zz_sentinel_nr"
"""A value that looks like a name (an attribute value of the roads)."""
IN_A_NAME = "ZEBRA-7731"
"""Appended to every school's name."""
HIDDEN = "zz_geheim_sentinel"
"""A layer kept from the model; its rows hold ``SENTINELS``."""

PRIMAR: Body = {"op": "in", "attr": "typ", "values": ["primar"]}
NOWHERE: Body = {"op": "compare", "attr": "klasse", "cmp": "eq", "value": "feldweg"}
ROADS_B: Body = {"op": "compare", "attr": "klasse", "cmp": "eq", "value": "kantonsstrasse_b"}
MUNICIPALITIES: Body = {"op": "compare", "attr": "gem_nr", "cmp": "gt", "value": 0}


def plan(*steps: tuple[str, Body], why: str = "Primarschulen nahe Kantonsstrassen.") -> Body:
    return {
        "kind": "plan",
        "explanation": why,
        "assumptions": [{"text": "„nahe“ = höchstens 500 m"}],
        "steps": [{"text": f"Schritt {t}", "tool": t, "arguments": a} for t, a in steps],
    }


PLANNED = plan(
    ("filter", {"layer": "schulen", "where": PRIMAR}),
    ("buffer", {"layer": "strassen", "distance_m": 500, "where": NOWHERE}),
    ("within", {"of": 1, "in": 2}),
)
"""Step 2 finds nothing: an empty step before the last (P4)."""
REVISED = plan(
    ("buffer", {"layer": "strassen", "distance_m": 500, "where": ROADS_B}),
    ("within", {"of": 1, "in": 3}),
    ("filter", {"layer": "gemeinden", "where": MUNICIPALITIES}),
    ("within", {"of": 4, "in": 5}),
    why="Statt Feldwegen die Kantonsstrassen B.",
)
"""Steps 3 to 6 after the completed 1 and 2."""
AFTER_ERROR = plan(
    ("buffer", {"layer": "strassen", "distance_m": 500}),
    ("within", {"of": 1, "in": 3}),
    why="Ohne Strassenklasse, die nicht mehr da ist.",
)
"""Steps 3 and 4, after step 2 of ``PLANNED`` failed: it keeps its place (WP75)."""


def completion(answer: Body) -> Completion:
    return Completion(text=json.dumps(answer, ensure_ascii=False), parsed=answer)


def seed(state: AppState, tmp_path: Path) -> None:
    """The sentinels, written into the data core as an import or an edit would."""
    backend = state.backend
    schools, roads = backend.layer_table("schulen"), backend.layer_table("strassen")
    with backend.engine.begin() as db:
        db.execute(update(schools).values(name=schools.c.name + f" {IN_A_NAME}"))
        db.execute(
            update(roads).where(roads.c.klasse == "kantonsstrasse_b").values(nummer=NAME_SHAPED)
        )
    run = run_import(
        sentinel_csv(tmp_path),
        "sentinel.csv",
        ImportDecisions(
            layer_name=HIDDEN,
            title="Geheim",
            geo=XYReference(x="E", y="N", crs=2056),
            for_model=False,
        ),
        backend,
        actor="admin",
    )
    assert run.status in ("ok", "warning"), run


async def chain(
    client: httpx.AsyncClient,
    app: FastAPI,
    *answers: Body,
    text: str = "Welche Primarschulen liegen nahe an Kantonsstrassen?",
    edit: Body | None = None,
    before_run: Callable[[], None] | None = None,
) -> tuple[Body, FakeLLMClient]:
    """A chain asked through the API with ``answers`` as the model's plan and
    re-plans, edited (``edit``) and run as the interface walks it."""
    model = FakeLLMClient(script=[completion(a) for a in answers])
    app.state.geotandem.client_factory = lambda _endpoint: model
    asked = await client.post(PROMPT, json={"text": text, "approach": "chain"})
    assert asked.status_code == 202, asked.text
    await settle(app)
    action_id = asked.json()["id"]
    if edit is not None:
        edited = await client.patch(url(action_id, "plan"), json=edit)
        assert edited.status_code == 200, edited.text
    if before_run is not None:
        before_run()
    current = await record(client, action_id)
    if current["status"] in ("proposed", "approved"):
        current, _ = await drive(client, app, action_id)
    return current, model


def sent(*models: FakeLLMClient) -> str:
    """Everything the model received, as text: every message of every call, and
    the schemas and tools (none)."""
    calls = [call for model in models for call in model.calls]
    return "\n".join(
        [m.content for c in calls for m in c.messages]
        + [json.dumps([c.schema, list(c.tools)], ensure_ascii=False) for c in calls]
    )


def received(model: FakeLLMClient) -> bytes:
    """Every call's input, as the bytes D10 compares."""
    return json.dumps(
        [
            [[m.role, m.content] for m in c.messages] + [c.schema, list(c.tools)]
            for c in model.calls
        ],
        ensure_ascii=False,
    ).encode()


EVERY = Limits(max_features=100_000, timeout_s=30)
"""Every feature a step found, for the search; the user's own limit is lower."""


def rows(app: FastAPI, queries: list[QueryObject]) -> tuple[set[str], set[str]]:
    """The text values and the coordinates of every feature the steps found, as
    the user's run returns them (WGS84) and as the data core stores them (the
    internal CRS)."""
    texts: set[str] = set()
    coordinates: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, float):
            coordinates.add(repr(node))

    backend = app.state.geotandem.backend
    view = read_view(backend, account_of(app, "admin"))
    for query in queries:
        for feature in run_query(query, view, EVERY).features:
            texts.update(v for v in feature.properties.values() if isinstance(v, str))
            walk((feature.geometry or {}).get("coordinates"))
        table = backend.layer_table(query.source)
        ids = ids_query(query, view, EVERY)
        stored = select(backend.dialect.as_geojson(table.c[GEOM]).label("g")).where(
            table.c[FID].in_(ids)
        )
        for row in backend.execute(stored, EVERY):
            walk(json.loads(row["g"])["coordinates"])
    return texts, coordinates


@pytest.fixture
async def teilautonom(client: httpx.AsyncClient) -> Body:
    connection = await connect(client)
    ids = await install_levels(client, fixture_levels())
    chosen = await client.put("/api/llm/options", json={"level_id": ids["Teilautonom"]})
    assert chosen.status_code == 200, chosen.text
    return connection


async def test_no_row_content_reaches_the_model_through_a_chain(
    app: FastAPI, client: httpx.AsyncClient, tmp_path: Path, teilautonom: Body
) -> None:
    seed(app.state.geotandem, tmp_path)
    engine = app.state.geotandem.backend.engine

    # Planned, its buffer edited by the user, run with a halt before the buffer,
    # empty at step 2, re-planned with the views read back from the record.
    edit = {
        "change": [
            {
                "position": 2,
                "arguments": {"layer": "strassen", "distance_m": 400, "where": NOWHERE},
            }
        ]
    }
    empty, planned = await chain(client, app, PLANNED, REVISED, edit=edit)

    # Planned while ``klasse`` was released, run after it was withdrawn: the
    # buffer fails in the model's world as it is now, and the model re-plans.
    def withdraw() -> None:
        update_attribute(engine, "strassen", "klasse", AttributeUpdate(for_model=False))

    try:
        failed, erred = await chain(
            client, app, PLANNED, AFTER_ERROR, text="Primarschulen nahe Strassen?",
            before_run=withdraw,
        )  # fmt: skip
    finally:
        update_attribute(engine, "strassen", "klasse", AttributeUpdate(for_model=True))

    step = ("filter", {"layer": HIDDEN, "where": {"op": "is_null", "attr": "kategorie"}})
    hidden, hidden_model = await chain(client, app, plan(step, why="Punkte."), text="Punkte?")
    step = ("filter", {"layer": "kitas", "where": {"op": "is_null", "attr": "kategorie"}})
    missing, missing_model = await chain(client, app, plan(step, why="Punkte."), text="Punkte?")

    # The chain did what it should: an empty step, an error, a re-plan after each.
    assert (empty["status"], empty["replans"]) == ("done", 1)
    assert [s["model_view"]["empty"] for s in empty["steps"]] == [False, True] + [False] * 4
    assert (failed["status"], failed["replans"]) == ("done", 1)
    assert failed["steps"][1]["model_view"]["code"] == "unknown_attribute"
    assert len(planned.calls) == len(erred.calls) == 2
    same_refusal(
        Refusal.model_validate(missing["refusal"]),
        Refusal.model_validate(hidden["refusal"]),
        "kitas",
        HIDDEN,
    )
    assert hidden["refusal"]["code"] == "unknown_layer" and hidden["steps"] == []
    text = sent(planned, erred, hidden_model, missing_model)
    assert '"empty":true' in text and '"code":"unknown_attribute","part":"klasse"' in text
    assert 'Schritt 1 (filter): {"outcome":"ok","empty":false,"count":' in text
    assert "Der Anwender hat den Plan vor dem Lauf angepasst" in text  # edits_message

    # The sentinels are there: in what the steps found, and kept from the profile.
    found = [
        QueryObject.model_validate(s["query"])
        for view in (empty, failed)
        for s in view["steps"]
        if s["model_view"] and s["model_view"]["outcome"] == "ok"
    ]
    values, coordinates = rows(app, found)
    assert any(IN_A_NAME in v for v in values) and NAME_SHAPED in values
    assert any(float(c) > 1_000_000 for c in coordinates)  # the internal CRS (LV95)
    assert any(float(c) < 90 for c in coordinates)  # WGS84
    assert HIDDEN in app.state.geotandem.backend.layer_names()

    # ... and none reached the model.
    model_wrote = json.dumps([PLANNED, REVISED, AFTER_ERROR, edit], ensure_ascii=False)
    profile = planned.calls[0].messages[0].content
    from_rows = {v for v in values if len(v) >= 5 and v not in model_wrote and v not in profile}
    assert from_rows, "the sample's rows hold text the model never saw"
    leaked = [s for s in (IN_A_NAME, NAME_SHAPED, HIDDEN, *SENTINELS) if s in text]
    assert leaked == []
    assert [v for v in from_rows if v in text] == []
    assert [c for c in coordinates if c in text] == []


async def test_a_name_shaped_value_in_an_error_never_reaches_the_model(
    app: FastAPI,
    client: httpx.AsyncClient,
    tmp_path: Path,
    teilautonom: Body,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An engine error whose details carry a row value shaped like a name: the
    model wrote it only as a value, so ``part`` drops it, and the re-plan's
    input, as the application's run writes it, has the code alone."""
    seed(app.state.geotandem, tmp_path)
    where = {"op": "compare", "attr": "nummer", "cmp": "ne", "value": NAME_SHAPED}
    first = plan(("filter", {"layer": "strassen", "where": where}), why="Strassen.")
    again = plan(("filter", {"layer": "strassen", "where": ROADS_B}), why="Anders.")
    original = chain_run.count_query
    failures = iter([True])

    def failing(*args: Any, **kwargs: Any) -> int:
        if next(failures, False):
            raise UnknownAttribute(f"No '{NAME_SHAPED}' here.", attribute=NAME_SHAPED)
        return original(*args, **kwargs)

    monkeypatch.setattr(chain_run, "count_query", failing)
    ended, model = await chain(client, app, first, again, text="Strassen?")

    assert (ended["status"], ended["replans"]) == ("done", 1)
    assert ended["steps"][0]["model_view"] == {
        "outcome": "error",
        "code": "unknown_attribute",
        "part": None,
        "empty": None,
        "count": None,
    }
    replan_input = model.calls[1].messages[-1]
    assert replan_input.role == "user" and '"code":"unknown_attribute"' in replan_input.content
    assert NAME_SHAPED not in replan_input.content


async def test_the_data_release_changes_nothing_the_model_receives(
    app: FastAPI, client: httpx.AsyncClient, tmp_path: Path
) -> None:
    """D10: the flag is stored and shown, and it has no effect in E2.5. On the
    application's path (WP75), where the connection is resolved: flipped
    through the API, a chain asked through the API, approved, run, re-planned
    after its empty step and adopted; every call the model received, byte for
    byte the same, and no sentinel in any."""
    connection = await connect(client)
    seed(app.state.geotandem, tmp_path)
    inputs: list[bytes] = []
    models: list[FakeLLMClient] = []
    for flag in (connection["may_receive_data"], not connection["may_receive_data"]):
        changed = await client.patch(
            f"{CONNECTIONS}/{connection['id']}", json={"may_receive_data": flag}
        )
        assert changed.status_code == 200, changed.text
        shown = (await client.get(CONNECTIONS)).json()
        assert [c["may_receive_data"] for c in shown] == [flag]
        done, model = await chain(client, app, PLANNED, REVISED)
        assert (done["status"], done["replans"]) == ("done", 1)
        assert [s["model_view"]["empty"] for s in done["steps"]] == [False, True] + [False] * 4
        adopted = await client.post(url(done["id"], "adopt"))
        assert adopted.status_code == 200, adopted.text
        assert len(model.calls) == 2
        inputs.append(received(model))
        models.append(model)
    assert [connection["may_receive_data"], not connection["may_receive_data"]] == [True, False]
    assert inputs[0] == inputs[1]
    text = sent(*models)
    assert '"empty":true' in text
    assert [s for s in (IN_A_NAME, NAME_SHAPED, HIDDEN, *SENTINELS) if s in text] == []
