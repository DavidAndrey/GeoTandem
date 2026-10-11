"""The chain's tools and what the model sees of a step (plan E2.3-E2.6, WP74).

On the real sample data: the fixture's reference chain composes into the
reference query, one query object per step and nothing stored; every refusal
of ``check_plan`` names its step; ``model_view`` keeps a step's code, count and
emptiness and a name the model wrote, and nothing else. Then the static
enumeration (D10): an engine result reaches the model only through
``model_view``, and nothing on the model path reads the data release.
"""

import ast
import json
from collections.abc import Iterator
from typing import Any

import pytest
from model_fixtures import case
from sqlalchemy import event
from test_model_bypass import READS, WRITE, model_path_sources
from test_model_direct import CHECK, LIMITS, context_of, profile_of, with_sample

from geotandem.catalog import AttributeUpdate, update_attribute
from geotandem.data import DataBackend
from geotandem.engine import QueryError, count_query, stamp_query
from geotandem.engine.errors import UnknownAttribute
from geotandem.importing.run import ImportDecisions, run_import
from geotandem.levels import OpClass, classify
from geotandem.model.chain import run as chain_run
from geotandem.model.chain.ask import ChainState
from geotandem.model.chain.plan import CheckedStep, chain_classes, chain_governance, check_plan
from geotandem.model.chain.run import run_step
from geotandem.model.chain.tools import CHAIN
from geotandem.model.chain.view import StepResult, model_view, names_in
from geotandem.model.errors import ActionError
from geotandem.model.prompt import build_prompt
from geotandem.model.schemas import MAX_REPLANS, ModelView, PlanAnswer, PlannedStep, Refusal
from geotandem.tools.chain import conjoin
from geotandem_query import And, QueryObject, canonical_json

REFERENCE_CASE = case("chain_reference")
REFERENCE_PLAN = PlanAnswer.model_validate(REFERENCE_CASE["answer"])
REFERENCE = case("reference")["answer"]["query"]
COUNTS = [62, 37, 37, 37, 10]


def test_the_pinned_counts_are_the_contract_fixture_s() -> None:
    """The frontend's fake API reads the same counts from the fixture."""
    from model_fixtures import case

    assert case("chain_reference")["expect"]["step_hits"] == COUNTS


"""Hits of the reference chain's steps on the sample: primary schools, buffered
cantonal roads B, primary schools near them, municipalities with a high tax
rate, primary schools in those (design M9.1)."""

Body = dict[str, Any]


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> DataBackend:
    return with_sample(tmp_path_factory.mktemp("chain"))


def steps(*planned: tuple[str, Body]) -> list[PlannedStep]:
    return [
        PlannedStep(text=f"Schritt {i}", tool=t, arguments=a) for i, (t, a) in enumerate(planned)
    ]


def check(world: DataBackend, planned: list[PlannedStep], **kw: Any) -> list[CheckedStep] | Refusal:
    return check_plan(planned, context_of(world), profile_of(world), **kw)


def checked(world: DataBackend, planned: list[PlannedStep]) -> list[CheckedStep]:
    found = check(world, planned)
    assert isinstance(found, list), found
    return found


def cmp(attr: str, op: str, value: Any) -> Body:
    return {"op": "compare", "attr": attr, "cmp": op, "value": value}


PRIMAR: Body = {"op": "in", "attr": "typ", "values": ["primar"]}
SCHOOLS = ("filter", {"layer": "schulen", "where": PRIMAR})
ROADS_B = (
    "buffer",
    {"layer": "strassen", "distance_m": 500, "where": cmp("klasse", "eq", "kantonsstrasse_b")},
)
HIGH_TAX = ("filter", {"layer": "gemeinden_steuern", "where": cmp("steueranlage", "gt", 1.6)})


# --- the reference chain (F-5.7) ------------------------------------------------------


