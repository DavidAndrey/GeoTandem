"""The shared grader (plan E3, D5, D6; ``evaluation/grade.py``) against recorded answers.

``eval_answers.json`` holds answers real models gave in the testplans, one per
kind of outcome, with the tag the harness wrote for them. Each is read, checked
and graded as ``evals/regrade.py`` does it, over the sample data: the tag must
come out as recorded, with the contract's verdict, code and flags beside it.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from geotandem.catalog import model_profile
from geotandem.data import DataBackend, Limits
from geotandem.evaluation.grade import Graded, conditions, errored, grade, matches
from geotandem.evaluation.schemas import EvalCase
from geotandem.llm import Completion
from geotandem.model.errors import ActionError
from geotandem.model.result import parse_answer
from geotandem.model.schemas import CannotAnswer, QueryAnswer
from geotandem.model.validate import Validated, validate_model_query
from geotandem.tools import ToolContext

HERE = Path(__file__).parent
CASES = HERE.parents[1] / "schema" / "eval-cases"
LIMITS = Limits(max_features=10_000, timeout_s=10)
ANSWERS: list[dict[str, Any]] = json.loads((HERE / "eval_answers.json").read_text("utf-8"))[
    "answers"
]


def start_set() -> dict[str, EvalCase]:
    found = {}
    for name in ("start-tuning", "start-confirm"):
        for case in json.loads((CASES / f"{name}.json").read_text("utf-8"))["cases"]:
            found[case["id"]] = EvalCase.model_validate(case)
    return found


START = start_set()


def graded(item: dict[str, Any], backend: DataBackend) -> Graded:
    """As ``evals/regrade.py``: the answer read again, a query checked in the
    sample's profile, then graded; an answer that does not read stays an error."""
    text = json.dumps(item["answer"]) if "answer" in item else item.get("raw")
    try:
        answer = parse_answer(Completion(text=text), "direct") if text else None
    except ActionError:
        answer = None
    if answer is None:
        return errored(item["tag"].removeprefix("error:"))
    query = refusal = None
    if isinstance(answer, QueryAnswer):
        profile = model_profile(backend.engine, backend.layer_names())
        context = ToolContext(backend=backend, limits=LIMITS)
        checked = validate_model_query(answer.query, context, profile)
        if isinstance(checked, Validated):
            query = checked.query
        else:
            refusal = checked
    return grade(START[item["case"]], answer, refusal, query, backend, LIMITS)


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


def test_the_tag_begins_with_the_verdict_and_carries_the_code() -> None:
    for item in ANSWERS:
        assert item["tag"].split(":")[0] == item["verdict"]
        if item["code"] is not None:
            assert item["tag"] == f"{item['verdict']}:{item['code']}"


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
