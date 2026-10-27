"""The chain as an evaluation drives it (docs/plan-chain-eval.md, Phase 0;
``evaluation/chain.py``).

Three things are held here, none needs a model:

- **The chain's cases** (``schema/eval-cases/chain-cases.json``): each reads,
  each reference passes the checks of a model's query and finds something, and
  ``eval_chain_plans.json`` holds for each a reference script the chain can
  answer it with. A scripted model gives that script to the driver and the
  grader grades it as recorded (the dry run of plan item 6, so the gate runs the
  whole path: prompt, driver, steps, re-plans, grader). Where a case says the
  chain cannot do something, a probe plan shows that the chain still refuses it
  or still falls into the trap the case is about.
- **Parity with the service**: the same script through the application at
  *Automatisch* and through ``drive`` gives the same calls, word for word, the
  same steps, the same end and the same result.
- **Parity with the direct path**: a chain of one filter is graded as the
  direct answer with the same query is.
"""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import jsonschema
import pytest
from chain_fixtures import (  # noqa: F401 - levels, model: fixtures
    MUNICIPALITIES,
    NOWHERE,
    Body,
    Model,
    levels,
    model,
    planned,
    within,
)
from chain_fixtures import drive as drive_api
from fastapi import FastAPI
from model_fixtures import case as model_case
from model_fixtures import completion
from test_model_chain_flow import EMPTY_THEN, ask_chain, choose, reference_plan, revised
from test_model_enforcement import account_of

from geotandem.config import Settings
from geotandem.data import Limits
from geotandem.engine import ids_query
from geotandem.evaluation.cases import World, chain_set, sample_world, start_set
from geotandem.evaluation.chain import ChainRun, drive, graded
from geotandem.evaluation.grade import conditions, grade, reading_ids
from geotandem.evaluation.schemas import EvalCase
from geotandem.levels import Level, active_level, load_levels
from geotandem.llm import Completion
from geotandem.llm.fake import FakeLLMClient
from geotandem.model.chain.plan import check_plan
from geotandem.model.prompt import build_prompt
from geotandem.model.record import RAN
from geotandem.model.result import answer_format, parse_answer
from geotandem.model.schemas import PlannedStep, QueryAnswer, Refusal
from geotandem.model.service import profile_for
from geotandem.model.validate import Validated, validate_model_query
from geotandem_query import QueryObject, canonical_json, compact

HERE = Path(__file__).parent
LIMITS = Limits(max_features=10_000, timeout_s=10)
PLANS: dict[str, dict[str, Any]] = json.loads((HERE / "eval_chain_plans.json").read_text("utf-8"))
CASES = {case.id: case for case in chain_set()}

Steps = list[tuple[str, dict[str, Any]]]


def body(steps: Steps) -> dict[str, Any]:
    return {
        "kind": "plan",
        "explanation": "Schritt für Schritt.",
        "assumptions": [],
        "steps": [
            {"text": f"Schritt {i}: {tool}", "tool": tool, "arguments": arguments}
            for i, (tool, arguments) in enumerate(steps, 1)
        ],
    }


def scripted(entry: Steps | dict[str, Any]) -> Completion:
    """One answer of a reference script: a plan's steps, or an answer as given."""
    answer = entry["answer"] if isinstance(entry, dict) else body(entry)
    return Completion(text=json.dumps(answer, ensure_ascii=False), parsed=answer)


@pytest.fixture(scope="module")
def world() -> World:
    return sample_world(Settings(), LIMITS)


@pytest.fixture(scope="module")
def level(world: World) -> Level:
    return next(lv for lv in load_levels(world.context.backend.engine) if lv.is_default)


def drive_case(case: EvalCase, world: World, level: Level) -> ChainRun:
    """The case's reference script through the driver, as the harness asks."""
    fake = FakeLLMClient(script=[scripted(entry) for entry in PLANS[case.id]["script"]])
    prompt = build_prompt(case.prompt, approach="chain", level=level, profile=world.profile)
    run = drive(fake, prompt, world.context, world.profile)
    assert not fake.script, "the script holds an answer the chain never asked for"
    return run


# --- the chain's cases -------------------------------------------------------------