def test_the_reference_chain_is_the_reference_query_and_finds_10_of_137(
    world: DataBackend,
) -> None:
    found = checked(world, REFERENCE_PLAN.steps)
    context, profile = context_of(world), profile_of(world)
    assert [s.position for s in found] == [1, 2, 3, 4, 5]
    assert canonical_json(found[-1].query) == canonical_json(QueryObject.model_validate(REFERENCE))
    runs = [run_step(s, context, profile, last=s.position == 5) for s in found]
    assert [r.view for r in runs] == [ModelView(outcome="ok", empty=False, count=n) for n in COUNTS]
    assert [r.count for r in runs] == COUNTS
    # The result to adopt is stamped in the model's world, as the user's own run stamps it.
    stamped = chain_run.stamp(found[-1].query, context, profile)
    assert stamped == stamp_query(found[-1].query, context.backend, LIMITS)
    assert count_query(QueryObject(source="schulen"), context.backend, LIMITS) == 137


def test_a_step_reads_its_tools_class_and_those_of_the_conditions_it_writes(
    world: DataBackend,
) -> None:
    """The fixture's ``step_classes`` are the tools' (H2); the buffer writes an
    attribute condition too, so its cell is the strictest of both (H4)."""
    found = checked(world, REFERENCE_PLAN.steps)
    tools = [CHAIN[s.tool].tool.op_class for s in REFERENCE_PLAN.steps]
    assert tools == [OpClass(c) for c in REFERENCE_CASE["expect"]["step_classes"]]
    Q, D, S = OpClass.QUERY, OpClass.DERIVE, OpClass.SPATIAL
    assert [s.classes for s in found] == [{Q}, {D, Q}, {S}, {Q}, {S}]
    near = checked(world, steps(("filter", {"layer": "schulen", "where": REFERENCE["where"]})))
    assert near[0].classes == {Q, S}


def test_a_chain_is_governed_by_all_its_steps(world: DataBackend) -> None:
    """The buffer became a distance in the last query object: ``classify`` of
    it misses ``derive``, the chain's governance does not (H4)."""
    found = checked(world, REFERENCE_PLAN.steps)
    Q, D, S = OpClass.QUERY, OpClass.DERIVE, OpClass.SPATIAL
    assert classify(found[-1].query) == {Q, S}
    assert chain_classes(found) == {Q, D, S}
    ruled = chain_governance(CHECK, found)
    assert set(ruled.classes) == {Q, D, S} and OpClass.DERIVE in ruled.needs_approval


def test_every_step_is_a_query_object_and_nothing_is_written(world: DataBackend) -> None:
    """No layer, no table, no statement that writes (F-9.5): an intermediate
    result is a query object and its stamp."""
    written: list[str] = []

    def seen(_conn: Any, _cursor: Any, statement: str, *_: Any) -> None:
        first = statement.lstrip().split(None, 1)[0].upper()
        if WRITE.match(statement) or first not in READS:
            written.append(statement[:80])

    before = world.layer_names()
    event.listen(world.engine, "before_cursor_execute", seen)
    try:
        found = checked(world, REFERENCE_PLAN.steps)
        for step in found:
            run_step(step, context_of(world), profile_of(world))
    finally:
        event.remove(world.engine, "before_cursor_execute", seen)
    assert written == [] and world.layer_names() == before
    assert all(isinstance(s.query, QueryObject) for s in found)


def test_each_tool_composes_what_modus_a_writes(world: DataBackend) -> None:
    """The spatial steps are the rows "liegt in", "ausserhalb", "schneidet",
    "≤ Distanz" (``represent``); a filter narrows an earlier step with ``and``."""
    gemeinden = ("filter", {"layer": "gemeinden", "where": cmp("gem_nr", "gt", 0)})
    found = checked(
        world,
        steps(
            SCHOOLS,
            gemeinden,
            ("outside", {"of": 1, "in": 2}),
            ("intersects", {"of": 1, "with": 2}),
            ("near", {"of": 1, "to": 2, "distance_m": 300}),
            ("filter", {"of": 1, "where": cmp("standorte", "gt", 1)}),
            ("buffer", {"of": 2, "distance_m": 100}),
            ("intersects", {"of": 1, "with": 7}),
        ),
    )
    where = [s.query.model_dump(exclude_none=True)["where"] for s in found]
    related = {"op": "related", "layer": "gemeinden", "where": cmp("gem_nr", "gt", 0)}
    assert where[2]["args"][1] == {"op": "not", "arg": {**related, "predicate": "within"}}
    assert where[3]["args"][1] == {**related, "predicate": "intersects"}
    assert where[4]["args"][1] == {**related, "predicate": "dwithin", "distance_m": 300}
    assert where[5] == {"op": "and", "args": [PRIMAR, cmp("standorte", "gt", 1)]}
    assert found[6].query.buffer is not None and found[6].query.source == "gemeinden"
    assert where[7]["args"][1] == {**related, "predicate": "dwithin", "distance_m": 100}


