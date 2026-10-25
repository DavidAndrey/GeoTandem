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
from pydantic import ValidationError
from test_eval_grade import ANSWERS, LIMITS, START

from geotandem.catalog import model_profile
from geotandem.data import DataBackend
from geotandem.engine import ids_query
from geotandem.engine.errors import QueryTimedOut
from geotandem.evaluation import grade as grade_module
from geotandem.evaluation import stages as stages_module
from geotandem.evaluation.diff import canonical, diff
from geotandem.evaluation.grade import query_of, reading_ids
from geotandem.evaluation.schemas import MAX_IDS, AnswerView, DiffEntry, EvalCase
from geotandem.evaluation.stages import Assessment, assess, unanswered
from geotandem.llm import Completion
from geotandem.model.result import parse_answer
from geotandem.model.schemas import QueryAnswer
from geotandem.model.shapes import plain
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
    case = START[item["case"]]
    return assess(
        case, answer, refusal, query, backend, LIMITS, readings=readings_of(case, backend)
    )


def readings_of(case: EvalCase, backend: DataBackend) -> list[list[int]] | None:
    """The case's readings as a run reads them: checked in the sample's profile."""
    profile = model_profile(backend.engine, backend.layer_names())
    return reading_ids(case, ToolContext(backend=backend, limits=LIMITS), profile)


def entries(found: Assessment) -> list[tuple[str, str]]:
    assert found.diff is not None
    return [(e.kind, e.path) for e in found.diff]


def q(where: dict[str, Any] | None, source: str = "schulen", **rest: Any) -> QueryObject:
    return QueryObject.model_validate({"source": source, "where": where, **rest})


