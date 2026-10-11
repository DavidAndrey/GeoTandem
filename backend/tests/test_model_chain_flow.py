"""The tool chain through the API (plan E2.3-E2.6, WP75; P4, P7, D1, D9).

The model is scripted behind the client factory; everything else is the
application as it runs, on the sample data: planning in one call, the plan
stored with its steps and governed by the level as it was, the user's edit,
the run in its background thread with its halts, re-plans and limits, abort,
the start-up check, and adoption, the other answer with rows. Effects are
observed where they happen: the engine's query log (``ran``), the calls the
model received, the stored record.

A run's steps are held on an event where a test must see the record while a
step runs; time limits run on an injected clock. Nothing sleeps.
"""

import asyncio
import json
import threading
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import replace
from types import SimpleNamespace
from typing import Annotated, Any

import httpx
import pytest
from api_helpers import sign_in_as
from chain_fixtures import (
    BUFFER,
    MUNICIPALITIES,
    NOWHERE,
    PRIMAR,
    SCHOOLS,
    Body,
    Step,
    drive,
    hits,
    plan,
    planned,
    record,
    run,
    settle,
    statuses,
    stored_chain,
    within,
)
from fastapi import Depends, FastAPI
from model_fixtures import case, completion, fixture
from test_model_direct import context_of, profile_of, with_sample
from test_model_enforcement import (
    PROMPT,
    connect,
    fixture_levels,
    import_areas,
    install_levels,
    url,
)

from geotandem.api.model import prompt_flow
from geotandem.api.state import AppState, get_state
from geotandem.catalog import AttributeUpdate, update_attribute
from geotandem.data import DataBackend, Limits
from geotandem.data import spatialite as spatialite_module
from geotandem.engine.errors import ResultTooLarge
from geotandem.llm import Completion, Endpoint, Message, ModelInfo, ToolSpec
from geotandem.llm.fake import FakeLLMClient
from geotandem.model import service
from geotandem.model.chain import run as chain_run
from geotandem.model.chain.plan import check_plan
from geotandem.model.chain.run import run_step
from geotandem.model.schemas import (
    CHAIN_TIME_LIMIT_S,
    MAX_REPLANS,
    MAX_STEPS,
    ModelView,
    PlanAnswer,
)
from geotandem.model.service import MODEL_CALL_S, PromptFlow, close_stale
from geotandem_query import QueryObject, canonical_json, compact

REFERENCE_CASE = case("chain_reference")
REFERENCE = case("reference")["answer"]["query"]
COUNTS = [62, 37, 37, 37, 10]
"""Hits of the reference chain's steps on the sample (``test_model_chain.py``)."""
Q, S, D = "query", "spatial", "derive"


# --- fixtures ----------------------------------------------------------------------


class Model:
    """The model behind the client factory: ``fake`` answers what the test
    scripts and records every call; ``released`` cleared holds a call."""

    def __init__(self) -> None:
        self.fake = FakeLLMClient()
        self.asked = threading.Event()
        self.released = threading.Event()
        self.released.set()

    def __call__(self, endpoint: Endpoint) -> "Model":
        return self

    def script(self, *answers: Completion) -> None:
        self.fake.script.extend(answers)

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


@pytest.fixture
async def model(app: FastAPI, client: httpx.AsyncClient) -> AsyncIterator[Model]:
    fake = Model()
    app.state.geotandem.client_factory = fake
    yield fake
    fake.released.set()
    await settle(app)


@pytest.fixture
async def levels(client: httpx.AsyncClient, app: FastAPI) -> dict[str, int]:
    """A connection, the fixture's levels and the tax rates of the reference question."""
    await connect(client)
    import_areas(app.state.geotandem.backend)
    return await install_levels(client, fixture_levels())


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


class Held:
    """Holds the run before the given step positions until released."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *positions: int) -> None:
        self.positions = set(positions)
        self.entered = threading.Event()
        self.release = threading.Event()
        original = service.run_step

        def held(step: Any, *args: Any, **kwargs: Any) -> Any:
            if step.position in self.positions:
                self.entered.set()
                assert self.release.wait(10), "the test never released the step"
            return original(step, *args, **kwargs)

        monkeypatch.setattr(service, "run_step", held)

    async def wait(self) -> None:
        assert await asyncio.to_thread(self.entered.wait, 10)


async def choose(client: httpx.AsyncClient, level_id: int) -> None:
    response = await client.put("/api/llm/options", json={"level_id": level_id})
    assert response.status_code == 200, response.text


async def ask_chain(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    answer: Completion,
    text: str = "Welche Primarschulen?",
) -> Body:
    """A chain prompt with ``answer`` as the model's plan; the record once planned."""
    model.script(answer)
    response = await client.post(PROMPT, json={"text": text, "approach": "chain"})
    assert response.status_code == 202, response.text
    assert (response.json()["status"], response.json()["approach"]) == ("thinking", "chain")
    await settle(app)
    return await record(client, response.json()["id"])


