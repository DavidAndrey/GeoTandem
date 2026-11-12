"""Which questions work with which model: the confirm questions of the
measurement of examples (docs/examples-benchmarks.md), sorted into groups by
the models that answer them, for docs/benchmarks.md and the presentation.

    uv run python evals/tiers.py                 # print the section
    uv run python evals/tiers.py --write ../docs/benchmarks.md

A question **works** with a model when at least ``--threshold`` of its ten
answers (two seed blocks of five) pass. The groups follow the models from
the weakest to the strongest: all four, then without qwen, then only Luna
and Haiku, then only Haiku; what fits none of these is "anders verteilt" or
"keines". Both arms are shown: ``a`` the fixed examples, ``c`` the examples
chosen per question (the application's ``eigene``). Questions whose right
answer is no query (a question back or a refusal, ``expect``) are marked.

Haiku ran at temperature 1 (Anthropic takes no less), the others at 0.3.
"""

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from bench import BLOCKS, FILES, GEMMA, HAIKU, LUNA, QWEN, newest
from casefiles import load_cases

MODELS: Final = ((QWEN, "qwen"), (GEMMA, "gemma"), (LUNA, "luna"), (HAIKU, "haiku"))
GROUPS: Final = {
    "1111": "1 · alle vier",
    "0111": "2 · ohne qwen",
    "0011": "3 · nur Luna und Haiku",
    "0001": "4 · nur Haiku",
    "0000": "keines",
}
OTHER: Final = "anders verteilt"
ORDER: Final = (*GROUPS.values(), OTHER)
MARK: Final = ("<!-- tiers -->", "<!-- /tiers -->")
APPROACHES: Final = {"direct": "Direktabfrage", "chain": "Werkzeugkette", "check": "Prüfung"}
EXPECTED: Final = {"clarification": "Rückfrage", "cannot_answer": "Absage"}


def key(model: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", model.lower())


@dataclass(frozen=True)
class Question:
    id: str
    prompt: str
    expect: str | None
    passed: dict[str, dict[str, int]]
    """Per arm, per model: passing answers of ten."""

    def group(self, arm: str, threshold: int) -> str:
        works = "".join("1" if self.passed[arm][m] >= threshold else "0" for m, _ in MODELS)
        return GROUPS.get(works, OTHER)

    def counts(self, arm: str) -> str:
        return " · ".join(str(self.passed[arm][m]) for m, _ in MODELS)


def answers(approach: str, model: str, name: str, arm: str) -> dict[str, list[bool]]:
    """Per case, whether each of its answers passed: both seed blocks."""
    found: dict[str, list[bool]] = {}
    for block in BLOCKS:
        label = f"xb-{approach}-{key(model)}-{name}-{arm}-s{block}"
        path = newest(label)
        if path is None:
            raise SystemExit(f"no run labelled {label!r}")
        for line in path.read_text().splitlines()[1:]:
            row = json.loads(line)
            if "case" in row:
                found.setdefault(row["case"], []).append(row.get("verdict") == "pass")
    return found


def questions(approach: str, arms: tuple[str, ...]) -> list[Question]:
    """The measured questions; a case the measurement left out (a copy of a
    pool case, or one wanting the other approach) has no answers and stays out."""
    found = []
    for name in FILES:
        runs = {
            (arm, model): answers(approach, model, name, arm) for arm in arms for model, _ in MODELS
        }
        for case in load_cases(name):
            if not all(case.id in run for run in runs.values()):
                continue
            passed = {
                arm: {model: sum(runs[arm, model][case.id]) for model, _ in MODELS} for arm in arms
            }
            found.append(Question(case.id, case.prompt, case.expect, passed))
    return found


def section(found: list[Question], arms: tuple[str, ...], threshold: int, approach: str) -> str:
    first, last = arms[0], arms[-1]
    names = " · ".join(short for _, short in MODELS)
    lines = [
        f"{APPROACHES[approach]}, {len(found)} Bestätigungsfragen der Messung der "
        f"Beispiele, je 10 Antworten; «geht» heisst mindestens {threshold} von 10 richtig. "
        f"Arm `{first}`: feste Beispiele, Arm `{last}`: Beispiele je Frage (in der "
        "Anwendung `eigene`). Haiku lief mit Temperatur 1, die anderen mit 0,3. "
        "Erzeugt mit `evals/tiers.py`.",
        "",
        "| Gruppe | " + " | ".join(f"Arm `{a}`" for a in arms) + " |",
        "|---|" + "---:|" * len(arms),
    ]
    for group in ORDER:
        row = [str(sum(q.group(a, threshold) == group for q in found)) for a in arms]
        lines.append(f"| {group} | " + " | ".join(row) + " |")
    rates = []
    for arm in arms:
        rate = " / ".join(
            f"{round(100 * sum(q.passed[arm][m] for q in found) / (10 * len(found)))} %"
            for m, _ in MODELS
        )
        rates.append(rate)
    lines.append(f"| Quote {names} | " + " | ".join(rates) + " |")
    lines += [
        "",
        f"Die Fragen nach ihrer Gruppe in Arm `{last}`; die Zahlen sind richtige "
        f"Antworten von 10 in der Reihenfolge {names}. *Rückfrage* und *Absage*: "
        "Richtig ist keine Abfrage, sondern eine Rückfrage oder eine begründete Absage.",
    ]
    for group in ORDER:
        members = [q for q in found if q.group(last, threshold) == group]
        if not members:
            continue
        lines += [
            "",
            f"#### {group} ({len(members)})",
            "",
            f"| Frage | Arm `{first}` | Gruppe in `{first}` | Arm `{last}` |",
            "|---|---|---|---|",
        ]
        members.sort(key=lambda q: (ORDER.index(q.group(first, threshold)), q.id))
        for q in members:
            prompt = q.prompt.replace("|", "\\|")
            if q.expect:
                prompt += f" *({EXPECTED.get(q.expect, q.expect)})*"
            lines.append(
                f"| {prompt} `{q.id}` | {q.counts(first)} | {q.group(first, threshold)} "
                f"| {q.counts(last)} |"
            )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--approach", default="direct", choices=("direct", "chain", "check"))
    parser.add_argument("--arms", nargs="+", default=["a", "c"])
    parser.add_argument("--threshold", type=int, default=8)
    parser.add_argument("--json", type=Path, help="also write the counts as JSON")
    parser.add_argument("--write", type=Path, help=f"replace the part between {MARK[0]} …")
    args = parser.parse_args()
    arms = tuple(args.arms)
    found = questions(args.approach, arms)
    text = section(found, arms, args.threshold, args.approach)
    if args.json:
        args.json.write_text(
            json.dumps(
                [
                    {
                        "id": q.id,
                        "prompt": q.prompt,
                        "expect": q.expect,
                        "passed": q.passed,
                        "groups": {a: q.group(a, args.threshold) for a in arms},
                    }
                    for q in found
                ],
                ensure_ascii=False,
                indent=1,
            )
        )
    if not args.write:
        print(text)
        return 0
    doc = args.write.read_text()
    start, end = doc.index(MARK[0]) + len(MARK[0]), doc.index(MARK[1])
    args.write.write_text(doc[:start] + "\n" + text + "\n" + doc[end:])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