PRIMAR = {"op": "compare", "attr": "typ", "cmp": "eq", "value": "primar"}
DE = {"op": "compare", "attr": "sprache", "cmp": "eq", "value": "de"}
MUNSINGEN = {
    "op": "related",
    "layer": "gemeinden",
    "predicate": "within",
    "where": {"op": "compare", "attr": "name", "cmp": "eq", "value": "Münsingen"},
}
TRAM: dict[str, Any] = {
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
    assert len(diff(query_of(case.gold_any[0], case.schema_version), answer)) == 3
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
    found = assess(case, answer, None, every, sample, LIMITS, readings=readings_of(case, sample))
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
    monkeypatch.setattr(stages_module, "grade", _fails)
    found = assessed(RECORDED["pass-reordered"], sample)
    assert (found.verdict, found.code, found.diff) == ("error", "query_timeout", None)


def _fails(*args: Any) -> list[int]:
    raise QueryTimedOut("The query took longer than 10 s and was stopped.", timeout_s=10)


def test_reading_the_hits_after_grading_never_changes_the_verdict(
    sample: DataBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A ``require`` case that passed: the grader read no hits, the view's
    reading fails; the verdict stays, the view's fields stay empty."""
    [item] = [i for i in ANSWERS if i["what"] == "pass-require"]
    monkeypatch.setattr(stages_module, "ids_query", _fails)
    found = assessed(item, sample)
    assert (found.verdict, found.hits, found.diff, found.reading) == ("pass", None, None, None)


@pytest.mark.parametrize("what", ["pass-reordered", "wrong-distance"])
def test_a_gold_case_takes_the_answers_hits_from_the_grader(
    what: str, sample: DataBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The answer's query runs once, in the grader; the readings not at all,
    they come from the caller (``reading_ids``, once per case)."""
    item = RECORDED[what]
    case = START[item["case"]]
    readings = readings_of(case, sample)
    calls: list[QueryObject] = []
    real = ids_query

    def counted(query: QueryObject, *args: Any) -> list[int]:
        calls.append(query)
        return real(query, *args)

    monkeypatch.setattr(grade_module, "ids_query", counted)
    monkeypatch.setattr(stages_module, "ids_query", _fails)
    answer = parse_answer(Completion(text=json.dumps(item["answer"])), "direct")
    assert isinstance(answer, QueryAnswer)
    profile = model_profile(sample.engine, sample.layer_names())
    checked = validate_model_query(
        answer.query, ToolContext(backend=sample, limits=LIMITS), profile
    )
    assert isinstance(checked, Validated)
    found = assess(case, answer, None, checked.query, sample, LIMITS, readings=readings)
    assert found.verdict == item["tag"].split(":")[0]
    assert found.hits is not None and found.diff is not None
    assert len(calls) == 1


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
        ("missing", "where.args[1]"),
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
        "where.args[1]",
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
    assert [(e.kind, e.path) for e in found] == [
        ("missing", "where.args[1].where"),
        ("added", "where.args[0]"),
    ]
    assert canonical(answer)["where"]["args"][0] == DE


def test_parts_beside_where_are_compared_whole() -> None:
    buffer = {"distance_m": 100}
    found = diff(q(PRIMAR, limit=5), q(PRIMAR, buffer=buffer))
    assert [(e.kind, e.path) for e in found] == [("added", "buffer"), ("missing", "limit")]


def test_computed_columns_are_compared(sample: DataBackend) -> None:
    """The nearest five schools to a tram stop or to a road: same source and
    filter, other features, because ``order_by`` and ``limit`` read the column."""

    def nearest(layer: str) -> QueryObject:
        column = {"fn": "distance_to", "name": "abstand", "layer": layer}
        return q(None, columns=[column], order_by=[{"attr": "abstand"}], limit=5)

    [entry] = diff(nearest("haltestellen"), nearest("strassen"))
    assert (entry.kind, entry.path) == ("changed", "columns")
    assert (entry.reference[0]["layer"], entry.answer[0]["layer"]) == ("haltestellen", "strassen")


def test_values_compare_as_json_true_is_not_one() -> None:
    yes = {"op": "compare", "attr": "sekundarstufe", "cmp": "eq", "value": True}
    one = {**yes, "value": 1}
    assert [e.kind for e in diff(q(yes), q(one))] == ["changed"]
    within = {"op": "in", "attr": "standorte", "values": [True]}
    assert [e.kind for e in diff(q(within), q({**within, "values": [1]}))] == ["changed"]
    assert diff(q({**within, "values": [1, True]}), q({**within, "values": [True, 1, 1]})) == []


def test_repeats_are_dropped_and_named_results_may_differ() -> None:
    assert (
        diff(q({"op": "and", "args": [PRIMAR, DE]}), q({"op": "and", "args": [DE, PRIMAR, DE]}))
        == []
    )
    aggregate = {"by_layer": "gemeinden", "metrics": [{"fn": "count", "as": "anzahl"}]}
    renamed = {**aggregate, "metrics": [{"fn": "count", "as": "schulen"}]}
    assert diff(q(None, aggregate=aggregate), q(None, aggregate=renamed)) == []
    counted = {**aggregate, "predicate": "intersects"}
    assert [e.path for e in diff(q(None, aggregate=aggregate), q(None, aggregate=counted))] == [
        "aggregate"
    ]


def test_the_filter_of_a_spatial_relation_is_normalised() -> None:
    def relation(where: dict[str, Any]) -> QueryObject:
        rel = {"layer": "gemeinden", "predicate": "within", "where": where}
        return q(None, spatial_relation=rel)

    names = [{"op": "compare", "attr": "name", "cmp": "eq", "value": v} for v in ("Bern", "Köniz")]
    assert (
        diff(
            relation({"op": "or", "args": names}),
            relation({"op": "or", "args": [{"op": "or", "args": names[::-1]}]}),
        )
        == []
    )


def test_a_not_pairs_by_what_it_negates() -> None:
    near = {"op": "not", "arg": TRAM}
    other = {"op": "not", "arg": DE}
    farther = {"op": "not", "arg": {**TRAM, "distance_m": 800}}
    found = diff(
        q({"op": "and", "args": [other, near]}), q({"op": "and", "args": [farther, other]})
    )
    assert [(e.kind, e.path) for e in found] == [("changed", "where.args[1].arg")]
    assert (found[0].reference["distance_m"], found[0].answer["distance_m"]) == (400, 800)
    found = diff(q(near), q(TRAM))
    assert [(e.kind, e.path) for e in found] == [("missing", "where"), ("added", "where")]


def test_a_path_addresses_the_node_in_the_stored_reference() -> None:
    """Paths follow the stored trees, not the sorted canonical form, as the
    interface shows the stored query."""
    stored = {"op": "and", "args": [TRAM, {"op": "and", "args": [DE, PRIMAR]}]}
    answer = {"op": "and", "args": [PRIMAR, {**TRAM, "distance_m": 300}, MUNSINGEN]}
    found = diff(q(stored), q(answer))
    assert [(e.kind, e.path) for e in found] == [
        ("changed", "where.args[0]"),
        ("missing", "where.args[1].args[0]"),
        ("added", "where.args[2]"),
    ]
    for entry in found:
        side = stored if entry.kind != "added" else answer
        node = _at({"where": side}, entry.path)
        shown = entry.reference if entry.kind != "added" else entry.answer
        assert {k: v for k, v in node.items() if k != "where"} == {
            k: v for k, v in shown.items() if k != "where"
        }


def _at(tree: Any, path: str) -> Any:
    for part in path.replace("]", "").replace("[", ".").split("."):
        tree = tree[int(part)] if part.isdigit() else tree[part]
    return tree


def test_a_diff_holds_only_the_queries_own_values(sample: DataBackend) -> None:
    """The security list of the WP gate: no data value beyond the queries'
    own conditions, no row content."""
    for item in RECORDED.values():
        case = START[item["case"]]
        answer = QueryObject.model_validate(item["answer"]["query"])
        for reading in case.readings():
            stated = query_of(reading, case.schema_version)
            own = _scalars(canonical(stated)) | _scalars(canonical(answer))
            for entry in diff(stated, answer):
                assert _scalars(entry.reference) | _scalars(entry.answer) <= own


def _scalars(value: Any) -> set[str]:
    if isinstance(value, dict):
        return {s for v in value.values() for s in _scalars(v)} | set(value)
    if isinstance(value, list):
        return {s for v in value for s in _scalars(v)}
    return set() if value is None else {json.dumps(value)}


def _recorded_queries() -> list[QueryObject]:
    found = []
    for item in [*ANSWERS, *RECORDED.values()]:
        query = item.get("answer", {}).get("query")
        # An answer refused at stage 0 for its schema has no query object.
        if query is not None and _valid(query):
            found.append(QueryObject.model_validate(query))
    return found


def _valid(query: dict[str, Any]) -> bool:
    try:
        QueryObject.model_validate(query)
    except ValidationError:
        return False
    return True


def test_the_canonical_form_takes_in_every_rule_of_the_harmless_shapes() -> None:
    """D5: what ``shapes.plain`` rewrites (E-3) the diff sees as equal, so a new
    rule there cannot silently diverge from stage 1."""
    queries = _recorded_queries()
    assert len(queries) > 20
    for query in queries:
        assert diff(query, plain(query)) == [], query


def test_the_readings_must_be_given_for_a_case_with_readings(sample: DataBackend) -> None:
    """WP90: no silent skip of the diff when the caller forgot the readings."""
    item = RECORDED["pass-reordered"]
    case = START[item["case"]]
    answer = parse_answer(Completion(text=json.dumps(item["answer"])), "direct")
    with pytest.raises(ValueError, match="readings"):
        assess(case, answer, None, None, sample, LIMITS, readings=None)
    behaviour = START["n15-je-gemeinde"]
    with pytest.raises(ValueError, match="readings"):
        assess(behaviour, answer, None, None, sample, LIMITS, readings=[[1]])