def reference_plan() -> Completion:
    return completion(REFERENCE_CASE)


def classes_of(view: Body) -> list[set[str]]:
    return [set(step["classes"]) for step in view["steps"]]


def same_query(found: Body | None, expected: Body) -> bool:
    return found is not None and canonical_json(
        QueryObject.model_validate(found)
    ) == canonical_json(QueryObject.model_validate(expected))


async def modus_a_ids(client: httpx.AsyncClient, query: Body) -> list[int]:
    response = await client.post("/api/query/ids", json=query)
    assert response.status_code == 200, response.text
    ids: list[int] = response.json()["ids"]
    return ids


def with_clock(app: FastAPI, clock: Callable[[], float], model: "Model") -> None:
    """The flow and the model on ``clock``: every time limit of the model path."""
    model.fake.clock = clock

    def flow(state: Annotated[AppState, Depends(get_state)]) -> PromptFlow:
        return replace(prompt_flow(state), monotonic=clock)

    app.dependency_overrides[prompt_flow] = flow


# --- the reference question as a chain (F-5.7, plan WP75 done-when) ------------------


async def test_the_reference_question_as_a_chain_finds_10_of_137(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    ran: list[str],
) -> None:
    """*Prüfen*: the plan of five steps is proposed, one approval covers it,
    the run counts every step (the fixture's hits) and stamps the last, and
    adopting it finds the reference question's 10 of 137 schools, as the
    user's own query finds them in Modus A."""
    proposed = await ask_chain(client, app, model, reference_plan())
    expect = REFERENCE_CASE["expect"]

    assert (proposed["status"], proposed["decision"]) == (expect["status"]["Prüfen"], None)
    assert [s["position"] for s in proposed["steps"]] == [1, 2, 3, 4, 5]
    assert [s["tool"] for s in proposed["steps"]] == [
        s["tool"] for s in REFERENCE_CASE["answer"]["steps"]
    ]
    assert classes_of(proposed) == [{Q}, {D, Q}, {S}, {Q}, {S}]
    assert {s["cell"] for s in proposed["steps"]} == {"approve"}
    assert set(proposed["governance"]["classes"]) == {Q, S, D}
    assert statuses(proposed) == ["planned"] * 5 and proposed["query"] is None
    # Each step is its query object, as the editor writes it; the last is the reference.
    assert same_query(proposed["steps"][-1]["query"], REFERENCE)
    assert proposed["steps"][-1]["query"] == compact(QueryObject.model_validate(REFERENCE))
    assert "layer" not in proposed["steps"][0]
    assert ran == [] and len(model.fake.calls) == 1  # planning ran nothing

    done, approvals = await drive(client, app, proposed["id"])

    assert (done["status"], approvals) == ("done", 1)
    assert hits(done) == COUNTS == [s["model_view"]["count"] for s in done["steps"]]
    assert [s["model_view"] for s in done["steps"]] == [
        {"outcome": "ok", "code": None, "part": None, "empty": False, "count": n} for n in COUNTS
    ]
    assert [s["stamp"] is not None for s in done["steps"]] == [False] * 4 + [True]
    assert done["stamp"]["count"] == expect["hits"] and same_query(done["query"], REFERENCE)
    assert all(s["duration_ms"] is not None for s in done["steps"])
    assert len(ran) == 5 + 1  # five counts, one stamp; no id list, no rows
    assert len(model.fake.calls) == 1  # no re-plan
    # An intermediate result is drawn by the user's own run of its query (M9.1).
    third = await modus_a_ids(client, done["steps"][2]["query"])
    assert len(third) == COUNTS[2]

    ran.clear()
    adopted = await client.post(url(done["id"], "adopt"))

    assert adopted.status_code == 200, adopted.text
    action, result = adopted.json()["action"], adopted.json()["result"]
    assert len(ran) == 1
    assert (action["status"], action["decision"]) == ("applied", "accepted")
    ids = sorted(f["id"] for f in result["features"])
    assert len(ids) == expect["hits"] and ids == await modus_a_ids(client, REFERENCE)
    total = await client.post("/api/query/count", json={"queries": [{"source": "schulen"}]})
    assert total.json()["counts"][0] == expect["total"]
    assert action["stamp"]["count"] == 10 and action["query"] == done["query"]
    assert result["query"]["source"] == "schulen"  # the full dump, the record's is compact
    again = await client.post(url(done["id"], "adopt"))
    assert (again.status_code, again.json()["code"]) == (409, "already_decided")
    # Undo for the log: the adopted chain is the account's last model change.
    assert (await client.post(url(done["id"], "undo"))).status_code == 200