def test_a_filter_on_a_buffer_takes_attribute_conditions_only(world: DataBackend) -> None:
    """Its conditions are evaluated before the buffer: a relation in them would
    see the roads, not their buffer."""
    tax = {"op": "related", "layer": "gemeinden", "predicate": "within"}
    refused = check(world, steps(ROADS_B, ("filter", {"of": 1, "where": tax}), SCHOOLS))
    assert isinstance(refused, Refusal)
    assert (refused.code, refused.details["part"], refused.details["step"]) == (
        "not_representable",
        "where",
        2,
    )
    roads = ("buffer", {"layer": "strassen", "distance_m": 500})
    named = ("filter", {"of": 1, "where": cmp("klasse", "eq", "kantonsstrasse_b")})
    found = checked(world, steps(roads, named, SCHOOLS, ("within", {"of": 3, "in": 2})))
    assert found[1].query.buffer is not None
    assert canonical_json(found[3].query) == canonical_json(
        checked(world, steps(SCHOOLS, ROADS_B, ("within", {"of": 1, "in": 2})))[2].query
    )


def test_conjoin_never_writes_an_and_of_one() -> None:
    a, b = QueryObject.model_validate({"source": "x", "where": PRIMAR}).where, None
    assert a is not None
    one = And(op="and", args=[a])
    assert conjoin(one, b) == a
    assert conjoin(None, And(op="and", args=[one, one])) == And(op="and", args=[a, a])
    assert conjoin(None, None) is None


def test_a_chain_does_not_end_in_a_buffer(world: DataBackend) -> None:
    """D3: a buffer that feeds a spatial step is its distance; as the result,
    the controls cannot show it."""
    refused = check(world, steps(SCHOOLS, ROADS_B))
    assert isinstance(refused, Refusal)
    assert (refused.code, refused.details) == ("not_representable", {"step": 2, "part": "buffer"})
    assert isinstance(check(world, steps(SCHOOLS, ROADS_B, ("within", {"of": 1, "in": 2}))), list)
    done = checked(world, steps(SCHOOLS, ROADS_B, ("within", {"of": 1, "in": 2})))
    again = check(world, steps(("buffer", {"of": 3, "distance_m": 10})), done=done)
    assert isinstance(again, Refusal) and again.details == {"step": 4, "part": "buffer"}


@pytest.fixture(scope="module")
def multipoints(world: DataBackend, tmp_path_factory: pytest.TempPathFactory) -> str:
    """A layer of multipoints, imported as a user would."""
    path = tmp_path_factory.mktemp("multi") / "punktgruppen.geojson"
    features = [
        {
            "type": "Feature",
            "properties": {"nr": i},
            "geometry": {
                "type": "MultiPoint",
                "coordinates": [[7.44 + i / 100, 46.95], [7.6, 46.9]],
            },
        }
        for i in range(1, 4)
    ]
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}), "utf-8")
    run = run_import(
        path, path.name, ImportDecisions(layer_name="punktgruppen", title="P"), world, actor="admin"
    )
    assert run.status in ("ok", "warning"), run
    return "punktgruppen"


def test_multipoints_do_not_lie_in_a_buffer_by_its_distance(
    world: DataBackend, multipoints: str
) -> None:
    """A multipoint lies in a buffer when all its points do; ``dwithin`` asks
    for one: the rewrite holds for single points only."""
    [kind] = [p.geometry_type for p in profile_of(world).layers if p.name == multipoints]
    assert kind == "MultiPoint"
    groups = ("filter", {"layer": multipoints, "where": cmp("nr", "gt", 0)})
    for tool in ("within", "outside"):
        refused = check(world, steps(groups, ROADS_B, (tool, {"of": 1, "in": 2})))
        assert isinstance(refused, Refusal) and refused.details == {"step": 3, "part": "in"}
    meets = ("intersects", {"of": 1, "with": 2})
    assert isinstance(check(world, steps(groups, ROADS_B, meets)), list)