def test_the_chain_cases_are_their_own_and_every_one_has_a_script() -> None:
    """42 cases (plan 4: 30 in group B, 12 in group C), ids apart from the
    start set's, both splits in each group, one script each."""
    assert len(CASES) == 42
    groups = {
        group: [c for c in CASES.values() if group in c.tags]
        for group in ("chain-native", "chain-stress")
    }
    assert (len(groups["chain-native"]), len(groups["chain-stress"])) == (30, 12)
    for cases in groups.values():
        assert {c.split for c in cases} == {"tuning", "confirm"}
    assert not set(CASES) & {c.id for c in start_set()}
    assert set(PLANS) == set(CASES)


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_every_reference_passes_the_checks_and_finds_something(case_id: str, world: World) -> None:
    case = CASES[case_id]
    for found in reading_ids(case, world.context, world.profile) or []:
        assert 0 < len(found) < 10_000


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_the_reference_script_is_graded_as_recorded(
    case_id: str, world: World, level: Level
) -> None:
    """The dry run: every query case is reached by a chain of the tools, the
    behaviour cases by their answer; ``ks05`` records the chain's gap."""
    case = CASES[case_id]
    run = drive_case(case, world, level)
    readings = reading_ids(case, world.context, world.profile)
    verdict = graded(case, run, world.context.backend, LIMITS, readings)
    assert verdict.tag == PLANS[case_id]["verdict"]
    if case.readings() and verdict.tag == "pass":
        assert run.end == "done" and run.count is not None and run.count > 0


PROBES = sorted(case_id for case_id, entry in PLANS.items() if "probe" in entry)


@pytest.mark.parametrize("case_id", PROBES)
def test_what_a_case_says_the_chain_cannot_do_it_still_cannot(case_id: str, world: World) -> None:
    """A probe that is refused names the code; one that is accepted is the trap
    the case is about: it runs, and it is not a fair reading."""
    probe = PLANS[case_id]["probe"]
    steps = [PlannedStep(text="x", tool=tool, arguments=args) for tool, args in probe["steps"]]
    checked = check_plan(steps, world.context, world.profile)
    if probe["refused"] is not None:
        assert isinstance(checked, Refusal) and checked.code == probe["refused"]
        return
    assert not isinstance(checked, Refusal), checked
    found = ids_query(checked[-1].query, world.context.backend, LIMITS)
    assert found not in (reading_ids(CASES[case_id], world.context, world.profile) or [])


ANSWERS = [
    (case_id, entry if isinstance(entry, dict) else body(entry))
    for case_id, plans in sorted(PLANS.items())
    for entry in plans["script"]
]


@pytest.mark.parametrize(
    "answer",
    [a for _, a in ANSWERS],
    ids=[f"{case_id}-{i}" for i, (case_id, _) in enumerate(ANSWERS)],
)
def test_constrained_output_can_write_every_reference_answer(answer: dict[str, Any]) -> None:
    """The chain's answer format (F6) bounds the steps, never below what
    ``check_plan`` accepts: every reference script, re-plans included, fits it."""
    jsonschema.validate(answer.get("answer", answer), answer_format("chain"))


BASE = (
    "filter",
    {"layer": "schulen", "where": {"op": "compare", "attr": "typ", "cmp": "eq", "value": "primar"}},
)


@pytest.mark.parametrize(
    "arguments",
    [
        {"layer": "schulen", "of": 1, "where": BASE[1]["where"]},
        {"where": BASE[1]["where"]},
        {"of": "1", "where": BASE[1]["where"]},
        {"layer": "schulen", "where": {"$ref": "#/$defs/IsNull", "attr": "name"}},
        {"layer": "schulen", "where": {"where": {"op": "text_match", "attr": "name", "text": "x"}}},
        {
            "layer": "schulen",
            "where": {"op": "text_match", "attr": "name", "text": "x", "mode": "like"},
        },
    ],
    ids=["layer-and-of", "neither", "of-as-text", "ref", "nested-where", "invented-mode"],
)
def test_constrained_output_cannot_write_what_the_baseline_saw_refused(
    arguments: dict[str, Any],
) -> None:
    """The commonest first errors of the Phase 1 baseline (plan-chain-eval 12, F6)."""
    jsonschema.validate(body([BASE]), answer_format("chain"))
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(body([("filter", arguments)]), answer_format("chain"))


