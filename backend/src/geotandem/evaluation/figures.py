"""The figures of a run (plan E3, section 2, D6, D7): per measuring point the
counts of its answers, per case and point a cell of the matrix, and each
point against the reference point.

Counts are answers: a case counts once per repeat. Rates are percentages with
one decimal, as the matrix shows them. The comparison is paired per case
(``stats.compare``) and taken on the ``confirm`` cases only, and only for a
full run (design review 1, D7, O2): a quick test, or a run without
confirmation cases, has none. Nothing here reads the database or sees a row
of the data: the inputs are verdicts, flags, latencies and tokens.
"""

import math
import statistics
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final

from geotandem.connections import Price
from geotandem.evaluation.schemas import (
    Cell,
    EvalCase,
    Flag,
    Money,
    PointComparison,
    PointFigures,
    RunScope,
    Split,
    Tally,
    Verdict,
)
from geotandem.evaluation.stats import Passes, compare

LIMITED: Final = frozenset({"llm_timeout", "limit_exceeded", "query_timeout", "result_too_large"})
"""Codes of an answer that ran into a limit: the call's time, a query limit of
the model path, the engine's time or result size (section 2)."""
UNREADABLE: Final = frozenset({"model_unreadable", "model_truncated"})
"""Codes of an answer that did not read (stage 0)."""


@dataclass(frozen=True)
class Scored:
    """What the figures need of one answer."""

    case_id: str
    point: int
    verdict: Verdict
    code: str | None = None
    flags: tuple[Flag, ...] = ()
    latency_ms: int | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None

    @property
    def silently_wrong(self) -> bool:
        """*still falsch* (D6): wrong, and the answer states no assumption."""
        return self.verdict == "wrong" and "no_assumption" in self.flags


def rate(tally: Tally) -> float | None:
    """Passed of answers in percent, one decimal; ``None`` without answers."""
    if tally.answers == 0:
        return None
    return round(100 * tally.passed / tally.answers, 1)


