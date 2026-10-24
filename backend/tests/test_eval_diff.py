"""Stages 0-2 and the stage-1 diff (plan E3, D5; ``evaluation/diff.py``,
``evaluation/stages.py``) against recorded answers.

The cases of bewertung.md 4: a query worded otherwise but right passes, with
a diff that says how it differs; a query like the reference but wrong fails,
with a diff that names the difference. ``eval_diff_answers.json`` holds
answers real models gave in the testplans; each is read and checked as
``DirectQuery.ask`` does it, then assessed over the sample data. The
normalisation and the matching of conditions are tested on queries written
here.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from test_eval_grade import ANSWERS, LIMITS, START

from geotandem.catalog import model_profile
from geotandem.data import DataBackend
from geotandem.engine.errors import QueryTimedOut
from geotandem.evaluation import stages as stages_module
from geotandem.evaluation.diff import canonical, diff
from geotandem.evaluation.grade import query_of
from geotandem.evaluation.schemas import MAX_IDS, AnswerView, DiffEntry
from geotandem.evaluation.stages import Assessment, assess, unanswered
from geotandem.llm import Completion
from geotandem.model.result import parse_answer
from geotandem.model.schemas import QueryAnswer
from geotandem.model.validate import Validated, validate_model_query
from geotandem.tools import ToolContext
from geotandem_query import QueryObject

HERE = Path(__file__).parent
RECORDED: dict[str, dict[str, Any]] = {
    item["what"]: item
    for item in json.loads((HERE / "eval_diff_answers.json").read_text("utf-8"))["answers"]
}


def assessed(item: dict[str, Any], backend: DataBackend) -> Assessment:
    """As a run will do it: the answer read, its query checked in the sample's
    profile (stage 0), then assessed."""
    answer = parse_answer(Completion(text=json.dumps(item["answer"])), "direct")
    query = refusal = None
    if isinstance(answer, QueryAnswer):
        profile = model_profile(backend.engine, backend.layer_names())
        context = ToolContext(backend=backend, limits=LIMITS)
        checked = validate_model_query(answer.query, context, profile)
        if isinstance(checked, Validated):
            query = checked.query
        else:
            refusal = checked
    return assess(START[item["case"]], answer, refusal, query, backend, LIMITS)


def entries(found: Assessment) -> list[tuple[str, str]]:
    assert found.diff is not None
    return [(e.kind, e.path) for e in found.diff]


def q(where: dict[str, Any] | None, source: str = "schulen", **rest: Any) -> QueryObject:
    return QueryObject.model_validate({"source": source, "where": where, **rest})


PRIMAR = {"op": "compare", "attr": "typ", "cmp": "eq", "value": "primar"}
DE = {"op": "compare", "attr": "sprache", "cmp": "eq", "value": "de"}
TRAM = {
    "op": "related",
    "layer": "haltestellen",
    "predicate": "dwithin",
    "distance_m": 400,
    "where": {"op": "compare", "attr": "verkehrsmittel", "cmp": "eq", "value": "tram"},
}


# --- recorded answers: stage 2 judges, stage 1 explains ----------------------------


@pytest.mark.parametrize("what", list(RECORDED))
def test_the_verdict_is_the_graders(what: str, sample: DataBackend) -> None:
    item = RECORDED[what]
    assert assessed(item, sample).verdict == item["tag"].split(":")[0]


def test_reordered_conditions_pass_with_an_empty_diff(sample: DataBackend) -> None:
    """Luna wrote doc6's three conditions in another order than the reference."""
    found = assessed(RECORDED["pass-reordered"], sample)
    assert (found.verdict, found.diff, found.reading) == ("pass", [], 0)
    assert found.hits == found.reference_hits == 81


def test_a_query_worded_otherwise_passes_with_a_diff(sample: DataBackend) -> None:
    """``not within (Bern, Köniz)`` written as ``not within Bern and not within
    Köniz``: the same stops, another query. Stage 1 shows it, stage 2 passes it."""
    found = assessed(RECORDED["pass-reworded"], sample)
    assert found.verdict == "pass"
    assert entries(found) == [("changed", "where.arg.where"), ("added", "where.args[1]")]
    assert found.hits == found.reference_hits == 617
    assert found.only_answer == found.only_reference == []


