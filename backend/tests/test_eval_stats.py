"""The paired statistics of two runs (plan E3, D7; ``evaluation/stats.py``).

The units by hand; the testplans' numbers from their result files, where this
checkout has them: ``backend/evals/results/`` is git-ignored, so a fresh clone
skips those tests and says why.
"""

import json
from pathlib import Path

import pytest

from geotandem.evaluation.stats import bootstrap, compare, sign_test, tally, word

RESULTS = Path(__file__).parents[1] / "evals" / "results"


def test_the_sign_test_is_two_sided_and_leaves_ties_out() -> None:
    assert sign_test(0, 0) == 1.0
    assert sign_test(5, 0) == sign_test(0, 5) == 2 / 32
    assert sign_test(8, 2) == 2 * (1 + 10 + 45) / 1024
    assert sign_test(3, 3) == 1.0  # capped


def test_the_bootstrap_is_the_same_for_the_same_seed() -> None:
    diffs = [0.0, 20.0, -10.0, 40.0, 0.0, 10.0, -20.0, 30.0]
    first = bootstrap(diffs)
    assert bootstrap(diffs) == first
    assert bootstrap(list(diffs), seed=1) == first == (-3.75, 22.5)
    assert bootstrap(diffs, rounds=40, seed=1) != bootstrap(diffs, rounds=40, seed=3)
    low, high = first
    assert low < sum(diffs) / len(diffs) < high
    assert bootstrap([5.0] * 4) == (5.0, 5.0)


def test_the_word_follows_the_interval() -> None:
    assert word(0.1, 5.0) == "better"
    assert word(-5.0, -0.1) == "worse"
    assert word(-1.0, 1.0) == "not_proven"
    assert word(0.0, 1.5) == "not_proven"  # Haiku in 8.4: +0,0 … +1,5


def test_a_comparison_pairs_the_cases_both_ran() -> None:
    base = tally([("a", "pass"), ("a", "wrong:1≠2"), ("b", "pass"), ("c", "kind:query")])
    assert base == {"a": (1, 2), "b": (1, 1), "c": (0, 1)}
    other = {"a": (2, 2), "b": (0, 1), "d": (1, 1)}
    found = compare(base, other)
    assert (found.cases, found.better, found.worse, found.same) == (2, 1, 1, 0)
    assert found.mean == (50 - 100) / 2
    assert found.p_sign == 1.0 and found.word == "not_proven"
    assert compare(base, {}).cases == 0 and compare(base, {}).word == "not_proven"


# --- the testplans' numbers ------------------------------------------------------------


def newest(label: str) -> Path:
    """As ``evals/compare.py`` takes a label: its newest result file."""
    files = sorted(
        path
        for path in RESULTS.glob(f"*-{label}.jsonl")
        if path.name.split("-", 2)[2] == f"{label}.jsonl"
    )
    if not files:
        pytest.skip(f"no result file of {label!r} in {RESULTS} (git-ignored, see evals/README.md)")
    return files[-1]


def passes(column: str) -> dict[str, tuple[int, int]]:
    """A column of ``compare.py``: the runs of ``a+b`` joined."""
    verdicts = []
    for label in column.split("+"):
        lines = newest(label).read_text("utf-8").splitlines()[1:]
        verdicts += [(r["case"], r["verdict"]) for r in map(json.loads, lines)]
    return tally(verdicts)


def total(found: dict[str, tuple[int, int]]) -> int:
    return sum(n[0] for n in found.values())


@pytest.mark.parametrize(
    ("base", "other", "sums", "mean", "low", "high"),
    [
        # 8.4, gemma4:12b, tuning: 272 → 279, +2,1 (-2,1 … +7,9)
        (
            "p0-gemma4_12b+p0-gemma4_12b-s6",
            "p9-gemma4_12b+p9-gemma4_12b-s6",
            (272, 279),
            2.1,
            -2.1,
            7.9,
        ),
        # 8.4, Luna, held-out: 336 → 361, +6,6 (+1,3 … +13,2)
        ("ho-luna+ho-luna-s6", "p9ho-luna+p9ho-luna-s6", (336, 361), 6.6, 1.3, 13.2),
        # 8.5, gemma4:12b: P0 272, no-domains 189 (paired -25), raw 142 (-39), raw-codes 212
        (
            "p0-gemma4_12b+p0-gemma4_12b-s6",
            "a-no-domains-gemma4_12b+a-no-domains-gemma4_12b-s6",
            (272, 189),
            -25.2,
            -41.5,
            -9.1,
        ),
        (
            "p0-gemma4_12b+p0-gemma4_12b-s6",
            "a-raw-gemma4_12b+a-raw-gemma4_12b-s6",
            (272, 142),
            -39.4,
            -57.6,
            -21.2,
        ),
        # 8.5, raw-codes against P0: Haiku -2,7, Luna -5,5, both intervals with 0
        (
            "x-p0-haiku+x-p0-haiku-s6",
            "a-raw-codes-haiku+a-raw-codes-haiku-s6",
            (318, 309),
            -2.7,
            -8.2,
            0.6,
        ),
        (
            "x-p0-luna+x-p0-luna-s6",
            "a-raw-codes-luna+a-raw-codes-luna-s6",
            (280, 262),
            -5.5,
            -13.0,
            0.6,
        ),
    ],
)
def test_the_numbers_of_phases_3_and_4(
    base: str, other: str, sums: tuple[int, int], mean: float, low: float, high: float
) -> None:
    """testplan-system-context 8.4 and 8.5, as ``compare.py --stats`` printed
    them from the newest file of each label. A later ``regrade.py`` of a Phase 4
    label changes them: it checks the answers in the full profile, not the
    stripped one the run asked with."""
    a, b = passes(base), passes(other)
    assert (total(a), total(b)) == sums
    found = compare(a, b)
    assert (round(found.mean, 1), round(found.low, 1), round(found.high, 1)) == (mean, low, high)
