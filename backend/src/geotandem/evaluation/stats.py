"""Paired statistics of two runs over the same cases (plan E3, D7).

The repeats of one case are not independent, so the sample is the cases, not
the answers: per case the pass rate of each run, and of each shared case the
difference in percentage points. Over those differences a sign test (wins
against losses, ties left out) and a 95 % bootstrap interval of the mean, cases
drawn with replacement under a fixed seed, so the same runs give the same
interval. The words follow the interval: above 0 *besser*, below *schlechter*,
containing it *nicht belegt*. ``evals/compare.py --stats`` prints these
figures; the testplans quote them.
"""

import math
import random
from collections import defaultdict
from collections.abc import Iterable, Mapping

from geotandem.evaluation.schemas import PointComparison, Word

ROUNDS = 10_000
SEED = 1

Passes = Mapping[str, tuple[int, int]]
"""Case id → (answers passed, answers) of one run, in the order of its cases."""


def tally(verdicts: Iterable[tuple[str, str]]) -> dict[str, tuple[int, int]]:
    """``Passes`` of ``(case id, verdict tag)`` pairs, in the order the cases come."""
    counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for case, verdict in verdicts:
        counts[case][0] += verdict == "pass"
        counts[case][1] += 1
    return {case: (n[0], n[1]) for case, n in counts.items()}


def sign_test(wins: int, losses: int) -> float:
    """Two-sided p of ``wins`` against ``losses`` under 50:50; ties left out."""
    n = wins + losses
    if n == 0:
        return 1.0
    tail: float = sum(math.comb(n, k) for k in range(min(wins, losses) + 1)) / 2**n
    return min(1.0, 2 * tail)


def bootstrap(diffs: list[float], rounds: int = ROUNDS, seed: int = SEED) -> tuple[float, float]:
    """95 % interval of the mean difference, cases drawn with replacement."""
    draw = random.Random(seed)
    means = sorted(sum(draw.choices(diffs, k=len(diffs))) / len(diffs) for _ in range(rounds))
    return means[int(0.025 * rounds)], means[int(0.975 * rounds) - 1]


def word(low: float, high: float) -> Word:
    """The comparison word of an interval (D7)."""
    if low > 0:
        return "better"
    if high < 0:
        return "worse"
    return "not_proven"


def compare(base: Passes, other: Passes) -> PointComparison:
    """``other`` against ``base``, paired over the cases both ran (in the order
    of ``base``, which the bootstrap's draws depend on)."""
    shared = [c for c in base if c in other]
    diffs = [100 * (other[c][0] / other[c][1] - base[c][0] / base[c][1]) for c in shared]
    wins = sum(d > 0 for d in diffs)
    losses = sum(d < 0 for d in diffs)
    low, high = bootstrap(diffs) if diffs else (0.0, 0.0)
    return PointComparison(
        cases=len(shared),
        better=wins,
        worse=losses,
        same=len(diffs) - wins - losses,
        mean=sum(diffs) / len(diffs) if diffs else 0.0,
        low=low,
        high=high,
        p_sign=sign_test(wins, losses),
        word=word(low, high),
    )
