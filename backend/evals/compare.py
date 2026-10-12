"""Put eval runs side by side, case by case, as a Markdown table.

    uv run python evals/compare.py t3-v0-gemma4 t3-v27c-gemma4
    uv run python evals/compare.py --changed t3-v27c-gemma4 t3-v27c-gemma4-s6

Each label names the newest ``results/*-<label>.jsonl``. ``--changed`` keeps
only the cases whose passes differ between the runs (and the sums).
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent


def passes(label: str) -> dict[str, tuple[int, int]]:
    """Case id → (passed, runs) of the newest run with ``label``."""
    # <date>-<time>-<label>.jsonl; "v27-x" must not match "t3-v27-x".
    files = sorted(
        path
        for path in (HERE / "results").glob(f"*-{label}.jsonl")
        if path.name.split("-", 2)[2] == f"{label}.jsonl"
    )
    if not files:
        raise SystemExit(f"no run labelled {label!r} in {HERE / 'results'}")
    counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    with files[-1].open(encoding="utf-8") as lines:
        next(lines)  # the run's header
        for line in lines:
            record = json.loads(line)
            counts[record["case"]][0] += record["verdict"] == "pass"
            counts[record["case"]][1] += 1
    return {case: (n[0], n[1]) for case, n in counts.items()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("labels", nargs="+")
    parser.add_argument("--changed", action="store_true", help="only cases that differ")
    args = parser.parse_args()
    runs = {label: passes(label) for label in args.labels}
    cases = [c["id"] for c in json.loads((HERE / "cases.json").read_text("utf-8"))["cases"]]

    def cell(label: str, case: str) -> str:
        found = runs[label].get(case)
        return f"{found[0]}/{found[1]}" if found else "-"

    print("| Fall | " + " | ".join(args.labels) + " |")
    print("|---|" + "---:|" * len(args.labels))
    for case in cases:
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
