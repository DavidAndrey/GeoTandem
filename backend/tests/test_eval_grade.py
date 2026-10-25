"""The shared grader (plan E3, D5, D6; ``evaluation/grade.py``) against recorded answers.

``eval_answers.json`` holds answers real models gave in the testplans, one per
kind of outcome, with the tag the harness wrote for them. Each is read, checked
and graded as ``evals/regrade.py`` does it, over the sample data: the tag must
come out as recorded, with the contract's verdict, code and flags beside it. An
answer that does not read must fail the parser with the recorded code. The
``require`` path and its flags are tested on queries written here.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from geotandem.catalog import ModelProfile, model_profile
from geotandem.config import Settings
from geotandem.data import DataBackend, Limits
from geotandem.engine.errors import QueryTimedOut
from geotandem.evaluation import grade as grade_module
from geotandem.evaluation.cases import sample_world, start_set
from geotandem.evaluation.grade import (
    Graded,
    conditions,
    errored,
    grade,
    matches,
    query_of,
    reading_ids,
)
from geotandem.evaluation.schemas import EvalCase, Require
from geotandem.llm import Completion
from geotandem.model.errors import ActionError
from geotandem.model.result import parse_answer
from geotandem.model.schemas import CannotAnswer, QueryAnswer
from geotandem.model.validate import Validated, validate_model_query
from geotandem.tools import ToolContext

HERE = Path(__file__).parent
LIMITS = Limits(max_features=10_000, timeout_s=10)
ANSWERS: list[dict[str, Any]] = json.loads((HERE / "eval_answers.json").read_text("utf-8"))[
    "answers"
]


START = {case.id: case for case in start_set()}
"""As the application and the harness read it (``cases.start_set``)."""


def graded(
    item: dict[str, Any],
    backend: DataBackend,
    context: ToolContext | None = None,
    profile: ModelProfile | None = None,
) -> Graded:
    """As ``evals/regrade.py`` (``main``, the loop over the stored records) and
    ``evals/run.py`` (``errored`` for an ``ActionError``): the answer read
    again, a query checked in the sample's profile, then graded, with the
    readings checked and read once (``reading_ids``)."""
    if "answer" not in item:
        # Never read: the parser must still refuse the verbatim text.
        completion = Completion(text=item["raw"], finish_reason=item["finish_reason"])
        with pytest.raises(ActionError) as failed:
            parse_answer(completion, "direct")
        return errored(failed.value.code)
    answer = parse_answer(Completion(text=json.dumps(item["answer"])), "direct")
    profile = profile or model_profile(backend.engine, backend.layer_names())
    context = context or ToolContext(backend=backend, limits=LIMITS)
    query = refusal = None
    if isinstance(answer, QueryAnswer):
        checked = validate_model_query(answer.query, context, profile)
        if isinstance(checked, Validated):
            query = checked.query
        else:
            refusal = checked
    case = START[item["case"]]
    readings = reading_ids(case, context, profile)
    return grade(case, answer, refusal, query, backend, LIMITS, readings)


def test_the_fixture_covers_every_verdict_and_flag() -> None:
    verdicts = {item["verdict"] for item in ANSWERS}
    assert verdicts == {"pass", "wrong", "refused", "kind", "other_approach", "forbidden", "error"}
    flags = {tuple(item["flags"]) for item in ANSWERS if item["verdict"] == "wrong"}
    assert flags == {(), ("no_assumption",), ("zero_hits",), ("no_assumption", "zero_hits")}


@pytest.mark.parametrize("item", ANSWERS, ids=[item["what"] for item in ANSWERS])
def test_a_recorded_answer_grades_as_the_harness_wrote(
    item: dict[str, Any], sample: DataBackend
) -> None:
    found = graded(item, sample)
    assert found.tag == item["tag"]
    assert (found.verdict, found.code, list(found.flags)) == (
        item["verdict"],
        item["code"],
        item["flags"],
    )


def test_the_application_path_grades_the_recorded_answers_alike(tmp_path: Path) -> None:
    """T1: through ``sample_world`` (the read-only sample a run of the
    application uses), every recorded answer gets the harness's verdict."""
    world = sample_world(Settings(data_dir=tmp_path), LIMITS)
    backend = world.context.backend
    for item in ANSWERS:
        found = graded(item, backend, world.context, world.profile)
        assert (found.tag, found.verdict, list(found.flags)) == (
            item["tag"],
            item["verdict"],
            item["flags"],
        ), item["what"]


def test_an_answer_that_never_came_is_an_error_with_its_code() -> None:
    """``evals/run.py`` grades a transport error (``LLMError``) so."""
    assert errored("llm_timeout") == Graded("error", "error:llm_timeout", "llm_timeout")


# --- the require path (no recorded answer reaches every branch) -------------------

ASSUMED = [{"text": "Gross heisst hier: viele Einwohner."}]
NONE_OF = {"op": "compare", "attr": "gem_nr", "cmp": "lt", "value": 0}
ALL_OF = {"op": "compare", "attr": "gem_nr", "cmp": "gt", "value": 0}
LARGE = {"op": "compare", "attr": "flaeche_km2", "cmp": "gt", "value": 30}


def answer_with(query: dict[str, Any], assumptions: list[dict[str, Any]]) -> QueryAnswer:
    return QueryAnswer.model_validate(
        {"kind": "query", "explanation": "Gemeinden.", "assumptions": assumptions, "query": query}
    )