# --- refusals, each naming its step --------------------------------------------------

NINE: Body = {"op": "and", "args": [cmp("standorte", "ge", i) for i in range(9)]}
REFUSALS: dict[str, tuple[list[tuple[str, Body]], str, Body]] = {
    "unknown tool": ([("drop_layer", {"layer": "schulen"})], "model_query_invalid", {}),
    "extra argument": (
        [("filter", {"layer": "schulen", "where": PRIMAR, "sql": "DELETE"})],
        "model_query_invalid",
        {},
    ),
    "layer and of": (
        [SCHOOLS, ("filter", {"layer": "schulen", "of": 1, "where": PRIMAR})],
        "model_query_invalid",
        {},
    ),
    "a later step": ([SCHOOLS, ("within", {"of": 1, "in": 3})], "model_query_invalid", {}),
    "itself": ([SCHOOLS, ("within", {"of": 2, "in": 1})], "model_query_invalid", {}),
    "of a buffer": (
        [ROADS_B, SCHOOLS, ("within", {"of": 1, "in": 2})], "not_representable", {"part": "of"}
    ),
    "in a relation": (
        [SCHOOLS, ROADS_B, ("within", {"of": 1, "in": 2}), ("within", {"of": 1, "in": 3})],
        "not_representable",
        {"part": "in"},
    ),
    "lines in a buffer": (
        [("filter", {"layer": "strassen", "where": cmp("klasse", "eq", "kantonsstrasse_b")}),
         ("buffer", {"layer": "gewaesser", "distance_m": 100}),
         ("within", {"of": 1, "in": 2})],
        "not_representable",
        {"part": "in"},
    ),
    "a buffer buffered": (
        [ROADS_B, ("buffer", {"of": 1, "distance_m": 50})], "not_representable", {"part": "of"}
    ),
    "near a buffer": (
        [SCHOOLS, ROADS_B, ("near", {"of": 1, "to": 2, "distance_m": 10})],
        "not_representable",
        {"part": "to"},
    ),
    "the same layer": (
        [SCHOOLS, ("filter", {"layer": "schulen", "where": cmp("standorte", "gt", 2)}),
         ("within", {"of": 1, "in": 2})],
        "not_representable",
        {},
    ),
    "a table layer": (
        [("filter", {"layer": "gemeindedaten", "where": cmp("steueranlage", "gt", 1)})],
        "not_representable",
        {"part": "source"},
    ),
    "unknown layer": (
        [("filter", {"layer": "kitas", "where": PRIMAR})], "unknown_layer", {"layer": "kitas"}
    ),
    "unknown attribute": (
        [SCHOOLS, ("filter", {"of": 1, "where": cmp("farbe", "eq", "rot")})],
        "unknown_attribute",
        {"attribute": "farbe"},
    ),
    "too many conditions": (
        [("filter", {"layer": "schulen", "where": NINE})],
        "limit_exceeded",
        {"value": 9},
    ),
    "too far a buffer": (
        [("buffer", {"layer": "strassen", "distance_m": 10_000_000})], "query_too_complex", {}
    ),
}  # fmt: skip


@pytest.mark.parametrize("name", REFUSALS)
def test_a_refused_step_is_named(world: DataBackend, name: str) -> None:
    planned, code, details = REFUSALS[name]
    refusal = check(world, steps(*planned))
    assert isinstance(refusal, Refusal), refusal
    assert refusal.code == code
    assert refusal.details["step"] == len(planned)
    assert details.items() <= refusal.details.items()


def test_a_reference_names_an_earlier_step(world: DataBackend) -> None:
    refusal = check(world, steps(SCHOOLS, ("within", {"of": 2, "in": 1})))
    assert isinstance(refusal, Refusal)
    assert refusal.details["errors"] == [
        {"loc": ["arguments", "of"], "msg": "Names no earlier step", "type": "step_reference"}
    ]