def percentile(values: Sequence[int], share: float) -> int | None:
    """The nearest-rank percentile; ``None`` without values."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(share * len(ordered)) - 1)]


def cost(price: Price | None, prompt_tokens: int, completion_tokens: int) -> Money | None:
    """The money of the tokens at ``price``; ``None`` without one (O4)."""
    if price is None:
        return None
    amount = (
        prompt_tokens * price.input_per_million + completion_tokens * price.output_per_million
    ) / 1_000_000
    return Money(amount=round(amount, 4), currency=price.currency)


def by_currency(amounts: Iterable[Money | None]) -> list[Money]:
    """Amounts summed per currency, in the order the currencies come."""
    sums: dict[str, float] = {}
    for money in amounts:
        if money is not None:
            sums[money.currency] = sums.get(money.currency, 0.0) + money.amount
    return [Money(amount=round(a, 4), currency=c) for c, a in sums.items()]


@dataclass
class _Count:
    passed: int = 0
    answers: int = 0

    def add(self, passed: bool) -> None:
        self.passed += passed
        self.answers += 1

    @property
    def tally(self) -> Tally:
        return Tally(passed=self.passed, answers=self.answers)


@dataclass
class _Figures:
    total: _Count = field(default_factory=_Count)
    splits: dict[Split, _Count] = field(default_factory=lambda: defaultdict(_Count))
    tags: dict[str, _Count] = field(default_factory=lambda: defaultdict(_Count))
    behaviour: _Count = field(default_factory=_Count)
    errors: Counter[str] = field(default_factory=Counter)
    silently_wrong: int = 0
    zero_hits: int = 0
    unreadable: int = 0
    limited: int = 0
    latencies: list[int] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0


def point_figures(
    cases: Mapping[str, EvalCase], answers: Iterable[Scored], price: Price | None
) -> PointFigures:
    """Section 2 of the plan for the answers of one measuring point."""
    f = _Figures()
    for a in answers:
        case = cases[a.case_id]
        passed = a.verdict == "pass"
        f.total.add(passed)
        f.splits[case.split].add(passed)
        for tag in case.tags:
            f.tags[tag].add(passed)
        if case.expect is not None:
            f.behaviour.add(passed)
        if a.verdict in ("error", "refused") and a.code is not None:
            f.errors[a.code] += 1
        f.silently_wrong += a.silently_wrong
        f.zero_hits += a.verdict == "wrong" and "zero_hits" in a.flags
        f.unreadable += a.verdict == "error" and a.code in UNREADABLE
        f.limited += a.code in LIMITED
        if a.latency_ms is not None:
            f.latencies.append(a.latency_ms)
        f.prompt_tokens += a.prompt_tokens or 0
        f.completion_tokens += a.completion_tokens or 0
    by_split = {split: count.tally for split, count in sorted(f.splits.items())}
    return PointFigures(
        passed=f.total.passed,
        answers=f.total.answers,
        by_split=by_split,
        by_tag={tag: count.tally for tag, count in sorted(f.tags.items())},
        rate_tuning=rate(by_split["tuning"]) if "tuning" in by_split else None,
        rate_confirm=rate(by_split["confirm"]) if "confirm" in by_split else None,
        silently_wrong=f.silently_wrong,
        zero_hits=f.zero_hits,
        unreadable=f.unreadable,
        errors=dict(sorted(f.errors.items())),
        behaviour_met=f.behaviour.passed,
        behaviour_answers=f.behaviour.answers,
        limited=f.limited,
        latency_median_ms=round(statistics.median(f.latencies)) if f.latencies else None,
        latency_p90_ms=percentile(f.latencies, 0.9),
        prompt_tokens=f.prompt_tokens,
        completion_tokens=f.completion_tokens,
        cost=cost(price, f.prompt_tokens, f.completion_tokens),
    )


def passes(answers: Iterable[Scored], case_ids: Sequence[str]) -> Passes:
    """Per case of ``case_ids`` with answers: (passed, answers), in that order."""
    counts: dict[str, _Count] = defaultdict(_Count)
    for a in answers:
        counts[a.case_id].add(a.verdict == "pass")
    return {c: (counts[c].passed, counts[c].answers) for c in case_ids if counts[c].answers}


def confirm_ids(cases: Iterable[EvalCase]) -> list[str]:
    """The cases the comparison words are taken on (design review 1)."""
    return [case.id for case in cases if case.split == "confirm"]


def comparisons(
    cases: Sequence[EvalCase],
    by_point: Mapping[int, Sequence[Scored]],
    points: int,
    reference: int,
    scope: RunScope,
) -> list[PointComparison | None]:
    """Each point against the reference point on the ``confirm`` cases (D7);
    ``None`` for the reference itself, in a quick test, and without
    confirmation cases."""
    ids = confirm_ids(cases)
    if scope != "full" or not ids:
        return [None] * points
    base = passes(by_point.get(reference, ()), ids)
    found: list[PointComparison | None] = []
    for point in range(points):
        other = passes(by_point.get(point, ()), ids)
        found.append(None if point == reference or not base or not other else compare(base, other))
    return found


def cells(answers: Iterable[Scored], order: Sequence[str]) -> list[Cell]:
    """One cell per case and point with answers, in the order of the cases,
    then of the points."""
    found: dict[tuple[str, int], tuple[Counter[Verdict], list[int]]] = {}
    for a in answers:
        verdicts, silently = found.setdefault((a.case_id, a.point), (Counter(), [0]))
        verdicts[a.verdict] += 1
        silently[0] += a.silently_wrong
    rank = {case_id: i for i, case_id in enumerate(order)}
    keys = sorted(found, key=lambda k: (rank.get(k[0], len(rank)), k[1]))
    return [
        Cell(
            case_id=case_id,
            point=point,
            passed=found[case_id, point][0]["pass"],
            answers=sum(found[case_id, point][0].values()),
            verdicts=dict(found[case_id, point][0]),
            silently_wrong=found[case_id, point][1][0],
        )
        for case_id, point in keys
    ]