KOENIZ = {"op": "compare", "attr": "name", "cmp": "eq", "value": "Köniz"}
IN_KOENIZ = {"op": "related", "layer": "gemeinden", "predicate": "within", "where": KOENIZ}
SCHOOLS_IN: Steps = [
    ("filter", {"layer": "gemeinden", "where": KOENIZ}),
    ("within", {"of": "schulen", "in": 1}),
]


@pytest.mark.parametrize(
    ("steps", "expected"),
    [
        (
            [
                ("filter", {"layer": "gemeinden", "where": KOENIZ}),
                ("within", {"of": "schulen", "in": 1}),
            ],
            {
                "source": "schulen",
                "where": {
                    "op": "related",
                    "layer": "gemeinden",
                    "predicate": "within",
                    "where": KOENIZ,
                },
            },
        ),
        (
            [("near", {"of": "schulen", "to": "haltestellen", "distance_m": 100})],
            {
                "source": "schulen",
                "where": {
                    "op": "related",
                    "layer": "haltestellen",
                    "predicate": "dwithin",
                    "distance_m": 100,
                },
            },
        ),
    ],
    ids=["of-a-layer", "both-layers"],
)
def test_a_spatial_step_takes_a_whole_layer_by_name(
    steps: Steps, expected: dict[str, Any], world: World
) -> None:
    """F11: a layer's name in ``of``, ``in``, ``to`` or ``with`` is all its
    features, with no condition: the query a direct answer would write."""
    planned_steps = [PlannedStep(text="x", tool=tool, arguments=args) for tool, args in steps]
    checked = check_plan(planned_steps, world.context, world.profile)
    assert not isinstance(checked, Refusal), checked
    assert canonical_json(checked[-1].query) == canonical_json(QueryObject.model_validate(expected))


@pytest.mark.parametrize(
    ("arguments", "tool", "code"),
    [
        ({"of": "spitaeler", "to": "haltestellen", "distance_m": 100}, "near", "unknown_layer"),
        ({"of": "1", "to": "haltestellen", "distance_m": 100}, "near", "model_query_invalid"),
        ({"of": "schulen", "where": KOENIZ}, "filter", "model_query_invalid"),
    ],
    ids=["unknown-layer", "number-as-text", "filter-of-a-layer"],
)
def test_a_layer_by_name_is_checked_as_any(
    arguments: dict[str, Any], tool: str, code: str, world: World
) -> None:
    """Checked as a layer of a query (unknown and hidden alike, S3); a step
    number written as text is no name; ``filter`` names a layer in ``layer``."""
    found = check_plan(
        [PlannedStep(text="x", tool=tool, arguments=arguments)], world.context, world.profile
    )
    assert isinstance(found, Refusal) and found.code == code


# --- parity with the service ---------------------------------------------------------

TEXT = "Welche Primarschulen?"
NOTHING_AGAIN = ("filter", {"of": 1, "where": NOWHERE})

SCRIPTS: dict[str, Callable[[], list[Completion]]] = {
    "done": lambda: [reference_plan()],
    "re-planned after an empty step": lambda: [
        planned(*EMPTY_THEN),
        planned(MUNICIPALITIES, within(1, 3), why="Gemeinden statt nichts."),
    ],
    "re-plans used up": lambda: [
        planned(*EMPTY_THEN),
        planned(NOTHING_AGAIN, MUNICIPALITIES, within(3, 4)),
        planned(NOTHING_AGAIN, MUNICIPALITIES, within(4, 5)),
    ],
    "a re-plan beyond the step limit": lambda: [planned(*EMPTY_THEN), revised(7)],
    "a re-plan that does not read": lambda: [
        planned(*EMPTY_THEN),
        Completion(text="Ich plane neu.", parse_error="not JSON"),
    ],
    "a plan refused, its correction too": lambda: [
        completion(model_case("step_limit")),  # type: ignore[list-item]
        completion(model_case("step_limit")),  # type: ignore[list-item]
    ],
    "a plan refused, then corrected": lambda: [
        planned(MUNICIPALITIES, within(1, 3), NOTHING_AGAIN),
        planned(*EMPTY_THEN),
        planned(MUNICIPALITIES, within(1, 3), why="Gemeinden statt nichts."),
    ],
    "no plan": lambda: [completion(model_case("clarification"))],  # type: ignore[list-item]
}