def test_the_step_limit_counts_the_completed_steps(world: DataBackend) -> None:
    beyond = case("step_limit")
    refusal = check(world, PlanAnswer.model_validate(beyond["answer"]).steps)
    assert isinstance(refusal, Refusal)
    assert (refusal.code, refusal.details) == ("step_limit", beyond["expect"]["details"])
    done = checked(world, REFERENCE_PLAN.steps)
    assert isinstance(check(world, steps(SCHOOLS, SCHOOLS, SCHOOLS), done=done), list)
    again = check(world, steps(SCHOOLS, SCHOOLS, SCHOOLS, SCHOOLS), done=done)
    assert isinstance(again, Refusal) and again.details == {"value": 9, "max": 8, "step": 9}
    # A re-plan's steps continue the count and may name the completed ones.
    more = check(world, steps(("filter", {"of": 5, "where": cmp("standorte", "gt", 1)})), done=done)
    assert isinstance(more, list) and more[0].position == 6
    assert more[0].query.source == "schulen"


# --- model_view (D9, D10) ------------------------------------------------------------

ARGS: Body = {
    "layer": "strassen",
    "distance_m": 500,
    "where": cmp("klasse", "eq", "kantonsstrasse_b"),
}


def test_a_step_that_ran_shows_its_count_and_whether_it_is_empty() -> None:
    assert model_view(StepResult(ARGS, 3)) == ModelView(outcome="ok", empty=False, count=3)
    assert model_view(StepResult(ARGS, 0)) == ModelView(outcome="ok", empty=True, count=0)
    with pytest.raises(TypeError):
        model_view(StepResult(ARGS, True))


def test_an_error_shows_its_code_and_only_a_name_the_model_wrote() -> None:
    def part(details: Body, arguments: Body = ARGS) -> str | None:
        error = QueryError("Kantonsstrasse B gibt es nicht. Werte: Murten - Bern", **details)
        view = model_view(StepResult(arguments, error))
        assert (view.outcome, view.code, view.count, view.empty) == (
            "error",
            "invalid_query",
            None,
            None,
        )
        return view.part

    assert part({"attribute": "klasse", "layer": "strassen"}) == "klasse"
    assert part({"layer": "strassen"}) == "strassen"
    # A value the model wrote looks like a name, but stands in a value's place.
    assert part({"attribute": "kantonsstrasse_b"}) is None
    assert part({"attribute": "kantonsstrasse_b", "layer": "strassen"}) == "strassen"
    # A name the model never wrote, an argument's key, a non-name.
    assert part({"attribute": "zz_geheim"}) is None
    assert part({"part": "where"}) is None
    assert part({"attribute": "Schule Liebefeld"}, {"attr": "Schule Liebefeld"}) is None
    assert names_in(ARGS) == {"strassen", "klasse"}
    # An error inside a condition taken over from an earlier step: no name.
    assert part({"attribute": "klasse", "layer": "strassen"}, {"of": 1, "in": 2}) is None


def test_an_engine_error_of_a_run_reaches_the_model_as_its_code(world: DataBackend) -> None:
    """Planned while ``klasse`` was released, run after it was withdrawn (S3):
    the run fails in the model's world as it is now."""
    found = checked(world, steps(ROADS_B, SCHOOLS, ("within", {"of": 2, "in": 1})))
    update_attribute(world.engine, "strassen", "klasse", AttributeUpdate(for_model=False))
    try:
        run = run_step(found[0], context_of(world), profile_of(world))
    finally:
        update_attribute(world.engine, "strassen", "klasse", AttributeUpdate(for_model=True))
    assert isinstance(run.error, UnknownAttribute) and run.count is None
    assert run.view == ModelView(outcome="error", code="unknown_attribute", part="klasse")
    assert "klasse" in run.error.message  # the text is the user's, never the model's


# --- the run as the model meets it (P4) ----------------------------------------------


def views(*outcomes: str) -> Iterator[ModelView]:
    for outcome in outcomes:
        if outcome == "error":
            yield ModelView(outcome="error", code="query_timeout")
        else:
            yield ModelView(
                outcome="ok", empty=outcome == "empty", count=0 if outcome == "empty" else 4
            )


def state_of(world: DataBackend) -> ChainState:
    prompt = build_prompt("?", approach="chain", level=CHECK, profile=profile_of(world))
    return ChainState(prompt, REFERENCE_PLAN, checked(world, REFERENCE_PLAN.steps))


