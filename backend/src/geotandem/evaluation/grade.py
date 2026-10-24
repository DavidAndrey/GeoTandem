"""The grader of an answer against its case (plan E3, D5, D6; ``GRADING_VERSION``).

Stage 2 of bewertung.md 4: a query answer passes when the features it selects
equal those of the reference query, or of any one of its fair readings
(``gold_any``), on the same data; where readings differ too much for that, it
passes when it holds the required parts (``require``). A behaviour case
(``expect``) passes on the expected answer kind, or a further one it accepts
(``also``). Every check is deterministic: no judge model (bewertung.md 11).

The harness (``backend/evals``) and the application's runs grade with this one
function, so a verdict means the same in both. ``Graded.tag`` is the short
string the harness writes and the testplans quote (``pass``, ``wrong:3≠5``,
``refused:not_representable``, ...); verdict, code and flags are the same
outcome in the contract's words.
"""

import json
from dataclasses import dataclass
from typing import Any

from geotandem.data import DataBackend, Limits
from geotandem.engine import QueryError, ids_query
from geotandem.evaluation.schemas import EvalCase, Flag, Verdict
from geotandem.model.result import Answer
from geotandem.model.schemas import QueryAnswer, Refusal
from geotandem_query import QueryObject


@dataclass(frozen=True)
class Graded:
    """What became of one answer (D6)."""

    verdict: Verdict
    tag: str
    """The harness's string: the verdict, and after a colon what went wrong."""
    code: str | None = None
    """For ``refused`` and ``error``: the code; for ``kind``: the kind given."""
    flags: tuple[Flag, ...] = ()
    """Only on ``wrong``: ``no_assumption``, ``zero_hits``, in that order."""


PASS = Graded("pass", "pass")


def errored(code: str) -> Graded:
    """An answer that never came or did not read: the call's or the parser's
    code (``llm_timeout``, ``model_unreadable``, ...). The harness and a run
    find it, the grader has no answer to look at."""
    return Graded("error", f"error:{code}", code)


def query_of(doc: dict[str, Any]) -> QueryObject:
    """A reference query as a case stores it, without ``schema_version`` and
    ``output``, as a query object."""
    return QueryObject.model_validate({"schema_version": "2", "output": "map", **doc})


def conditions(node: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Every condition of a where tree, a relation's own filter included."""
    if not node:
        return []
    found = [node]
    for child in [*node.get("args", []), node.get("arg"), node.get("where")]:
        found += conditions(child)
    return found


def matches(want: dict[str, Any], got: dict[str, Any]) -> bool:
    """``got`` has every key of ``want`` with its value; ``distance_m`` is a
    ``[low, high]`` range."""
    for key, value in want.items():
        if key == "distance_m":
            low, high = value
            if not low <= (got.get(key) or 0) <= high:
                return False
        elif got.get(key) != value:
            return False
    return True


def grade(
    case: EvalCase,
    answer: Answer,
    refusal: Refusal | None,
    query: QueryObject | None,
    backend: DataBackend,
    limits: Limits,
) -> Graded:
    """``pass``, or the first thing that went wrong. ``query`` is the checked
    query of a query answer, ``refusal`` the application's refusal of it; the
    result sets are read from ``backend`` within ``limits``."""
    said = json.dumps(answer.model_dump(mode="json"), ensure_ascii=False).casefold()
    for word in case.forbid:
        if word.casefold() in said:
            return Graded("forbidden", f"forbidden:{word}")
    if answer.kind in case.also:
        return PASS
    if case.expect is not None:
        if answer.kind != case.expect:
            return Graded("kind", f"kind:{answer.kind}", answer.kind)
        # "none": the answer must not offer the other approach; unset: not checked.
        want = case.other_approach
        offered = getattr(answer, "other_approach", None)
        if want is not None and offered != (None if want == "none" else want):
            return Graded("other_approach", f"other_approach:{offered}")
        return PASS
    if not isinstance(answer, QueryAnswer):
        return Graded("kind", f"kind:{answer.kind}", answer.kind)
    if refusal is not None:
        return Graded("refused", f"refused:{refusal.code}", refusal.code)
    assert query is not None
    if case.gold or case.gold_any:
        # More than one fair reading with different features: any one passes.
        if case.gold_any:
            golds = case.gold_any
        else:
            assert case.gold is not None
            golds = [case.gold]
        got = ids_query(query, backend, limits)
        wants = [ids_query(query_of(gold), backend, limits) for gold in golds]
        if got in wants:
            return PASS
        return _wrong(f"wrong:{len(got)}≠{len(wants[0])}", answer, got)
    assert case.require is not None
    need = case.require
    wrong = None
    if query.source != need.source:
        wrong = f"wrong:source={query.source}"
    else:
        present = conditions(query.model_dump(mode="json", exclude_none=True).get("where"))
        for want_condition in need.conditions:
            if not any(matches(want_condition, c) for c in present):
                wrong = f"wrong:missing {want_condition['op']}"
                break
    if wrong is None:
        return PASS
    # Only for the flags (D6): the harness keeps the tag and discards them, a run
    # stores them; this branch needs no result set for its verdict.
    try:
        hits: list[int] | None = ids_query(query, backend, limits)
    except QueryError:  # the verdict stands; only the flag is unknown
        hits = None
    return _wrong(wrong, answer, hits)


def _wrong(tag: str, answer: QueryAnswer, hits: list[int] | None) -> Graded:
    """A ``wrong`` verdict with its flags (D6); ``hits`` are the answer's
    features, ``None`` when they could not be read."""
    flags: list[Flag] = []
    if not answer.assumptions:
        flags.append("no_assumption")
    if hits == []:
        flags.append("zero_hits")
    return Graded("wrong", tag, flags=tuple(flags))
