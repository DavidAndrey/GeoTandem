"""The three stages of bewertung.md 4 for one answer (plan E3, D5, D6).

Stage 0 *formgültig* is what the answer went through before it gets here: it
read (``parse_answer``) and its query passed the application's checks
(``validate_model_query``), as ``DirectQuery.ask`` does it; an answer that did
not read is ``unanswered``, a refused query reaches ``assess`` with its
refusal. Stage 2 *ergebnisgleich* is the shared grader: its verdict is the
verdict. Stage 1 *abfragegleich* is the diff (``evaluation/diff.py``), shown
beside the verdict and never one of its own; a refused query ended at stage 0
and gets none.

``Assessment`` holds exactly the grading fields of ``AnswerView``; a run adds
what it measured (case, point, seed, latency, tokens, the answer itself). The
result sets are feature ids, never rows (D8).
"""

from dataclasses import dataclass, field, fields
from typing import Any

from geotandem.data import DataBackend, Limits
from geotandem.engine import QueryError, ids_query
from geotandem.evaluation.diff import diff
from geotandem.evaluation.grade import Graded, errored, grade, query_of
from geotandem.evaluation.schemas import MAX_IDS, DiffEntry, EvalCase, Flag, Verdict
from geotandem.model.result import Answer
from geotandem.model.schemas import Refusal
from geotandem_query import QueryObject


@dataclass(frozen=True)
class Assessment:
    """The grading fields of ``AnswerView``, by the same names."""

    verdict: Verdict
    code: str | None = None
    flags: list[Flag] = field(default_factory=list)
    reading: int | None = None
    """The reading passed, else the nearest: the fewest diff entries, ties to
    the first; ``None`` without readings or without a query."""
    diff: list[DiffEntry] | None = None
    hits: int | None = None
    reference_hits: int | None = None
    only_answer: list[int] = field(default_factory=list)
    only_answer_count: int = 0
    only_reference: list[int] = field(default_factory=list)
    only_reference_count: int = 0

    def view_fields(self) -> dict[str, Any]:
        """As keyword arguments of ``AnswerView``."""
        return {f.name: getattr(self, f.name) for f in fields(self)}


def unanswered(code: str) -> Assessment:
    """An answer that never came or did not read (stage 0): the call's or the
    parser's code."""
    return _graded(errored(code))


def assess(
    case: EvalCase,
    answer: Answer,
    refusal: Refusal | None,
    query: QueryObject | None,
    backend: DataBackend,
    limits: Limits,
) -> Assessment:
    """Grade ``answer`` (stage 2) and explain it (stage 1). ``query`` and
    ``refusal`` are as ``DirectAnswer`` has them. A query the engine cannot run
    within ``limits``, the answer's or a reading's, is an ``error`` with the
    engine's code (``query_timeout``, ...)."""
    try:
        graded = grade(case, answer, refusal, query, backend, limits)
        if query is None:
            return _graded(graded)
        hits = ids_query(query, backend, limits)
        readings = case.gold_any or ([case.gold] if case.gold else [])
        if not readings:  # a ``require`` case: the answer's hits only
            return _graded(graded, hits=len(hits))
        wants = [ids_query(query_of(r), backend, limits) for r in readings]
    except QueryError as exc:
        return unanswered(exc.code)
    diffs = [diff(query_of(r), query) for r in readings]
    reading = (
        wants.index(hits)
        if hits in wants
        else min(range(len(diffs)), key=lambda i: (len(diffs[i]), i))
    )
    got, want = set(hits), set(wants[reading])
    only_answer, only_reference = sorted(got - want), sorted(want - got)
    return _graded(
        graded,
        reading=reading,
        diff=diffs[reading],
        hits=len(hits),
        reference_hits=len(want),
        only_answer=only_answer[:MAX_IDS],
        only_answer_count=len(only_answer),
        only_reference=only_reference[:MAX_IDS],
        only_reference_count=len(only_reference),
    )


def _graded(graded: Graded, **rest: Any) -> Assessment:
    return Assessment(graded.verdict, graded.code, list(graded.flags), **rest)