def test_another_predicate_with_the_same_features_passes_and_shows_it(
    sample: DataBackend,
) -> None:
    found = assessed(RECORDED["pass-predicate"], sample)
    assert found.verdict == "pass"
    assert found.diff == [
        DiffEntry(
            kind="changed",
            path="where",
            reference={"layer": "gemeinden", "op": "related", "predicate": "within"},
            answer={"layer": "gemeinden", "op": "related", "predicate": "intersects"},
        )
    ]


def test_a_changed_distance_is_named(sample: DataBackend) -> None:
    found = assessed(RECORDED["wrong-distance"], sample)
    assert found.verdict == "wrong"
    assert found.diff is not None
    relation = found.diff[0]
    assert (relation.kind, relation.path) == ("changed", "where")
    assert (relation.reference["distance_m"], relation.answer["distance_m"]) == (1000, 300)
    assert (found.hits, found.reference_hits) == (31, 4)
    assert (found.only_answer_count, found.only_reference_count) == (27, 0)
    assert len(found.only_answer) == 27


def test_a_missing_filter_is_named_and_flagged_silent(sample: DataBackend) -> None:
    """As Luna's n03: the explanation says "Bahnhaltestellen", the query has no
    filter on the means of transport, and no assumption says so."""
    found = assessed(RECORDED["wrong-missing-filter"], sample)
    assert (found.verdict, found.flags) == ("wrong", ["no_assumption"])
    assert found.diff == [
        DiffEntry(
            kind="missing",
            path="where.args[0]",
            reference={"attr": "verkehrsmittel", "cmp": "eq", "op": "compare", "value": "bahn"},
        )
    ]
    assert (found.hits, found.reference_hits, found.only_answer_count) == (18, 1, 17)


def test_a_wrong_source_is_named(sample: DataBackend) -> None:
    """Rivers that cross the Aare's municipalities, not the municipalities the
    Aare crosses: source and relation swapped."""
    found = assessed(RECORDED["wrong-source"], sample)
    assert (found.verdict, found.flags) == ("wrong", ["zero_hits"])
    assert found.diff is not None
    assert found.diff[0] == DiffEntry(
        kind="source", path="source", reference="gemeinden", answer="gewaesser"
    )
    assert entries(found)[1] == ("changed", "where")
    assert (found.only_answer_count, found.only_reference_count) == (0, 19)


def test_a_gold_any_case_refers_to_the_reading_passed(sample: DataBackend) -> None:
    """doc1: "Primarschulen" is ``typ = primar`` or ``primarstufe = ja``;
    Luna's answer is the second."""
    found = assessed(RECORDED["gold_any-second"], sample)
    assert (found.verdict, found.reading, found.diff) == ("pass", 1, [])
    assert found.hits == found.reference_hits == 8


def test_a_wrong_gold_any_answer_refers_to_the_nearest_reading(sample: DataBackend) -> None:
    """The second reading with ``contains`` for ``within``: one entry against
    it, three against the first."""
    item = RECORDED["gold_any-nearest"]
    found = assessed(item, sample)
    assert (found.verdict, found.reading) == ("wrong", 1)
    assert entries(found) == [("changed", "where.args[1]")]
    case = START[item["case"]]
    assert case.gold_any is not None
    answer = QueryObject.model_validate(item["answer"]["query"])
    assert len(diff(query_of(case.gold_any[0]), answer)) == 3
    assert (found.hits, found.reference_hits, found.only_reference_count) == (0, 8, 8)


# --- the fields of an answer view --------------------------------------------------