@pytest.mark.parametrize(
    ("query", "assumptions", "tag", "flags"),
    [
        (
            {"source": "gemeinden", "where": NONE_OF},
            ASSUMED,
            "wrong:missing compare",
            ("zero_hits",),
        ),
        ({"source": "gemeinden", "where": ALL_OF}, [], "wrong:missing compare", ("no_assumption",)),
        (
            {"source": "schulen", "where": {"op": "in", "attr": "typ", "values": ["keine"]}},
            [],
            "wrong:source=schulen",
            ("no_assumption", "zero_hits"),
        ),
        ({"source": "gemeinden", "where": LARGE}, [], "pass", ()),
    ],
)
def test_a_require_case_flags_a_wrong_answer_by_its_hits(
    query: dict[str, Any],
    assumptions: list[dict[str, Any]],
    tag: str,
    flags: tuple[str, ...],
    sample: DataBackend,
) -> None:
    case = START["n04-grosse-gemeinden"]
    found = grade(case, answer_with(query, assumptions), None, query_of(query, "2"), sample, LIMITS)
    assert (found.verdict, found.tag, found.flags) == (tag.split(":")[0], tag, flags)


def test_a_require_case_keeps_its_verdict_when_the_hits_cannot_be_read(
    sample: DataBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The result set is read for the flags only: an engine error leaves the
    verdict, and ``zero_hits`` unset (unknown is not zero)."""

    def timed_out(*args: Any) -> list[int]:
        raise QueryTimedOut("The query took longer than 10 s and was stopped.", timeout_s=10)

    monkeypatch.setattr(grade_module, "ids_query", timed_out)
    query = {"source": "gemeinden", "where": NONE_OF}
    case = START["n04-grosse-gemeinden"]
    found = grade(case, answer_with(query, []), None, query_of(query, "2"), sample, LIMITS)
    assert (found.verdict, found.tag, found.flags) == (
        "wrong",
        "wrong:missing compare",
        ("no_assumption",),
    )


def test_silently_wrong_is_a_wrong_answer_without_an_assumption(sample: DataBackend) -> None:
    """D6: the same wrong query, once with an assumption stated, once without."""
    [item] = [i for i in ANSWERS if i["what"] == "wrong-zero-assume"]
    said = graded(item, sample)
    silent = graded(item | {"answer": item["answer"] | {"assumptions": []}}, sample)
    assert said.flags == ("zero_hits",)
    assert silent.flags == ("no_assumption", "zero_hits")
    assert said.tag == silent.tag


def test_the_offer_of_the_other_approach_is_checked_only_when_the_case_names_one(
    sample: DataBackend,
) -> None:
    case = START["h33-puffer"]
    assert case.other_approach == "chain"
    answer = CannotAnswer(kind="cannot_answer", explanation="Dafür braucht es Schritte.")
    offered = answer.model_copy(update={"other_approach": "chain"})

    def outcome(c: EvalCase, a: CannotAnswer) -> str:
        return grade(c, a, None, None, sample, LIMITS).tag

    assert outcome(case, offered) == "pass"
    assert outcome(case, answer) == "other_approach:None"
    unset = case.model_copy(update={"other_approach": None})
    assert outcome(unset, answer) == outcome(unset, offered) == "pass"
    none = case.model_copy(update={"other_approach": "none"})
    assert (outcome(none, answer), outcome(none, offered)) == ("pass", "other_approach:chain")


def test_conditions_reach_into_relations_and_distances_are_ranges() -> None:
    where = {
        "op": "and",
        "args": [
            {"op": "compare", "attr": "typ", "cmp": "eq", "value": "primar"},
            {
                "op": "near",
                "layer": "haltestellen",
                "distance_m": 300,
                "where": {"op": "not", "arg": {"op": "is_null", "attr": "name"}},
            },
        ],
    }
    assert [c["op"] for c in conditions(where)] == ["and", "compare", "near", "not", "is_null"]
    assert conditions(None) == []
    assert matches({"op": "near", "distance_m": [200, 500]}, where["args"][1])
    assert not matches({"op": "near", "distance_m": [400, 500]}, where["args"][1])
    assert not matches({"op": "near", "layer": "schulen"}, where["args"][1])


# --- the require model (B1) ----------------------------------------------------------


REQUIRES = [case for case in START.values() if case.require is not None]


@pytest.mark.parametrize("case", REQUIRES, ids=[case.id for case in REQUIRES])
@pytest.mark.parametrize("where", [None, NONE_OF, LARGE])
def test_every_require_case_of_the_start_set_grades(
    case: EvalCase, where: dict[str, Any] | None, sample: DataBackend
) -> None:
    """Whatever the query holds, a ``require`` case gives a verdict, never an exception."""
    assert case.require is not None
    query = {"source": case.require.source, "where": where}
    found = grade(case, answer_with(query, []), None, query_of(query, "2"), sample, LIMITS)
    assert found.verdict in ("pass", "wrong")


@pytest.mark.parametrize(
    "condition",
    [
        {"op": "related", "layer": "schulen", "distance_m": 300},
        {"layer": "schulen", "predicate": "dwithin"},
        {"op": "near", "layer": "schulen"},
        {"op": "compare", "attr": "typ", "erfunden": 1},
    ],
    ids=["scalar-distance", "no-op", "unknown-op", "unknown-key"],
)
def test_a_required_condition_the_grader_cannot_read_is_refused(
    condition: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError):
        Require.model_validate({"source": "schulen", "conditions": [condition]})


def test_a_require_holds_at_most_eight_conditions() -> None:
    nine = [{"op": "compare", "attr": "typ"}] * 9
    with pytest.raises(ValidationError):
        Require.model_validate({"source": "schulen", "conditions": nine})
    Require.model_validate({"source": "schulen", "conditions": nine[:8]})