async def test_teilautonom_halts_before_the_buffer(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """Design M8.2, M9.2: ``derive`` needs approval, the rest is ``auto``: the
    first approval starts the chain, the run halts before the buffer
    (``proposed``, the step ``waiting``), the next approval clears it."""
    await choose(client, levels["Teilautonom"])
    proposed = await ask_chain(client, app, model, reference_plan())
    assert proposed["status"] == REFERENCE_CASE["expect"]["status"]["Teilautonom"]
    assert [s["cell"] for s in proposed["steps"]] == ["auto", "approve", "auto", "auto", "auto"]

    assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
    halted = await run(client, app, proposed["id"])

    assert halted["status"] == "proposed" and halted["decision"] is None
    assert statuses(halted) == ["ok", "waiting", "planned", "planned", "planned"]
    assert hits(halted) == [62, None, None, None, None] and halted["query"] is None
    # Neither execute nor the preview runs a chain's query.
    for step in ("execute", "preview"):
        refused = await client.post(url(proposed["id"], step))
        assert (refused.status_code, refused.json()["code"]) == (409, "not_approved"), step

    done, approvals = await drive(client, app, proposed["id"])
    assert (done["status"], approvals) == ("done", 1)
    assert hits(done) == COUNTS


async def test_automatisch_runs_without_a_question_and_adopts_as_accepted(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """All ``auto``: ``approved`` at once, the client runs it (P7), no halt;
    the user still adopts it, and that is ``accepted``."""
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, reference_plan())
    assert approved["status"] == "approved" and approved["governance"]["cell"] == "auto"
    done, approvals = await drive(client, app, approved["id"])
    assert (done["status"], approvals) == ("done", 0)
    adopted = (await client.post(url(done["id"], "adopt"))).json()["action"]
    assert adopted["decision"] == "accepted"


async def test_an_off_class_makes_the_chain_a_proposal_only(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    """D1, *Assistenz*: nothing of the chain runs; the user may apply it by hand."""
    await choose(client, levels["Assistenz"])
    proposed = await ask_chain(client, app, model, reference_plan())
    assert (proposed["status"], proposed["proposal_only"]) == ("proposed", True)
    assert {s["cell"] for s in proposed["steps"]} == {"off"}
    for method, step, code in (
        ("POST", "approve", "class_not_allowed"),
        ("POST", "run", "not_approved"),
        ("PATCH", "plan", "class_not_allowed"),
        ("POST", "adopt", "not_approved"),
        ("POST", "abort", "not_approved"),
    ):
        body = {} if method == "PATCH" else None
        response = await client.request(method, url(proposed["id"], step), json=body)
        assert (response.status_code, response.json()["code"]) == (409, code), step
    decided = await client.post(
        url(proposed["id"], "decide"), json={"decision": "proposal_only", "applied_by_hand": True}
    )
    assert decided.json()["decision"] == "proposal_only"
    assert ran == []


# --- the step limit (F-3.9) ---------------------------------------------------------


async def test_nine_planned_steps_are_refused_eight_pass(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    beyond = case("step_limit")
    refused = await ask_chain(client, app, model, completion(beyond))
    assert (refused["status"], refused["refusal"]["code"]) == ("refused", "step_limit")
    assert refused["refusal"]["details"] == beyond["expect"]["details"]
    assert refused["steps"] == [] and refused["decision"] is None

    eight = beyond["answer"]["steps"][:MAX_STEPS]
    answer = {**beyond["answer"], "steps": eight}
    proposed = await ask_chain(client, app, model, completion({"answer": answer}))
    assert proposed["status"] == "proposed" and len(proposed["steps"]) == MAX_STEPS


EMPTY_THEN: list[Step] = [
    SCHOOLS,
    ("filter", {"of": 1, "where": NOWHERE}),
    MUNICIPALITIES,
    within(2, 3),
]
"""Step 2 finds nothing: an empty step before the last, a re-plan is due."""


def revised(count: int) -> Completion:
    """A re-plan of ``count`` steps after steps 1 and 2: filters on step 1."""
    steps = [("filter", {"of": 1, "where": PRIMAR})] * count
    return planned(*steps, why="Anders.")


@pytest.mark.parametrize(("count", "status"), [(6, "done"), (7, "limited")])
async def test_the_step_limit_counts_the_re_planned_steps(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    count: int,
    status: str,
) -> None:
    """P4: two steps ran and six come: eight in all, the run goes on; seven:
    nine, ``limited`` with ``step_limit`` and the numbers of M9.5."""
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, planned(*EMPTY_THEN))
    model.script(revised(count))
    ended, _ = await drive(client, app, approved["id"])

    assert ended["status"] == status and ended["replans"] == 1
    if status == "done":
        assert [s["position"] for s in ended["steps"]] == list(range(1, 9))
        assert [s["revised"] for s in ended["steps"]] == [False] * 2 + [True] * 6
        assert hits(ended) == [62, 0] + [62] * 6
    else:
        assert ended["stop_reason"] == "step_limit"
        assert ended["error"]["code"] == "step_limit"
        assert ended["error"]["details"] == {"position": 9, "value": 9, "max": MAX_STEPS}
        assert statuses(ended) == ["ok", "empty", "skipped", "skipped"]
        assert same_query(ended["query"], ended["steps"][1]["query"])
        assert ended["stamp"]["count"] == 0


# --- re-plans (P4) --------------------------------------------------------------------


async def test_an_empty_step_before_the_last_is_re_planned(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """The re-plan's input is ``model_view`` of the steps that ran; the steps
    that ran stay, the new ones continue the count, ``revised``."""
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, planned(*EMPTY_THEN))
    model.script(planned(MUNICIPALITIES, within(1, 3), why="Gemeinden statt nichts."))
    done, _ = await drive(client, app, approved["id"])

    assert (done["status"], done["replans"]) == ("done", 1)
    assert [(s["position"], s["status"], s["revised"]) for s in done["steps"]] == [
        (1, "ok", False),
        (2, "empty", False),
        (3, "ok", True),
        (4, "ok", True),
    ]
    first, second = model.fake.calls
    assert second.messages[: len(first.messages)] == first.messages
    plan_turn, seen = second.messages[len(first.messages) :]
    assert plan_turn.role == "assistant" and json.loads(plan_turn.content)["steps"][1]["arguments"]
    assert seen.role == "user"
    assert 'Schritt 2 (filter): {"outcome":"ok","empty":true,"count":0}' in seen.content
    assert "ab Schritt 3" in seen.content and "Die Schritte 1 bis 2 bleiben" in seen.content


async def test_an_empty_last_step_is_the_result(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """P4: 0 hits at the end are shown as the result, not re-planned."""
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(
        client, app, model, planned(SCHOOLS, ("filter", {"of": 1, "where": NOWHERE}))
    )
    done, _ = await drive(client, app, approved["id"])
    assert (done["status"], hits(done), done["replans"]) == ("done", [62, 0], 0)
    assert len(model.fake.calls) == 1
    adopted = (await client.post(url(done["id"], "adopt"))).json()
    assert adopted["result"]["features"] == [] and adopted["action"]["stamp"]["count"] == 0


async def test_an_error_is_re_planned_and_its_step_keeps_its_place(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """Planned while ``klasse`` was released, run after it was withdrawn: the
    step validates at run time and fails in the model's world as it is now;
    the model learns the code and the name it wrote, and re-plans."""
    await choose(client, levels["Automatisch"])
    engine = app.state.geotandem.backend.engine
    approved = await ask_chain(client, app, model, planned(SCHOOLS, BUFFER, within(1, 2)))
    update_attribute(engine, "strassen", "klasse", AttributeUpdate(for_model=False))
    model.script(planned(("buffer", {"layer": "strassen", "distance_m": 500}), within(1, 3)))
    try:
        done, _ = await drive(client, app, approved["id"])
    finally:
        update_attribute(engine, "strassen", "klasse", AttributeUpdate(for_model=True))

    assert (done["status"], done["replans"]) == ("done", 1)
    assert [(s["position"], s["status"]) for s in done["steps"]] == [
        (1, "ok"),
        (2, "error"),
        (3, "ok"),
        (4, "ok"),
    ]
    assert done["steps"][1]["model_view"] == {
        "outcome": "error",
        "code": "unknown_attribute",
        "part": "klasse",
        "empty": None,
        "count": None,
    }
    seen = model.fake.calls[1].messages[-1].content
    assert '"code":"unknown_attribute","part":"klasse"' in seen
    assert "Die Schritte 1 bis 1 bleiben" in seen and "ab Schritt 3" in seen


async def test_a_third_re_plan_is_refused(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """At most ``MAX_REPLANS``: the third empty step stops the run,
    ``replan_limit``, its last complete result adoptable."""
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, planned(*EMPTY_THEN))
    model.script(
        planned(("filter", {"of": 1, "where": NOWHERE}), MUNICIPALITIES, within(3, 4)),
        planned(("filter", {"of": 1, "where": NOWHERE}), MUNICIPALITIES, within(4, 5)),
    )
    ended, _ = await drive(client, app, approved["id"])

    assert (ended["status"], ended["stop_reason"]) == ("limited", "replan_limit")
    assert ended["replans"] == MAX_REPLANS == 2 and len(model.fake.calls) == 3
    assert [s["position"] for s in ended["steps"]] == [1, 2, 3, 4, 5, 6]
    assert statuses(ended) == ["ok", "empty", "empty", "empty", "skipped", "skipped"]
    assert ended["error"] is None
    assert same_query(ended["query"], ended["steps"][3]["query"])  # step 4, empty
    assert ended["stamp"]["count"] == 0


@pytest.mark.parametrize(
    ("level", "halts", "approvals"),
    [("Prüfen", [], 2), ("Teilautonom", [3], 1), ("Automatisch", [], 0)],
)
async def test_a_re_plan_is_approved_again_as_the_level_asks(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    level: str,
    halts: list[int],
    approvals: int,
) -> None:
    """P4: *Prüfen* always (``proposed``, no step waiting), *Teilautonom* for a
    revised step whose cell is ``approve`` (it halts before the new buffer),
    *Automatisch* never."""
    await choose(client, levels[level])
    proposed = await ask_chain(client, app, model, planned(*EMPTY_THEN))
    model.script(planned(BUFFER, within(1, 3), why="Ein Puffer."))
    seen: list[Body] = []
    for _ in range(8):
        current = await record(client, proposed["id"])
        seen.append(current)
        if current["status"] == "proposed":
            assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
        elif current["status"] == "approved":
            await run(client, app, proposed["id"])
        else:
            break
    done = seen[-1]
    assert done["status"] == "done" and hits(done) == [62, 0, 37, 37]
    replanned = [v for v in seen if v["replans"] == 1 and v["status"] == "proposed"]
    waiting = [s["position"] for v in replanned for s in v["steps"] if s["status"] == "waiting"]
    assert waiting == halts
    if level == "Prüfen":
        assert [s["status"] for s in replanned[0]["steps"][2:]] == ["planned", "planned"]
    approved_at_start = proposed["status"] == "approved"
    assert sum(v["status"] == "proposed" for v in seen) == approvals
    assert approved_at_start == (level != "Prüfen")


# --- limits at the boundary (F-3.9, F-9.6, P4) ----------------------------------------


@pytest.mark.parametrize(("limit", "status"), [(10, "done"), (9, "limited")])
async def test_the_result_size_limit_at_the_last_step(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    limit: int,
    status: str,
) -> None:
    """The last step's 10 hits within a limit of 10, beyond one of 9: then
    ``result_too_large`` with the numbers; intermediate counts may exceed it."""
    state: AppState = app.state.geotandem
    state.settings = state.settings.model_copy(update={"max_features": limit})
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, reference_plan())
    ended, _ = await drive(client, app, approved["id"])

    assert ended["status"] == status
    if status == "limited":
        assert ended["stop_reason"] == "result_too_large"
        assert ended["error"]["details"] == {"position": 5, "value": 10, "max": 9}
        assert ended["steps"][4]["model_view"]["code"] == "result_too_large"
        assert ended["steps"][4]["hits"] is None
        # Step 4 (37) is beyond the limit too: nothing to adopt.
        assert ended["query"] is None and ended["stamp"] is None
        refused = await client.post(url(ended["id"], "adopt"))
        assert (refused.status_code, refused.json()["code"]) == (409, "not_approved")
    else:
        assert ended["stamp"]["count"] == 10


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> DataBackend:
    return with_sample(tmp_path_factory.mktemp("chain-limits"))


def checked_step(world: DataBackend, *steps: Step) -> Any:
    answer = PlanAnswer.model_validate(plan(*steps))
    found = check_plan(answer.steps, context_of(world), profile_of(world))
    assert isinstance(found, list), found
    return found


@pytest.mark.parametrize(("count", "fails"), [(10_000, False), (10_001, True)])
def test_the_result_size_limit_is_10_000_objects(
    world: DataBackend, monkeypatch: pytest.MonkeyPatch, count: int, fails: bool
) -> None:
    """The default limit (F-9.6): exactly 10 000 objects pass, 10 001 do not."""
    [step] = checked_step(world, SCHOOLS)
    monkeypatch.setattr(chain_run, "count_query", lambda *_, **__: count)
    base = context_of(world)
    context = replace(base, limits=Limits(max_features=10_000, timeout_s=10))
    found = run_step(step, context, profile_of(world), last=True)
    if fails:
        assert isinstance(found.error, ResultTooLarge) and found.count is None
        assert found.error.details == {"max_features": 10_000, "count": 10_001}
        assert found.view == ModelView(outcome="error", code="result_too_large")
    else:
        assert found.count == 10_000 and found.error is None


@pytest.mark.parametrize(("elapsed", "fails"), [(10.0, False), (10.001, True)])
def test_a_step_has_10_seconds(
    world: DataBackend, monkeypatch: pytest.MonkeyPatch, elapsed: float, fails: bool
) -> None:
    """The step's query runs under the engine's limit (10 s, F-9.6), on an
    injected clock: at 10 s it still runs, past it it stops ``query_timeout``,
    a step error the model sees by its code (and re-plans after, P4)."""
    steps = checked_step(world, SCHOOLS, BUFFER, within(1, 2))
    readings = iter([0.0])

    def clock() -> float:
        return next(readings, elapsed)

    monkeypatch.setattr(spatialite_module, "time", SimpleNamespace(monotonic=clock))
    base = context_of(world)
    context = replace(base, limits=Limits(max_features=100, timeout_s=10))
    found = run_step(steps[2], context, profile_of(world))
    if fails:
        assert found.count is None and found.view == ModelView(
            outcome="error", code="query_timeout"
        )
    else:
        assert found.count == 37


class Clock:
    """A monotonic clock the test moves."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.mark.parametrize(("start", "fails"), [(MODEL_CALL_S - 0.001, False), (MODEL_CALL_S, True)])
async def test_the_planning_call_has_120_seconds(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    start: float,
    fails: bool,
) -> None:
    """The model call's deadline (120 s), on the flow's clock: a call that
    starts at it never reaches the model (``llm_timeout``)."""
    clock = Clock()
    with_clock(app, clock, model)
    model.script(reference_plan())
    model.released.clear()
    response = await client.post(PROMPT, json={"text": "?", "approach": "chain"})
    assert await asyncio.to_thread(model.asked.wait, 10)
    clock.now += start
    model.released.set()
    await settle(app)
    found = await record(client, response.json()["id"])
    if fails:
        assert (found["status"], found["error"]["code"]) == ("failed", "llm_timeout")
    else:
        assert found["status"] == "proposed"


@pytest.mark.parametrize(("step_s", "ran_steps"), [(74.999, 5), (75.0, 4)])
async def test_the_request_has_300_seconds(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    monkeypatch: pytest.MonkeyPatch,
    step_s: float,
    ran_steps: int,
) -> None:
    """P4: the request's deadline, checked before every step: each step takes
    ``step_s`` on the injected clock; at 300 s the next step does not start,
    ``time_limit`` with the numbers, the last complete result adoptable."""
    assert CHAIN_TIME_LIMIT_S == 300
    clock = Clock()
    with_clock(app, clock, model)
    original = service.run_step

    def timed(step: Any, *args: Any, **kwargs: Any) -> Any:
        clock.now += step_s
        return original(step, *args, **kwargs)

    monkeypatch.setattr(service, "run_step", timed)
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, reference_plan())
    ended, _ = await drive(client, app, approved["id"])

    ok = sum(s["status"] == "ok" for s in ended["steps"])
    assert ok == ran_steps
    if ran_steps == 4:
        assert (ended["status"], ended["stop_reason"]) == ("limited", "time_limit")
        assert ended["error"]["details"] == {"position": 5, "value": 300, "max": 300}
        assert statuses(ended)[4:] == ["skipped"]
        assert ended["stamp"]["count"] == 37  # step 4 waits to be adopted
    else:
        assert ended["status"] == "done"


async def test_a_halt_does_not_count(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """The run's clock stops while the chain waits for approval (M9.2)."""
    clock = Clock()
    with_clock(app, clock, model)
    await choose(client, levels["Teilautonom"])
    proposed = await ask_chain(client, app, model, planned(SCHOOLS, BUFFER, within(1, 2)))
    assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
    halted = await run(client, app, proposed["id"])
    assert halted["status"] == "proposed"
    clock.now += 10 * CHAIN_TIME_LIMIT_S  # the user takes their time
    assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
    done = await run(client, app, proposed["id"])
    assert done["status"] == "done"


async def test_a_re_plan_ends_by_the_requests_deadline(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """The re-plan's call has 120 s, but no more than the request has left:
    when the request's deadline comes first, the run stops ``time_limit``."""
    clock = Clock()
    with_clock(app, clock, model)
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, planned(*EMPTY_THEN))
    model.script(revised(1))
    model.released.clear()
    model.asked.clear()
    assert (await client.post(url(approved["id"], "run"))).status_code == 202
    assert await asyncio.to_thread(model.asked.wait, 10)  # the re-plan's call
    clock.now += CHAIN_TIME_LIMIT_S
    model.released.set()
    await settle(app)
    ended = await record(client, approved["id"])
    assert (ended["status"], ended["stop_reason"]) == ("limited", "time_limit")
    assert ended["replans"] == 1 and ended["error"]["details"]["max"] == CHAIN_TIME_LIMIT_S
    deadline = model.fake.calls[-1].deadline
    assert deadline is not None and deadline <= clock.now


# --- abort, halt and restart ----------------------------------------------------------


async def test_abort_lets_the_running_step_finish_and_stops_before_the_next(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    held = Held(monkeypatch, 2)
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, reference_plan())
    assert (await client.post(url(approved["id"], "run"))).status_code == 202
    await held.wait()
    running = await record(client, approved["id"])
    assert running["status"] == "running"
    assert statuses(running)[:2] == ["ok", "running"]

    aborted = await client.post(url(approved["id"], "abort"))
    assert aborted.status_code == 200, aborted.text
    assert (aborted.json()["status"], aborted.json()["stop_reason"]) == ("running", "aborted")
    # The account's next prompt waits for the run, as for an aborted call (P7).
    busy = await client.post(PROMPT, json={"text": "?", "approach": "chain"})
    assert (busy.status_code, busy.json()["code"]) == (409, "busy")
    held.release.set()
    await settle(app)

    ended = await record(client, approved["id"])
    assert (ended["status"], ended["stop_reason"], ended["decision"]) == (
        "limited",
        "aborted",
        None,
    )
    assert statuses(ended) == ["ok", "ok", "skipped", "skipped", "skipped"]
    assert hits(ended)[:2] == [62, 37]
    # Step 2 is a buffer: step 1 is the last complete result to adopt.
    assert same_query(ended["query"], {"source": "schulen", "where": PRIMAR})
    adopted = await client.post(url(approved["id"], "adopt"))
    assert adopted.json()["action"]["stamp"]["count"] == 62


async def test_abort_while_halted_ends_the_chain_at_once(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """Plan 1.2: ``proposed`` → ``limited``, ``aborted``, adoptable."""
    await choose(client, levels["Teilautonom"])
    proposed = await ask_chain(client, app, model, reference_plan())
    early = await client.post(url(proposed["id"], "abort"))
    assert (early.status_code, early.json()["code"]) == (409, "not_approved")  # not started
    assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
    halted = await run(client, app, proposed["id"])
    assert halted["status"] == "proposed"

    aborted = await client.post(url(proposed["id"], "abort"))

    assert aborted.status_code == 200, aborted.text
    body = aborted.json()
    assert (body["status"], body["stop_reason"]) == ("limited", "aborted")
    assert statuses(body) == ["ok", "skipped", "skipped", "skipped", "skipped"]
    assert body["stamp"]["count"] == 62 and body["steps"][0]["stamp"]["count"] == 62
    for step in ("approve", "run"):
        response = await client.post(url(proposed["id"], step))
        assert response.status_code == 409, step
    assert (await client.post(url(proposed["id"], "adopt"))).status_code == 200


async def test_a_restart_closes_a_running_chain_its_result_adoptable(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """P4, P7: nothing in flight survives a restart; the start-up check closes
    a ``running`` chain ``limited``/``interrupted``, its last complete
    result adoptable. The run that is still alive here finds it closed."""
    held = Held(monkeypatch, 4)
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, reference_plan())
    assert (await client.post(url(approved["id"], "run"))).status_code == 202
    await held.wait()

    closed = close_stale(app.state.geotandem.backend.engine)

    assert approved["id"] in closed
    ended = await record(client, approved["id"])
    assert (ended["status"], ended["stop_reason"]) == ("limited", "interrupted")
    assert statuses(ended) == ["ok", "ok", "ok", "skipped", "skipped"]
    held.release.set()
    await settle(app)
    assert await record(client, approved["id"]) == ended  # the late run wrote nothing
    assert same_query(ended["query"], ended["steps"][2]["query"]) and ended["stamp"] is None
    adopted = await client.post(url(approved["id"], "adopt"))
    assert adopted.status_code == 200, adopted.text
    assert adopted.json()["action"]["stamp"]["count"] == 37


# --- one at a time ------------------------------------------------------------------


async def test_one_run_at_a_time(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    monkeypatch: pytest.MonkeyPatch,
    ran: list[str],
) -> None:
    held = Held(monkeypatch, 1)
    await choose(client, levels["Automatisch"])
    approved = await ask_chain(client, app, model, planned(SCHOOLS))
    ran.clear()
    both = await asyncio.gather(*(client.post(url(approved["id"], "run")) for _ in range(3)))
    assert sorted(r.status_code for r in both) == [202, 409, 409]
    assert {r.json()["code"] for r in both if r.status_code == 409} <= {"busy", "not_approved"}
    await held.wait()
    model.script(planned(SCHOOLS))
    prompt = await client.post(PROMPT, json={"text": "?", "approach": "chain"})
    assert (prompt.status_code, prompt.json()["code"]) == (409, "busy")
    held.release.set()
    await settle(app)
    assert (await record(client, approved["id"]))["status"] == "done"
    assert len(ran) == 2  # one count, one stamp: the step ran once


# --- the plan's edit (design M8.3, decision 17) --------------------------------------


async def test_a_plan_changes_values_and_loses_steps_but_never_gains_one(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    proposed = await ask_chain(client, app, model, reference_plan())
    action = url(proposed["id"], "plan")
    buffer = proposed["steps"][1]["arguments"]

    async def refused(body: Body, code: str, status: int = 422) -> Body:
        response = await client.patch(action, json=body)
        assert (response.status_code, response.json()["code"]) == (status, code), response.text
        found: Body = response.json()["details"]
        return found

    # A removed step another reads, named; a new name; a step that is not there.
    assert await refused({"remove": [4]}, "invalid_query") == {
        "step": 5,
        "reads": 4,
        "part": "in",
    }
    renamed = {**buffer, "layer": "gewaesser"}
    assert (await refused({"change": [{"position": 2, "arguments": renamed}]}, "invalid_query"))[
        "step"
    ] == 2
    assert (await refused({"change": [{"position": 9, "arguments": buffer}]}, "invalid_query"))[
        "step"
    ] == 9
    await refused({"remove": [1, 2, 3, 4, 5]}, "invalid_query")
    await refused({"add": [{"tool": "filter"}]}, "schema_violation")
    await refused(
        {"change": [{"position": 2, "arguments": buffer}, {"position": 2, "arguments": buffer}]},
        "invalid_query",
    )
    # A value the step cannot hold is refused by the check of the whole plan.
    wrong = {**buffer, "distance_m": -5}
    assert (
        await refused({"change": [{"position": 2, "arguments": wrong}]}, "model_query_invalid")
    )["step"] == 2
    assert await record(client, proposed["id"]) == proposed  # refusals change nothing

    edited = await client.patch(
        action,
        json={
            "change": [{"position": 2, "arguments": {**buffer, "distance_m": 300}}],
            "remove": [4, 5],
        },
    )

    assert edited.status_code == 200, edited.text
    view = edited.json()
    assert [(s["position"], s["status"]) for s in view["steps"]] == [
        (1, "planned"),
        (2, "planned"),
        (3, "planned"),
        (4, "removed"),
        (5, "removed"),
    ]
    assert view["steps"][1]["arguments"]["distance_m"] == 300
    assert view["steps"][2]["query"]["where"]["args"][1]["distance_m"] == 300
    assert set(view["governance"]["classes"]) == {Q, D, S}
    assert ran == [] and len(model.fake.calls) == 1
    done, _ = await drive(client, app, proposed["id"])
    assert done["status"] == "done" and 0 < done["steps"][2]["hits"] <= 37  # closer: no more
    assert statuses(done)[3:] == ["removed", "removed"]
    assert same_query(done["query"], done["steps"][2]["query"])
    # Run, the plan stays.
    late = await client.patch(action, json={})
    assert (late.status_code, late.json()["code"]) == (409, "not_approved")


async def test_an_approval_does_not_carry_over_an_edit(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    proposed = await ask_chain(client, app, model, reference_plan())
    assert (await client.post(url(proposed["id"], "approve"))).status_code == 200
    response = await client.patch(url(proposed["id"], "plan"), json={"remove": [5]})
    assert (response.status_code, response.json()["code"]) == (409, "not_approved")


async def test_the_users_edit_is_told_with_the_re_plan(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int]
) -> None:
    """The model planned 300 m, the user wrote 0.001 (nothing nearby) and
    removed a step: the re-plan's input says so, in the user's values."""
    steps = [SCHOOLS, BUFFER, within(1, 2), MUNICIPALITIES, within(3, 4)]
    proposed = await ask_chain(client, app, model, planned(*steps))
    other = {**BUFFER[1], "where": {**BUFFER[1]["where"], "cmp": "ne"}}
    edited = await client.patch(
        url(proposed["id"], "plan"), json={"change": [{"position": 2, "arguments": other}]}
    )
    assert edited.status_code == 422  # the operator is no value: refused
    tiny = {**BUFFER[1], "where": {**BUFFER[1]["where"], "value": "feldweg"}}
    edited = await client.patch(
        url(proposed["id"], "plan"), json={"change": [{"position": 2, "arguments": tiny}]}
    )
    assert edited.status_code == 200, edited.text
    model.script(revised(1))
    ended, _ = await drive(client, app, proposed["id"])
    assert ended["replans"] == 1
    seen = model.fake.calls[1].messages[-1].content
    assert "Der Anwender hat den Plan vor dem Lauf angepasst" in seen
    assert '"value":"feldweg"' in seen


# --- the other account (D4) ----------------------------------------------------------


async def test_the_chain_routes_of_another_account_do_not_exist(
    client: httpx.AsyncClient, app: FastAPI, model: Model, levels: dict[str, int], ran: list[str]
) -> None:
    proposed = stored_chain(app, "admin", "Prüfen", SCHOOLS)
    await sign_in_as(client, "m.keller")
    for method, step, body in (
        ("PATCH", "plan", {}),
        ("POST", "run", None),
        ("POST", "adopt", None),
        ("POST", "abort", None),
        ("POST", "approve", None),
    ):
        response = await client.request(method, url(proposed, step), json=body)
        assert (response.status_code, response.json()["code"]) == (404, "not_found"), step
    assert ran == []


def test_chain_constants_match_the_fixture() -> None:
    limits = fixture()["limits"]
    assert (limits["steps"], limits["replans"], limits["chain_s"]) == (
        MAX_STEPS,
        MAX_REPLANS,
        CHAIN_TIME_LIMIT_S,
    )
