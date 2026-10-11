"""No row content reaches the model through a tool chain (D9, D10; plan WP74, S7).

The application as it runs: its data core with the sample, a model connection
set up through the API, the administrator's level, read-only view and layer
profile, and a scripted model. Sentinels sit where a leak would carry them:
in attribute values of the layers the chain reads (one shaped like a name, as
``kantonsstrasse_b`` is), in the coordinates of every feature a step finds,
and in a layer kept from the model, by name and by its rows. The chain plans,
runs, re-plans after an empty step and after an engine error, and every
message the model receives, every turn, every re-plan input, is searched.

A step that names the hidden layer is refused exactly as one that names a
missing layer, and an engine error whose details carry a name-shaped value
reaches the model without it.

Then D10: the connection's data release, flipped through the API, leaves the
model's input the same, byte for byte.
"""

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from chain_fixtures import drive, settle
from fastapi import FastAPI
from sqlalchemy import select, update
from test_model_direct import same_refusal
from test_model_enforcement import CONNECTIONS, PROMPT, account_of, connect
from test_profile import SENTINELS, sentinel_csv

from geotandem.api.state import AppState
from geotandem.catalog import AttributeUpdate, update_attribute
from geotandem.data import Limits
from geotandem.engine import ids_query, run_query
from geotandem.engine.compile import FID, GEOM
from geotandem.engine.errors import UnknownAttribute
from geotandem.importing.run import ImportDecisions, XYReference, run_import
from geotandem.levels import active_level
from geotandem.llm import Completion
from geotandem.llm.fake import FakeLLMClient
from geotandem.model.chain import run as chain_run
from geotandem.model.chain.ask import ChainState, ask, replan_message
from geotandem.model.chain.plan import check_plan
from geotandem.model.chain.run import ChainOutcome, StepRun, run_chain, run_step
from geotandem.model.prompt import Prompt, build_prompt
from geotandem.model.schemas import PlanAnswer, PlannedStep, Refusal
from geotandem.model.service import profile_for, read_view
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


class Setup:
    """What the application resolves for the administrator's chain request."""

    def __init__(self, app: FastAPI) -> None:
        state: AppState = app.state.geotandem
        self.state = state
        self.admin = account_of(app, "admin")
        self.level = active_level(state.backend.engine, self.admin.id, admin=True)
        active = state.connections.active_call(self.admin.id)
        assert active is not None
        self.connection = active[0]
        view, self.profile = profile_for(state.backend, self.admin)
        self.context = state.tool_context(view)

    def prompt(self, text: str) -> Prompt:
        return build_prompt(
            text,
            approach="chain",
            level=self.level,
            profile=self.profile,
            context_length=self.connection.context_length,
        )


def empty_then_revised(setup: Setup) -> tuple[ChainOutcome, FakeLLMClient]:
    model = FakeLLMClient(script=[completion(PLANNED), completion(REVISED)])
    prompt = setup.prompt("Welche Primarschulen liegen nahe an Kantonsstrassen?")
    return run_chain(model, prompt, setup.context, setup.profile), model


def error_then_revised(setup: Setup, app: FastAPI) -> tuple[list[StepRun], FakeLLMClient]:
    """Planned while ``klasse`` was released, run after it was withdrawn: the
    buffer fails in the model's world as it is now, and the model re-plans."""
    model = FakeLLMClient(script=[completion(PLANNED), completion(AFTER_ERROR)])
    prompt = setup.prompt("Primarschulen nahe Strassen?")
    answer = ask(model, prompt.messages, prompt.schema)
    assert isinstance(answer, PlanAnswer)
    checked = check_plan(answer.steps, setup.context, setup.profile)
    assert isinstance(checked, list)
    engine = setup.state.backend.engine
    update_attribute(engine, "strassen", "klasse", AttributeUpdate(for_model=False))
    try:
        _, now = profile_for(setup.state.backend, setup.admin)
        chain = ChainState(prompt, answer, checked)
        runs = []
        while (step := chain.next) is not None:
            run = run_step(step, setup.context, now)
            runs.append(run)
            after = chain.ran(step, run.view)
            if after == "replan":
                revised = ask(model, chain.replan_messages(), prompt.schema)
                assert isinstance(revised, PlanAnswer)
                assert chain.revise(revised, setup.context, now) is None
            else:
                assert after in ("next", "done")
    finally:
        update_attribute(engine, "strassen", "klasse", AttributeUpdate(for_model=True))
    return runs, model


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


def named(setup: Setup, layer: str) -> ChainOutcome:
    """A plan whose first step names ``layer``: refused before anything runs."""
    step = ("filter", {"layer": layer, "where": {"op": "is_null", "attr": "kategorie"}})
    model = FakeLLMClient(script=[completion(plan(step, why="Die Punkte ohne Kategorie."))])
    outcome = run_chain(model, setup.prompt("Punkte?"), setup.context, setup.profile)
    assert outcome.runs == [] and len(model.calls) == 1
    return outcome


EVERY = Limits(max_features=100_000, timeout_s=30)
"""Every feature a step found, for the search; the user's own limit is lower."""


def rows(setup: Setup, queries: list[QueryObject]) -> tuple[set[str], set[str]]:
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

    backend = setup.state.backend
    view = read_view(backend, setup.admin)
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


