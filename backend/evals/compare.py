"""Put eval runs side by side, case by case, as a Markdown table.

    uv run python evals/compare.py t3-v0-gemma4 t3-v27c-gemma4
    uv run python evals/compare.py --changed t3-v27c-gemma4 t3-v27c-gemma4-s6
    uv run python evals/compare.py --stats --by-tag x-luna+x-luna-s6 gemma4+gemma4-s6

Each label names the newest ``results/*-<label>.jsonl``; ``a+b`` joins the
runs of both into one column (two seed blocks). ``--changed`` keeps only the
cases whose passes differ between the runs (and the sums). ``--by-tag`` sums
per tag of the cases (``tags`` of the start set, schema/eval-cases). ``--stats``
compares every column with the first, case by case: the five answers of a case
are not independent, so the sample is the cases, not the answers.
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

from casefiles import CASE_FILES, load_cases

from geotandem.evaluation.schemas import EvalCase
from geotandem.evaluation.stats import compare, tally

HERE = Path(__file__).parent


def newest(label: str) -> Path:
    # <date>-<time>-<label>.jsonl; "v27-x" must not match "t3-v27-x".
    files = sorted(
        path
        for path in (HERE / "results").glob(f"*-{label}.jsonl")
        if path.name.split("-", 2)[2] == f"{label}.jsonl"
    )
    if not files:
        raise SystemExit(f"no run labelled {label!r} in {HERE / 'results'}")
    return files[-1]


def passes(column: str) -> tuple[dict[str, tuple[int, int]], int]:
    """Case id → (passed, runs) of the newest run of each label in ``column``
    (``a+b``), and the number of ``error:*`` answers."""
    verdicts: list[tuple[str, str]] = []
    for label in column.split("+"):
        with newest(label).open(encoding="utf-8") as lines:
            next(lines)  # the run's header
            verdicts += [(r["case"], r["verdict"]) for r in map(json.loads, lines)]
    return tally(verdicts), sum(v.startswith("error:") for _, v in verdicts)


def all_cases() -> list[EvalCase]:
    return [c for name in CASE_FILES for c in load_cases(name)]


def stats(columns: list[str], runs: dict[str, dict[str, tuple[int, int]]]) -> None:
    base = columns[0]
    print(f"\n**Gegen {base}** (je Fall die Quote, Unterschied in Prozentpunkten)\n")
    print(
        "| Lauf | Fälle | besser | schlechter | gleich | Δ Mittel | 95 %-Intervall "
        "| p (Vorzeichen) |"
    )
    print("|---|---:|---:|---:|---:|---:|---|---:|")
    for other in columns[1:]:
        found = compare(runs[base], runs[other])
        print(
            f"| {other} | {found.cases} | {found.better} | {found.worse} | {found.same} "
            f"| {found.mean:+.1f} | {found.low:+.1f} … {found.high:+.1f} | {found.p_sign:.2f} |"
        )


def by_tag(
    columns: list[str], runs: dict[str, dict[str, tuple[int, int]]], cases: list[EvalCase]
) -> None:
    tags: dict[str, list[str]] = defaultdict(list)
    for case in cases:
        for tag in case.tags:
            tags[tag].append(case.id)
    print("\n| Tag | Fälle | " + " | ".join(columns) + " |")
    print("|---|---:|" + "---:|" * len(columns))
    for tag in sorted(tags):
        cells = []
        for column in columns:
            found = [runs[column][c] for c in tags[tag] if c in runs[column]]
            passed, total = sum(f[0] for f in found), sum(f[1] for f in found)
            cells.append(f"{100 * passed / total:.0f} %" if total else "-")
        present = sum(any(c in runs[col] for col in columns) for c in tags[tag])
        print(f"| {tag} | {present} | " + " | ".join(cells) + " |")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("labels", nargs="+", help="run labels; a+b joins runs into one column")
    parser.add_argument("--changed", action="store_true", help="only cases that differ")
    parser.add_argument("--stats", action="store_true", help="paired comparison with the first")
    parser.add_argument("--by-tag", action="store_true", help="pass rate per case tag")
    args = parser.parse_args()
    loaded = {label: passes(label) for label in args.labels}
    runs = {label: found for label, (found, _) in loaded.items()}
    cases = all_cases()
    ids = [c.id for c in cases if any(c.id in runs[label] for label in args.labels)]

    def cell(label: str, case: str) -> str:
        found = runs[label].get(case)
        return f"{found[0]}/{found[1]}" if found else "-"

    print("| Fall | " + " | ".join(args.labels) + " |")
    print("|---|" + "---:|" * len(args.labels))
    for case in ids:
        cells = [cell(label, case) for label in args.labels]
        if args.changed and len(set(cells)) == 1:
            continue
        print(f"| `{case}` | " + " | ".join(cells) + " |")
    sums = []
    for label in args.labels:
        passed = sum(n[0] for n in runs[label].values())
        total = sum(n[1] for n in runs[label].values())
        sums.append(f"**{passed}/{total}**")
    print("| **Summe** | " + " | ".join(sums) + " |")
    print("| Fehler (`error:*`) | " + " | ".join(str(n) for _, n in loaded.values()) + " |")
    if args.by_tag:
        by_tag(args.labels, runs, cases)
    if args.stats and len(args.labels) > 1:
        stats(args.labels, runs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
