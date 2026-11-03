"""The figures of rule 6.6 (docs/plan-improve-examples.md) for one group of
bench.py, from the newest result file of each of its chunks.

    uv run python evals/decide.py check-gemma4_12b

Per arm the answers of all three files and both seed blocks together; each
figure is paired per case (``stats.compare``): rates, the mean difference in
points and its 95 % interval. Then, for a check, the marks per arm, and the
behaviour cases one by one (where point 3 is decided).

Point 3 takes the behaviour cases of the three files and of the behaviour
stage (``behaviour-cases.json``, 6.7) together, A against C, and holds by
6.7: the mean at least -5 points, and no case whose share of answers of the
right kind (not ``kind:*``, not ``error:*``) falls by more than 50 points.
"""

import argparse
import json
from collections import Counter
from collections.abc import Callable, Collection
from typing import Any, Final

from bench import chunks, newest
from pool import ARMS

from geotandem.evaluation.cases import behaviour_set, chain_set, layer_set, start_set
from geotandem.evaluation.signature import group
from geotandem.evaluation.stats import compare

Record = dict[str, Any]
Test = Callable[[Record], bool]


def passed(r: Record) -> bool:
    return bool(r["verdict"] == "pass")


def unmarked(r: Record) -> bool:
    return bool((r.get("check") or {}).get("state") != "differs")


def right_kind(r: Record) -> bool:
    """Asked back or declined as expected, whatever the offer (6.7)."""
    return not r["verdict"].startswith(("kind:", "error:"))


MARGIN: Final = -5.0
"""Point 3: the mean C - A at least this (points)."""
DROP: Final = 50.0
"""Point 3: no behaviour case loses more than this in answers of the right kind."""


def silent(r: Record) -> bool:
    wrong = r["verdict"].startswith("wrong") and "no_assumption" in r.get("flags", [])
    return bool(wrong and unmarked(r))


def rates(
    records: list[Record], test: Test, only: Collection[str] | None
) -> dict[str, tuple[int, int]]:
    found: dict[str, list[int]] = {}
    for r in records:
        if only is None or r["case"] in only:
            n = found.setdefault(r["case"], [0, 0])
            n[0] += test(r)
            n[1] += 1
    return {c: (a, b) for c, (a, b) in found.items()}


def rate(counts: dict[str, tuple[int, int]]) -> float:
    return 100 * sum(a for a, _ in counts.values()) / sum(b for _, b in counts.values())


Arms = dict[str, list[Record]]


def load(key: str) -> tuple[Arms, Arms, list[str]]:
    """The answers of group ``key`` per arm: of the three files, of the
    behaviour stage, and the labels of the chunks without a result."""
    found: dict[str, Arms] = {
        stage: {arm: [] for arm in ARMS} for stage in ("examples", "behaviour")
    }
    missing = []
    for chunk in chunks():
        if chunk.group.key != key:
            continue
        path = newest(chunk.label)
        if path is None:
            missing.append(chunk.label)
            continue
        lines = path.read_text("utf-8").splitlines()[1:]
        found[chunk.stage][chunk.arm] += [json.loads(line) for line in lines]
    return found["examples"], found["behaviour"], missing


def figure(
    name: str,
    base: list[Record],
    other: list[Record],
    arms: str,
    test: Test,
    only: Collection[str] | None,
) -> float | None:
    """One row of the table; the mean difference, or None without answers."""
    a, b = rates(base, test, only), rates(other, test, only)
    if not a or not b:
        print(f"| {name} | {arms} | - | - | - |")
        return None
    p = compare(a, b)
    print(
        f"| {name} | {arms} | {rate(a):.1f} → {rate(b):.1f} % "
        f"| {p.mean:+.1f} ({p.low:+.1f} … {p.high:+.1f}) | {p.cases} |"
    )
    return p.mean


def marks(records: Arms) -> None:
    """For a check: the marks per arm (rule 6)."""
    print("\n| Arm | Answers | Correct | Marked of correct (≤ 10 %) | Wrong left unmarked |")
    print("|---|---|---|---|---|")
    for arm, rs in records.items():
        ok = [r for r in rs if passed(r) and "check" in r]
        marked = sum(not unmarked(r) for r in ok)
        wrong = [r for r in rs if r["verdict"].startswith("wrong")]
        share = f"{100 * marked / len(ok):.1f} %" if ok else "-"
        left = f"{sum(unmarked(r) for r in wrong)} of {len(wrong)}"
        print(f"| {arm.upper()} | {len(rs)} | {len(ok)} | {marked} = {share} | {left} |")


def share(rs: list[Record], test: Test) -> float:
    return 100 * sum(map(test, rs)) / len(rs)


def cases(both: Arms, behaviour: set[str], every: dict[str, Any]) -> list[str]:
    """The behaviour cases one by one; those that lose more than ``DROP`` points
    of answers of the right kind from A to C."""
    print("\nBehaviour cases: passes per arm, C's other verdicts, right kind A → C:")
    dropped = []
    for case in sorted(behaviour):
        rows = {arm: [r for r in rs if r["case"] == case] for arm, rs in both.items()}
        if not rows["a"] or not rows["c"]:
            continue
        counts = " ".join(
            f"{arm.upper()} {sum(map(passed, rs))}/{len(rs)}" for arm, rs in rows.items() if rs
        )
        rest = Counter(r["verdict"] for r in rows["c"] if not passed(r))
        kind_a, kind_c = share(rows["a"], right_kind), share(rows["c"], right_kind)
        flag = "  ← drop" if kind_a - kind_c > DROP else ""
        if flag:
            dropped.append(case)
        print(
            f"  {case:32} {every[case].expect:14} {counts}  {dict(rest) or ''}"
            f"  kind {kind_a:.0f} → {kind_c:.0f} %{flag}"
        )
    return dropped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("group", help="e.g. check-gemma4_12b")
    key = parser.parse_args().group

    every = {c.id: c for c in (*start_set(), *chain_set(), *layer_set(), *behaviour_set())}
    pool = [c for c in every.values() if c.split == "tuning"]
    records, extra, missing = load(key)
    if not any(records.values()):
        parser.error(f"no results for {key!r}")
    if missing:
        print(f"missing {len(missing)} chunks: {', '.join(missing)}\n")
    both: Arms = {arm: records[arm] + extra[arm] for arm in ARMS}

    behaviour = {c for c, k in every.items() if k.expect is not None}
    group4 = {c for c, k in every.items() if k.split == "confirm" and group(k, pool) == 4}
    print("| Figure | Arms | Rate | Δ points (95 %) | Cases |\n|---|---|---|---|---|")
    figure("1 pass", records["a"], records["c"], "C - A", passed, None)
    figure("2 silent wrongs", records["a"], records["c"], "C - A", silent, None)
    mean = figure("3 asking/declining", both["a"], both["c"], "C - A", passed, behaviour)
    figure("4 group 4 pass", records["a"], records["c"], "C - A", passed, group4)
    figure("5 selector", records["b"], records["c"], "C - B", passed, None)
    figure("(B)", records["a"], records["b"], "B - A", passed, None)

    if any("check" in r for rs in records.values() for r in rs):
        marks(records)

    dropped = cases(both, behaviour, every)
    if mean is not None:
        holds = mean >= MARGIN and not dropped
        why = f"mean {mean:+.1f} (at least {MARGIN:+.0f})"
        why += f", dropped: {', '.join(dropped)}" if dropped else ", no case dropped"
        stage = "with" if any(extra.values()) else "without"
        print(
            f"\nPoint 3 (6.7, {stage} the behaviour stage): {'holds' if holds else 'fails'}, {why}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