@pytest.mark.parametrize("item", ANSWERS, ids=[item["what"] for item in ANSWERS])
def test_every_recorded_answer_makes_an_answer_view(
    item: dict[str, Any], sample: DataBackend
) -> None:
    """The grader's fixture: stage 2 as WP86 recorded it; readings, diff and
    result sets only where a checked query meets a case with readings."""
    found = assessed(item, sample) if "answer" in item else unanswered(item["code"])
    assert (found.verdict, found.code, found.flags) == (
        item["verdict"],
        item["code"],
        item["flags"],
    )
    case = START[item["case"]]
    readings = bool(case.gold or case.gold_any)
    has_query = found.hits is not None
    assert (found.diff is not None) == (found.reading is not None) == (readings and has_query)
    if not readings:
        assert found.reference_hits is None
    view = AnswerView(
        case_id=item["case"],
        point=0,
        block=0,
        seed=1,
        latency_ms=None,
        prompt_tokens=None,
        completion_tokens=None,
        answer=None,
        **found.view_fields(),
    )
    assert view.verdict == item["verdict"]


def test_a_refused_query_ends_at_stage_0(sample: DataBackend) -> None:
    [item] = [i for i in ANSWERS if i["what"] == "refused:unknown_attribute"]
    found = assessed(item, sample)
    assert (found.verdict, found.code) == ("refused", "unknown_attribute")
    assert (found.reading, found.diff, found.hits, found.reference_hits) == (None,) * 4


def test_a_require_case_has_hits_but_no_reading(sample: DataBackend) -> None:
    [item] = [i for i in ANSWERS if i["what"] == "wrong-missing-silent"]
    found = assessed(item, sample)
    assert found.verdict == "wrong"
    assert (found.reading, found.diff, found.reference_hits) == (None, None, None)
    assert found.hits is not None


def test_the_id_lists_are_capped_and_the_counts_exact(sample: DataBackend) -> None:
    """Every stop against those outside Bern and Köniz: the stops inside are
    the answer's alone, more than ``MAX_IDS`` of them."""
    case = START["h25-ausserhalb-bern-koeniz"]
    every = q(None, "haltestellen")
    answer = QueryAnswer.model_validate(
        {
            "kind": "query",
            "explanation": "Alle.",
            "assumptions": [],
            "query": {"source": "haltestellen"},
        }
    )
    found = assess(case, answer, None, every, sample, LIMITS)
    assert found.verdict == "wrong"
    assert found.hits is not None and found.reference_hits is not None
    assert found.only_answer_count == found.hits - found.reference_hits > MAX_IDS
    assert len(found.only_answer) == MAX_IDS
    assert found.only_answer == sorted(found.only_answer)
    assert (found.only_reference, found.only_reference_count) == ([], 0)
    assert entries(found) == [("missing", "where")]


