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
    *,
    readings: list[list[int]] | None,
) -> Assessment:
    """Grade ``answer`` (stage 2) and explain it (stage 1). ``query`` and
    ``refusal`` are as ``DirectAnswer`` has them; ``readings`` are the case's
    ``reading_ids``, read once per case by the caller, who treats a reading
    that cannot be read as a problem of the case (a run marks or skips it), not
    of an answer. They must be given for a case with readings, and only for
    one: a missing reading would skip the diff without a word.

    Only the grader decides the verdict: an answer query the engine cannot run
    within ``limits`` while grading is an ``error`` with the engine's code
    (``query_timeout``, ...). Reading it afterwards for the view (a ``require``
    case that passed) never changes the verdict; when that fails, hits, diff
    and reading stay ``None``."""
    golds = case.readings()
    if (readings is None) != (not golds) or (readings is not None and len(readings) != len(golds)):
        raise ValueError(f"the case '{case.id}' has {len(golds)} readings")
    try:
        graded = grade(case, answer, refusal, query, backend, limits, readings)
    except QueryError as exc:
        return unanswered(exc.code)
    if query is None:
        return _graded(graded)
    hits = graded.hits
    if hits is None:
        try:
            hits = ids_query(query, backend, limits)
        except QueryError:
            return _graded(graded)
    if not readings:  # a ``require`` case: the answer's hits only
        return _graded(graded, hits=len(hits))
    diffs = [diff(query_of(gold, case.schema_version), query) for gold in golds]

    reading = (
        readings.index(hits)
        if hits in readings
        else min(range(len(diffs)), key=lambda i: (len(diffs[i]), i))
    )
    got, want = set(hits), set(readings[reading])
    only_answer, only_reference = sorted(got - want), sorted(want - got)
    return _graded(
        graded,
        reading=reading,
        diff=diffs[reading],
        hits=len(hits),
        # The reading referred to, the nearest for a wrong answer; the
        # harness's tag (``wrong:3≠5``) counts the first reading.
        reference_hits=len(want),
        only_answer=only_answer[:MAX_IDS],
        only_answer_count=len(only_answer),
        only_reference=only_reference[:MAX_IDS],
        only_reference_count=len(only_reference),
    )


def _graded(graded: Graded, **rest: Any) -> Assessment:
    return Assessment(graded.verdict, graded.code, list(graded.flags), **rest)