@pytest.mark.parametrize(
    ("outcomes", "after", "completed"),
    [
        (["ok", "ok", "ok", "ok", "ok"], "done", 5),
        (["ok", "ok", "ok", "ok", "empty"], "done", 5),  # an empty last step stands
        (["ok", "error"], "replan", 1),
        (["ok", "empty"], "replan", 2),  # it ran: it stays
    ],
)
def test_a_re_plan_follows_an_error_or_an_empty_step_before_the_last(
    world: DataBackend, outcomes: list[str], after: str, completed: int
) -> None:
    state = state_of(world)
    found = [
        state.ran(step, view) for step, view in zip(state.steps, views(*outcomes), strict=False)
    ]
    assert found[-1] == after and set(found[:-1]) <= {"next"}
    assert state.completed == completed


def test_no_more_re_plans_than_allowed(world: DataBackend) -> None:
    state = state_of(world)
    for _ in range(MAX_REPLANS):
        assert state.ran(state.steps[0], next(views("error"))) == "replan"
        state.replan_messages()
    assert state.ran(state.steps[0], next(views("error"))) == "stopped"


def test_the_re_plan_input_is_the_views_and_the_models_own_plan(world: DataBackend) -> None:
    state = state_of(world)
    state.ran(state.steps[0], ModelView(outcome="ok", empty=False, count=62))
    state.ran(state.steps[1], ModelView(outcome="error", code="unknown_attribute", part="klasse"))
    messages = state.replan_messages()
    assert messages[:2] == state.prompt.messages
    plan, seen = messages[2:]
    assert plan.role == "assistant"
    assert PlanAnswer.model_validate_json(plan.content) == REFERENCE_PLAN
    assert seen.role == "user"
    assert seen.content.splitlines()[:3] == [
        "Ergebnis der ausgeführten Schritte:",
        'Schritt 1 (filter): {"outcome":"ok","empty":false,"count":62}',
        'Schritt 2 (buffer): {"outcome":"error","code":"unknown_attribute","part":"klasse"}',
    ]
    assert "Die Schritte 1 bis 1 bleiben" in seen.content


def test_a_re_plan_must_fit_the_context_too(world: DataBackend) -> None:
    state = state_of(world)
    state.context_length = state.prompt.tokens_estimate + 10
    state.ran(state.steps[0], next(views("error")))
    with pytest.raises(ActionError) as caught:
        state.replan_messages()
    assert caught.value.code == "context_too_large"


# --- the only way to the model (D10, static) ----------------------------------------
#
# Heuristics over the source, not proofs: they catch the ways that are cheap to
# write by accident (a direct call, an alias, a re-export, a dict for a view);
# code that means to get round them can. The sentinel test checks the effect.

ENGINE = "geotandem.engine"
RESULT_NAMES = {"QueryResult", "ResultStamp", "Feature", "ResultMeta"}
"""Engine results, also where another module re-exports them (``model.schemas``)."""
ENGINE_USERS = {
    "model/chain/run.py": "counts a step; hands on model_view of it",
    "model/chain/view.py": "model_view",
    "model/record/store.py": "keeps the stamp for the user",
    "model/schemas.py": "the user's views: ExecuteResponse, StepView",
    "model/service.py": "execute and preview, for the user",
    "model/validate.py": "the checks of a query; their refusal is the user's",
    "tools/builtin.py": "run_query, a registry tool the model path never offers",
}
"""Every module of the model path that imports from the engine or one of its
results, and why."""
TALKERS = {"model/prompt.py", "model/direct.py", "model/chain/ask.py"}
"""The modules that write a message to the model or call it."""
RESULT_ATTRIBUTES = {
    "stamp", "error", "features", "meta", "message", "details", "properties", "geometry",
    "ids_hash", "feature_count", "data_versions",
}  # fmt: skip
"""What an engine result or error carries beyond ``model_view``'s fields."""
RESULT_TYPES = {"StepRun", "ResultStamp", "QueryResult", "QueryError", "Feature", "StepResult"}


def _sources() -> dict[str, ast.Module]:
    return {name.replace("\\", "/"): tree for name, tree in model_path_sources()}


def _engine_imports(tree: ast.Module) -> bool:
    return any(
        isinstance(node, ast.ImportFrom)
        and (
            (node.module or "").startswith(ENGINE)
            or any(alias.name in RESULT_NAMES for alias in node.names)
        )
        for node in ast.walk(tree)
    )


