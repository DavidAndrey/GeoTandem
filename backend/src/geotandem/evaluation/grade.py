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
from dataclasses import dataclass, field, replace
from typing import Any

from geotandem.catalog import ModelProfile
from geotandem.data import DataBackend, Limits
from geotandem.engine import QueryError, ids_query
from geotandem.evaluation.schemas import EvalCase, Flag, Verdict
from geotandem.model.result import Answer
from geotandem.model.schemas import QueryAnswer, Refusal
from geotandem.model.validate import validate_model_query
from geotandem.tools import ToolContext
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
    hits: list[int] | None = field(default=None, compare=False, repr=False)
    """The answer's feature ids where grading read them, for the answer view
    (``stages.assess``); not part of the outcome."""


PASS = Graded("pass", "pass")


def errored(code: str) -> Graded:
    """An answer that never came or did not read: the call's or the parser's
    code (``llm_timeout``, ``model_unreadable``, ...). The harness and a run
    find it, the grader has no answer to look at."""
    return Graded("error", f"error:{code}", code)


class ReadingRefused(Exception):
    """A reading of a case fails the checks of a model's query: the case's
    problem, not an answer's."""

    def __init__(self, index: int, refusal: Refusal) -> None:
        super().__init__(f"reading {index}: {refusal.code}")
        self.index = index
        self.refusal = refusal


def reading_ids(
    case: EvalCase, context: ToolContext, profile: ModelProfile
) -> list[list[int]] | None:
    """The feature ids of the reference or each fair reading, in order, each
    checked as a model's query first (``check_reading``); ``None`` for a case
    without readings. ``ReadingRefused`` or a ``QueryError`` here is the case's
    problem, not an answer's: a run marks or skips the case."""
    found = []
    for index, doc in enumerate(case.readings()):
        query = check_reading(doc, case.schema_version, context, profile)
        if isinstance(query, Refusal):
            raise ReadingRefused(index, query)
        found.append(ids_query(query, context.backend, context.limits, context.unsupported))
    return found or None


def query_of(doc: dict[str, Any], schema_version: str) -> QueryObject:
    """A reference query as a case stores it, without ``schema_version`` and
    ``output``, as a query object: as the case states it, unchecked (the diff
    addresses its nodes so)."""
    return QueryObject.model_validate(_document(doc, schema_version))


def check_reading(
    doc: dict[str, Any], schema_version: str, context: ToolContext, profile: ModelProfile
) -> QueryObject | Refusal:
    """A reference as a case stores it, checked as a model's query in the world
    of ``profile`` (``validate_model_query``): the one way from a reference to
    the query that runs, for the checks of a case and for a run."""
    found = validate_model_query(_document(doc, schema_version), context, profile)
    return found if isinstance(found, Refusal) else found.query


def _document(doc: dict[str, Any], schema_version: str) -> dict[str, Any]:
    return {"schema_version": schema_version, "output": "map", **doc}


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
    readings: list[list[int]] | None = None,
) -> Graded:
    """``pass``, or the first thing that went wrong. ``query`` is the checked
    query of a query answer, ``refusal`` the application's refusal of it; the
    result sets are read from ``backend`` within ``limits``. ``readings`` are
    the feature ids of the reference or each fair reading when the caller has
    them already (``reading_ids``, a run reads them once per case); without
    them they are read here, unchecked."""
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
    if golds := case.readings():
        # More than one fair reading with different features: any one passes.
        got = ids_query(query, backend, limits)
        if readings is None:
            readings = [
                ids_query(query_of(gold, case.schema_version), backend, limits) for gold in golds
            ]
        assert len(readings) == len(golds)
        if got in readings:
            return replace(PASS, hits=got)
        return _wrong(f"wrong:{len(got)}≠{len(readings[0])}", answer, got)
    assert case.require is not None
    need = case.require
    wrong = None
    if query.source != need.source:
        wrong = f"wrong:source={query.source}"
    else:
        present = conditions(query.model_dump(mode="json", exclude_none=True).get("where"))
        for want_condition in need.conditions:
            keys = want_condition.model_dump(exclude_none=True)
            if not any(matches(keys, c) for c in present):
                wrong = f"wrong:missing {want_condition.op}"
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
    return Graded("wrong", tag, flags=tuple(flags), hits=hits)