def service_end(view: Body) -> str:
    """The record's status in the words of ``ChainRun.end``."""
    ends = {"done": "done", "refused": "refused", "answered": "answered"}
    end: str = ends.get(view["status"]) or view["stop_reason"]
    return end


def code_of(view: Body) -> str | None:
    return (view["error"] or {}).get("code") or (view["refusal"] or {}).get("code")


@pytest.mark.parametrize("name", list(SCRIPTS))
async def test_the_driver_runs_a_chain_as_the_service_does(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    levels: dict[str, int],
    name: str,
) -> None:
    """The same script, through the application at *Automatisch* and through
    ``drive`` in the same account's world: the model is asked the same, word
    for word, the same steps run with the same counts, and the chain ends the
    same way with the same result."""
    await choose(client, levels["Automatisch"])
    # The whole script at once: a correction (F7) is asked before the plan is stored.
    first, *rest = SCRIPTS[name]()
    asked = await ask_chain(client, app, model, first, *rest, text=TEXT)
    ended, approvals = await drive_api(client, app, asked["id"])
    assert approvals == 0

    state = app.state.geotandem
    who = account_of(app, "admin")
    view, profile = profile_for(state.backend, who)
    level = active_level(state.backend.engine, who.id, admin=True)
    prompt = build_prompt(TEXT, approach="chain", level=level, profile=profile)
    fake = FakeLLMClient(script=list(SCRIPTS[name]()))
    run = drive(fake, prompt, state.tool_context(view), profile)

    assert [call.messages for call in fake.calls] == [call.messages for call in model.fake.calls]
    assert [(s.position, s.tool, s.status, s.count) for s in run.steps] == [
        (s["position"], s["tool"], s["status"], s["hits"])
        for s in ended["steps"]
        if s["status"] in RAN
    ]
    assert (run.end, run.replans) == (service_end(ended), ended["replans"])
    driver_code = (run.error or {}).get("code") or (run.refusal.code if run.refusal else None)
    assert driver_code == code_of(ended)
    result = compact(run.result) if run.result is not None else None
    assert result == ended["query"]


# --- parity with the direct path -----------------------------------------------------

SPATIAL = {"related", "near_feature", "geometry", "bbox"}
PLAIN = [
    case
    for case in start_set()
    if case.gold is not None
    and case.gold.get("where")
    and not {c["op"] for c in conditions(case.gold["where"])} & SPATIAL
]


@pytest.mark.parametrize("case", PLAIN, ids=[case.id for case in PLAIN])
@pytest.mark.parametrize("negated", [False, True], ids=["reference", "negated"])
def test_a_chain_of_one_filter_is_graded_as_the_direct_answer(
    case: EvalCase, negated: bool, world: World, level: Level
) -> None:
    """Plan item 4: the reference's conditions, and their negation, once as a
    direct answer and once as a chain of one filter: the same verdict."""
    where = case.gold["where"] if case.gold else None
    if negated:
        where = {"op": "not", "arg": where}
    query = {"source": case.gold["source"] if case.gold else None, "where": where, "output": "map"}
    readings = reading_ids(case, world.context, world.profile)

    said = {"kind": "query", "explanation": "So.", "assumptions": [], "query": query}
    direct = parse_answer(Completion(text=json.dumps(said), parsed=said), "direct")
    assert isinstance(direct, QueryAnswer)
    checked = validate_model_query(direct.query, world.context, world.profile)
    found, refusal = (checked.query, None) if isinstance(checked, Validated) else (None, checked)
    expected = grade(case, direct, refusal, found, world.context.backend, LIMITS, readings)

    step = ("filter", {"layer": query["source"], "where": where})
    fake = FakeLLMClient(script=[scripted([step])])
    prompt = build_prompt(case.prompt, approach="chain", level=level, profile=world.profile)
    run = drive(fake, prompt, world.context, world.profile)
    assert graded(case, run, world.context.backend, LIMITS, readings).tag == expected.tag
    if not negated:
        assert expected.tag == "pass"