def _talks(tree: ast.Module) -> bool:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "complete":
            return True
        if isinstance(func, ast.Name) and func.id == "Message":
            return True
    return False


def _aliases(tree: ast.Module, names: set[str]) -> set[str]:
    """``names`` and what the module calls them: ``import … as``, ``X = Name``."""
    found = set(names)
    while True:
        more = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom | ast.Import):
                more |= {a.asname for a in node.names if a.name in found and a.asname}
            elif (
                isinstance(node, ast.Assign)
                and isinstance(node.value, ast.Name)
                and node.value.id in found
            ):
                more |= {t.id for t in node.targets if isinstance(t, ast.Name)}
        if more <= found:
            return found
        found |= more


def _makes_a_view(tree: ast.Module) -> bool:
    """A ``ModelView`` built, by any of its names, or as a ``StepView``'s
    ``model_view`` filled with anything but ``model_view(…)`` or a value."""
    names = _aliases(tree, {"ModelView"})
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict) and any(
            isinstance(k, ast.Constant) and k.value == "model_view" for k in node.keys
        ):
            return True
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id in names:
            return True
        if isinstance(func, ast.Attribute):
            owner = func.value
            if func.attr == "ModelView" or (
                (isinstance(owner, ast.Name) and owner.id in names)
                or (isinstance(owner, ast.Attribute) and owner.attr == "ModelView")
            ):
                return True
        for keyword in node.keywords:
            value = keyword.value
            made = isinstance(value, ast.Call) and not (
                isinstance(value.func, ast.Name) and value.func.id == "model_view"
            )
            if keyword.arg == "model_view" and (made or isinstance(value, ast.Dict)):
                return True
    return False


def test_only_model_view_makes_what_the_model_sees() -> None:
    makers = {name for name, tree in _sources().items() if _makes_a_view(tree)}
    assert makers == {"model/chain/view.py"}


def test_the_check_catches_the_cheap_ways_round() -> None:
    for code in (
        "from geotandem.model.schemas import ModelView as M; M(outcome='ok')",
        "from geotandem.model.schemas import ModelView; MV = ModelView; MV.model_validate({})",
        "import geotandem.model.schemas as s; s.ModelView(outcome='ok')",
        "StepView(position=1, model_view={'outcome': 'ok', 'count': 3})",
        "StepView(position=1, model_view=dict(outcome='ok'))",
        "StepView.model_validate({'model_view': rows})",
    ):
        assert _makes_a_view(ast.parse(code)), code
    for code in ("StepView(model_view=model_view(result))", "StepView(model_view=run.view)"):
        assert not _makes_a_view(ast.parse(code)), code
    assert _engine_imports(ast.parse("from geotandem.model.schemas import ResultStamp"))


def test_an_engine_result_reaches_the_model_only_through_model_view() -> None:
    """Who imports the engine or its results is listed with a reason; who talks
    to the model imports none of it, reads nothing a result or an error carries,
    and takes no result as an argument: a chain's step reaches it as a
    ``ModelView``."""
    sources = _sources()
    assert {name for name, tree in sources.items() if _engine_imports(tree)} == set(ENGINE_USERS)
    assert {name for name, tree in sources.items() if _talks(tree)} == TALKERS
    for name in TALKERS:
        tree = sources[name]
        assert not _engine_imports(tree), name
        read = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        assert read & RESULT_ATTRIBUTES == set(), name
        annotations = [
            ast.unparse(arg.annotation)
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef)
            for arg in node.args.args + node.args.kwonlyargs
            if arg.annotation is not None
        ]
        assert [a for a in annotations if any(t in a for t in RESULT_TYPES)] == [], name
    run = sources["model/chain/run.py"]
    assert not _talks(run)
    called = {
        n.func.id for n in ast.walk(run) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
    }
    assert "model_view" in called


def test_nothing_on_the_model_path_reads_the_data_release() -> None:
    """D10: the flag is stored and shown (E2.1); in E2.5 nothing it could
    release is offered, so no code of the model path reads it."""
    for name, tree in _sources().items():
        words = {getattr(n, "attr", None) for n in ast.walk(tree)} | {
            n.value for n in ast.walk(tree) if isinstance(n, ast.Constant)
        }
        assert "may_receive_data" not in words, name
