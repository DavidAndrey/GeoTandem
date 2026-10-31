"""The figures of rule 6.6 (docs/plan-improve-examples.md) for one group of
bench.py, from the newest result file of each of its chunks.

    uv run python evals/decide.py check-gemma4_12b

Per arm the answers of all three files and both seed blocks together; each
figure is paired per case (``stats.compare``): rates, the mean difference in
points and its 95 % interval. Then, for a check, the marks per arm, and the
behaviour cases one by one (where point 3 is decided).
"""

import argparse
import json
from collections import Counter
from collections.abc import Callable, Collection
from typing import Any

from bench import chunks, newest
from pool import ARMS

from geotandem.evaluation.cases import chain_set, layer_set, start_set
from geotandem.evaluation.signature import group
from geotandem.evaluation.stats import compare

Record = dict[str, Any]
Test = Callable[[Record], bool]


def passed(r: Record) -> bool:
    return bool(r["verdict"] == "pass")


def unmarked(r: Record) -> bool:
    return bool((r.get("check") or {}).get("state") != "differs")


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("group", help="e.g. check-gemma4_12b")
    key = parser.parse_args().group

    every = {c.id: c for c in (*start_set(), *chain_set(), *layer_set())}
    pool = [c for c in every.values() if c.split == "tuning"]
    records: dict[str, list[Record]] = {arm: [] for arm in ARMS}
    missing = []
    for chunk in chunks():
        if chunk.group.key != key:
            continue
        path = newest(chunk.label)
        if path is None:
            missing.append(chunk.label)
            continue
        lines = path.read_text("utf-8").splitlines()[1:]
        records[chunk.arm] += [json.loads(line) for line in lines]
    if not any(records.values()):
        parser.error(f"no results for {key!r}")
    if missing:
        print(f"missing {len(missing)} chunks: {', '.join(missing)}\n")

    behaviour = {c for c, k in every.items() if k.expect is not None}
    group4 = {c for c, k in every.items() if k.split == "confirm" and group(k, pool) == 4}
    figures: list[tuple[str, str, str, Test, Collection[str] | None]] = [
        ("1 pass", "a", "c", passed, None),
        ("2 silent wrongs", "a", "c", silent, None),
        ("3 asking/declining", "a", "c", passed, behaviour),
        ("4 group 4 pass", "a", "c", passed, group4),
        ("5 selector", "b", "c", passed, None),
        ("(B)", "a", "b", passed, None),
    ]
    print("| Figure | Arms | Rate | Δ points (95 %) | Cases |\n|---|---|---|---|---|")
    for name, base, other, test, only in figures:
        a, b = rates(records[base], test, only), rates(records[other], test, only)
        arms = f"{other.upper()} - {base.upper()}"
        if not a or not b:
            print(f"| {name} | {arms} | - | - | - |")
            continue
        p = compare(a, b)
        print(
            f"| {name} | {arms} | {rate(a):.1f} → {rate(b):.1f} % "
            f"| {p.mean:+.1f} ({p.low:+.1f} … {p.high:+.1f}) | {p.cases} |"
        )

    if any("check" in r for rs in records.values() for r in rs):
        print("\n| Arm | Answers | Correct | Marked of correct (≤ 10 %) | Wrong left unmarked |")
        print("|---|---|---|---|---|")
        for arm, rs in records.items():
            ok = [r for r in rs if passed(r) and "check" in r]
            marked = sum(not unmarked(r) for r in ok)
            wrong = [r for r in rs if r["verdict"].startswith("wrong")]
            share = f"{100 * marked / len(ok):.1f} %" if ok else "-"
            left = f"{sum(unmarked(r) for r in wrong)} of {len(wrong)}"
            print(f"| {arm.upper()} | {len(rs)} | {len(ok)} | {marked} = {share} | {left} |")

    print("\nBehaviour cases, passes per arm, and C's other verdicts:")
    for case in sorted(behaviour):
        rows = {arm: [r for r in rs if r["case"] == case] for arm, rs in records.items()}
        if not rows["a"]:
            continue
        counts = " ".join(
            f"{arm.upper()} {sum(map(passed, rs))}/{len(rs)}" for arm, rs in rows.items()
        )
        rest = Counter(r["verdict"] for r in rows["c"] if not passed(r))
        print(f"  {case:32} {every[case].expect:14} {counts}  {dict(rest) or ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