async def test_no_row_content_reaches_the_model_through_a_chain(
    app: FastAPI, client: httpx.AsyncClient, tmp_path: Path
) -> None:
    await connect(client)
    seed(app.state.geotandem, tmp_path)
    setup = Setup(app)
    outcome, planned = empty_then_revised(setup)
    runs, failed = error_then_revised(setup, app)
    hidden, missing = named(setup, HIDDEN), named(setup, "kitas")

    # The chain did what it should: an empty step, an error, a re-plan after each.
    assert outcome.refusal is None and outcome.replans == 1
    assert outcome.result is not None and (outcome.result.view.count or 0) > 0
    assert [r.view.empty for r in outcome.runs] == [False, True, False, False, False, False]
    assert runs[1].view.code == "unknown_attribute" and runs[1].error is not None
    assert len(planned.calls) == len(failed.calls) == 2
    same_refusal(missing.refusal, hidden.refusal, "kitas", HIDDEN)
    assert hidden.refusal is not None and hidden.refusal.code == "unknown_layer"
    text = sent(planned, failed)
    assert '"empty":true' in text and '"code":"unknown_attribute","part":"klasse"' in text

    # The sentinels are there: in what the steps found, and kept from the profile.
    found = [r.step.query for r in [*outcome.runs, *runs] if r.view.outcome == "ok"]
    values, coordinates = rows(setup, found)
    assert any(IN_A_NAME in v for v in values) and NAME_SHAPED in values
    assert any(float(c) > 1_000_000 for c in coordinates)  # the internal CRS (LV95)
    assert any(float(c) < 90 for c in coordinates)  # WGS84
    assert HIDDEN in setup.state.backend.layer_names() and HIDDEN not in setup.profile.text
    assert "klasse" in runs[1].error.message  # the user's to read, never the model's

    # ... and none reached the model.
    model_wrote = json.dumps([PLANNED, REVISED, AFTER_ERROR], ensure_ascii=False)
    metadata = setup.profile.text
    from_rows = {v for v in values if len(v) >= 5 and v not in model_wrote and v not in metadata}
    assert from_rows, "the sample's rows hold text the model never saw"
    leaked = [s for s in (IN_A_NAME, NAME_SHAPED, HIDDEN, *SENTINELS) if s in text]
    assert leaked == []
    assert [v for v in from_rows if v in text] == []
    assert [c for c in coordinates if c in text] == []


async def test_a_name_shaped_value_in_an_error_never_reaches_the_model(
    app: FastAPI, client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An engine error whose details carry a row value shaped like a name: the
    model wrote it only as a value, so ``part`` drops it, and the re-plan input
    has the code alone."""
    await connect(client)
    seed(app.state.geotandem, tmp_path)
    setup = Setup(app)
    where = {"op": "compare", "attr": "nummer", "cmp": "ne", "value": NAME_SHAPED}
    planned = [
        PlannedStep(text="x", tool="filter", arguments={"layer": "strassen", "where": where})
    ]
    checked = check_plan(planned, setup.context, setup.profile)
    assert not isinstance(checked, Refusal)

    def failing(*_: Any, **__: Any) -> int:
        raise UnknownAttribute(f"No '{NAME_SHAPED}' here.", attribute=NAME_SHAPED)

    monkeypatch.setattr(chain_run, "count_query", failing)
    run = run_step(checked[0], setup.context, setup.profile)
    assert run.error is not None and run.error.details == {"attribute": NAME_SHAPED}
    assert (run.view.code, run.view.part) == ("unknown_attribute", None)
    assert NAME_SHAPED not in replan_message([(1, "filter", run.view)], (), 2)


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
    released: list[bool] = []
    models: list[FakeLLMClient] = []
    for flag in (connection["may_receive_data"], not connection["may_receive_data"]):
        changed = await client.patch(
            f"{CONNECTIONS}/{connection['id']}", json={"may_receive_data": flag}
        )
        assert changed.status_code == 200, changed.text
        shown = (await client.get(CONNECTIONS)).json()
        assert [c["may_receive_data"] for c in shown] == [flag]
        released.append(Setup(app).connection.may_receive_data)
        model = FakeLLMClient(script=[completion(PLANNED), completion(REVISED)])
        app.state.geotandem.client_factory = lambda _endpoint, model=model: model
        text = "Welche Primarschulen liegen nahe an Kantonsstrassen?"
        asked = await client.post(PROMPT, json={"text": text, "approach": "chain"})
        assert asked.status_code == 202, asked.text
        await settle(app)
        done, _ = await drive(client, app, asked.json()["id"])
        assert (done["status"], done["replans"]) == ("done", 1)
        assert [s["model_view"]["empty"] for s in done["steps"]] == [False, True] + [False] * 4
        adopted = await client.post(f"/api/model/actions/{done['id']}/adopt")
        assert adopted.status_code == 200, adopted.text
        assert len(model.calls) == 2
        inputs.append(received(model))
        models.append(model)
    assert released == [True, False]
    assert inputs[0] == inputs[1]
    text = sent(*models)
    assert '"empty":true' in text
    assert [s for s in (IN_A_NAME, NAME_SHAPED, HIDDEN, *SENTINELS) if s in text] == []
