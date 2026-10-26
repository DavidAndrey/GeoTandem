"""How the runs behaved, beside how often they passed (docs/plan-chain-eval.md 6).

    uv run python evals/chain_report.py k-gemma4_12b+k-gemma4_12b-s6 d-gemma4_12b+d-gemma4_12b-s6
    uv run python evals/chain_report.py --why k-gemma4_12b

One column per label (``a+b`` joins seed blocks, as in ``compare.py``), one row
per figure: passes, silently wrong (``wrong`` with ``no_assumption``), latency
and tokens, seconds and tokens per correct answer, and for a chain run the
chain's own: first plan accepted, refused plans by code, how chains ended,
re-plans and what came of them, steps. A direct run has no chain figures
(``-``). ``--why`` lists what refused the plans, by the first error of each,
for the failure reading of Phase 2.
"""

import argparse
import json
import statistics
import sys
from collections import Counter
from collections.abc import Callable
from typing import Any

from compare import newest


def records(column: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for label in column.split("+"):
        with newest(label).open(encoding="utf-8") as lines:
            next(lines)  # the run's header
            found += map(json.loads, lines)
    return found


def share(part: int, whole: int) -> str:
    return f"{100 * part / whole:.0f} % ({part}/{whole})" if whole else "-"


def quantile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def first_error(record: dict[str, Any]) -> str:
    """A refused plan's code and its first error: what to read in Phase 2."""
    refusal = record.get("refusal") or {}
    details = refusal.get("details") or {}
    errors = details.get("errors") or []
    if errors:
        first = errors[0]
        where = ".".join(str(part) for part in first.get("loc", []))
        return f"{refusal.get('code')}: {where} {first.get('type')} ({first.get('msg')})"
    return f"{refusal.get('code')}: {details.get('part', '')}"


def figures(rows: list[dict[str, Any]]) -> dict[str, str]:
    total = len(rows)
    passed = [r for r in rows if r["verdict"] == "pass"]
    silent = [
        r
        for r in rows
        if r["verdict"].startswith("wrong") and "no_assumption" in r.get("flags", [])
    ]
    latency = [r["latency_ms"] / 1000 for r in rows if r.get("latency_ms") is not None]
    tokens_in = [r["prompt_tokens"] for r in rows if r.get("prompt_tokens") is not None]
    tokens_out = [r["completion_tokens"] for r in rows if r.get("completion_tokens") is not None]
    out: dict[str, str] = {
        "Antworten": str(total),
        "pass": share(len(passed), total),
        "still falsch": share(len(silent), total),
        "error:*": str(sum(r["verdict"].startswith("error:") for r in rows)),
        "Latenz Median / p90": (
            f"{statistics.median(latency):.1f} s / {quantile(latency, 0.9):.1f} s"
            if latency
            else "-"
        ),
        "Tokens ein / aus (Mittel)": (
            f"{statistics.mean(tokens_in):.0f} / {statistics.mean(tokens_out):.0f}"
            if tokens_in
            else "-"
        ),
        "s je richtige Antwort": f"{sum(latency) / len(passed):.1f}" if passed else "-",
        "Tokens je richtige Antwort": (
            f"{(sum(tokens_in) + sum(tokens_out)) / len(passed):.0f}"
            if passed and tokens_in
            else "-"
        ),
    }
    chains = [r for r in rows if "end" in r]
    if not chains:
        return out
    planned = [r for r in chains if r["calls"] and r["calls"][0]["outcome"] == "plan"]
    accepted = [r for r in planned if r["end"] != "refused"]
    replanned = [r for r in chains if r["replans"]]
    steps = [len(r["steps"]) for r in chains if r["steps"]]
    calls = [len(r["calls"]) for r in chains]
    ends = Counter(r["end"] for r in chains)
    refused = Counter((r.get("refusal") or {}).get("code") for r in chains if r["end"] == "refused")
    out |= {
        "Plan beim ersten Aufruf": share(len(planned), len(chains)),
        "erster Plan angenommen": share(len(accepted), len(planned)),
        "Plan abgewiesen, nach Code": ", ".join(f"{c} {n}" for c, n in refused.most_common()),
        "Ende": ", ".join(f"{e} {n}" for e, n in ends.most_common()),
        "mit Re-Plan": share(len(replanned), len(chains)),
        "Re-Plan, dann done / pass": (
            f"{share(sum(r['end'] == 'done' for r in replanned), len(replanned))} / "
            f"{share(sum(r['verdict'] == 'pass' for r in replanned), len(replanned))}"
            if replanned
            else "-"
        ),
        "Schritte Median / p90 / max": (
            f"{statistics.median(steps):.0f} / {quantile(steps, 0.9):.0f} / {max(steps)}"
            if steps
            else "-"
        ),
        "Aufrufe je Frage (Mittel)": f"{statistics.mean(calls):.2f}" if calls else "-",
    }
    return out


def table(columns: list[str], found: dict[str, dict[str, str]]) -> None:
    rows: list[str] = []
    for column in columns:
        rows += [name for name in found[column] if name not in rows]
    print("| | " + " | ".join(columns) + " |")
    print("|---|" + "---|" * len(columns))
    for name in rows:
        print(f"| {name} | " + " | ".join(found[c].get(name, "-") for c in columns) + " |")


def why(column: str, keep: Callable[[dict[str, Any]], bool]) -> None:
    reasons = Counter(first_error(r) for r in records(column) if keep(r))
    print(f"\n**{column}**: abgewiesene Pläne nach erstem Fehler\n")
    for reason, count in reasons.most_common():
        print(f"- {count}x {reason}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("labels", nargs="+", help="run labels; a+b joins runs into one column")
    parser.add_argument("--why", action="store_true", help="what refused the plans, by first error")
    args = parser.parse_args()
    if args.why:
        for column in args.labels:
            why(column, lambda r: r.get("end") == "refused")
        return 0
    table(args.labels, {column: figures(records(column)) for column in args.labels})
    return 0


if __name__ == "__main__":
    sys.exit(main())