def test_a_query_the_engine_cannot_run_is_an_error_with_its_code(
    sample: DataBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    def timed_out(*args: Any) -> list[int]:
        raise QueryTimedOut("The query took longer than 10 s and was stopped.", timeout_s=10)

    monkeypatch.setattr(stages_module, "grade", timed_out)
    found = assessed(RECORDED["pass-reordered"], sample)
    assert (found.verdict, found.code, found.diff) == ("error", "query_timeout", None)


# --- normalisation and matching ------------------------------------------------------


@pytest.mark.parametrize(
    ("reference", "answer"),
    [
        ({"op": "and", "args": [PRIMAR, DE]}, {"op": "and", "args": [DE, PRIMAR]}),
        (
            {"op": "and", "args": [PRIMAR, DE, TRAM]},
            {"op": "and", "args": [{"op": "and", "args": [TRAM, DE]}, PRIMAR]},
        ),
        (PRIMAR, {"op": "and", "args": [PRIMAR]}),
        (PRIMAR, {"op": "not", "arg": {"op": "not", "arg": PRIMAR}}),
        (
            {"op": "in", "attr": "typ", "values": ["primar", "sekundar"]},
            {"op": "in", "attr": "typ", "values": ["sekundar", "primar"]},
        ),
        (
            {"op": "compare", "attr": "standorte", "cmp": "gt", "value": 1},
            {"op": "compare", "attr": "standorte", "cmp": "gt", "value": 1.0},
        ),
        (
            {"op": "or", "args": [PRIMAR, {"op": "related", **TRAM, "distance_m": 400.0}]},
            {"op": "or", "args": [TRAM, PRIMAR]},
        ),
    ],
    ids=["and-order", "nested-and", "and-of-one", "not-not", "in-order", "5.0", "or-order"],
)
def test_what_only_looks_different_is_equal(
    reference: dict[str, Any], answer: dict[str, Any]
) -> None:
    assert diff(q(reference), q(answer)) == []


def test_defaults_written_out_or_left_away_are_equal() -> None:
    written = q(PRIMAR, schema_version="2", output="map", columns=[], order_by=[])
    assert diff(q(PRIMAR), written) == []
    assert diff(q(PRIMAR), q(PRIMAR, output="table", select=["name"])) == []


def test_a_condition_on_another_attribute_is_missing_and_added() -> None:
    found = diff(q({"op": "and", "args": [PRIMAR, DE]}), q({"op": "and", "args": [PRIMAR, TRAM]}))
    assert [(e.kind, e.path) for e in found] == [
        ("missing", "where.args[0]"),
        ("added", "where.args[1]"),
    ]


def test_the_same_attribute_with_another_operator_is_changed() -> None:
    between = {"op": "between", "attr": "standorte", "min": 2, "max": 5}
    greater = {"op": "compare", "attr": "standorte", "cmp": "gt", "value": 1}
    [entry] = diff(
        q({"op": "and", "args": [PRIMAR, greater]}), q({"op": "and", "args": [between, PRIMAR]})
    )
    assert (entry.kind, entry.path, entry.reference, entry.answer) == (
        "changed",
        "where.args[0]",
        greater,
        between,
    )


def test_a_relation_to_another_layer_is_changed_and_its_filter_compared() -> None:
    other = {**TRAM, "layer": "strassen", "where": {**TRAM["where"], "value": "bus"}}
    found = diff(q(TRAM), q(other))
    assert [(e.kind, e.path) for e in found] == [("changed", "where"), ("changed", "where.where")]
    assert "where" not in found[0].reference and "where" not in found[0].answer
    assert (found[0].reference["layer"], found[0].answer["layer"]) == ("haltestellen", "strassen")


def test_and_against_or_pairs_nothing() -> None:
    found = diff(q({"op": "and", "args": [PRIMAR, DE]}), q({"op": "or", "args": [PRIMAR, DE]}))
    assert [(e.kind, e.path) for e in found] == [("missing", "where"), ("added", "where")]


def test_paths_point_into_the_reference_and_added_into_the_answer() -> None:
    reference = q({"op": "and", "args": [PRIMAR, TRAM]})
    answer = q({"op": "and", "args": [DE, PRIMAR, {**TRAM, "where": None}]})
    found = diff(reference, answer)
    # canonical order: the answer's arguments are DE (sprache), PRIMAR, TRAM
    assert [(e.kind, e.path) for e in found] == [
        ("missing", "where.args[1].where"),
        ("added", "where.args[0]"),
    ]
    assert canonical(answer)["where"]["args"][0] == DE


def test_parts_beside_where_are_compared_whole() -> None:
    buffer = {"distance_m": 100}
    found = diff(q(PRIMAR, limit=5), q(PRIMAR, buffer=buffer))
    assert [(e.kind, e.path) for e in found] == [("added", "buffer"), ("missing", "limit")]


def test_a_diff_holds_only_the_queries_own_values(sample: DataBackend) -> None:
    """The security list of the WP gate: no data value beyond the queries'
    own conditions, no row content."""
    for item in RECORDED.values():
        case = START[item["case"]]
        readings = case.gold_any or [case.gold]
        answer = QueryObject.model_validate(item["answer"]["query"])
        for reading in readings:
            assert reading is not None
            own = _scalars(canonical(query_of(reading))) | _scalars(canonical(answer))
            for entry in diff(query_of(reading), answer):
                assert _scalars(entry.reference) | _scalars(entry.answer) <= own


def _scalars(value: Any) -> set[str]:
    if isinstance(value, dict):
        return {s for v in value.values() for s in _scalars(v)} | set(value)
    if isinstance(value, list):
        return {s for v in value for s in _scalars(v)}
    return set() if value is None else {json.dumps(value)}
