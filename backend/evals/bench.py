"""The runs of the measurement of examples, in pieces of a few hours
(docs/examples-benchmarks.md, docs/plan-improve-examples.md 6.5).

The matrix is cut into **chunks**: one ``run.py`` call for an approach, a
model, a confirm file, an arm and a seed block (five seeds). A chunk is done
when the newest ``results/*-<label>.jsonl`` holds an answer for every case and
seed; an interrupted chunk's file is renamed ``….jsonl.partial``, so
``compare.py`` never reads it, and the chunk runs again from the start.

    uv run python evals/bench.py status
    uv run python evals/bench.py next --hours 3
    uv run python evals/bench.py next --hours 2 --only check-gemma4_12b --dry-run
    uv run python evals/bench.py compare check-gemma4_12b

``bench-log.jsonl`` beside the results keeps per chunk the commit it ran on,
its start, end and exit code; ``status`` warns when the done chunks of one
comparison ran on different commits. Durations are estimated from the done
chunks of the same approach and model, else from ``SECONDS``.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Final

from casefiles import load_cases
from pool import ARMS

from geotandem.evaluation.cases import chain_set, layer_set, start_set
from geotandem.evaluation.signature import copies

HERE = Path(__file__).parent
RESULTS = HERE / "results"
LOG = RESULTS / "bench-log.jsonl"
DOC = HERE.parent.parent / "docs" / "examples-benchmarks.md"
MARK = ("<!-- bench:status -->", "<!-- /bench:status -->")

FILES: Final = ("heldout", "chain-heldout", "layers-heldout")
BLOCKS: Final = (1, 6)
REPEAT: Final = 5
TEMPERATURE: Final = 0.3
OPENAI: Final = ("https://api.openai.com/v1", "OPENAI_API_KEY")


@dataclass(frozen=True)
class Group:
    """One comparison of the decision rule: an approach on a model, all arms."""

    approach: str
    model: str
    seconds: float
    """Seconds per answer before a chunk of the group has run: a guess from
    the latencies of earlier runs, raised for the longer prompts of B and C."""
    external: bool = False

    @property
    def key(self) -> str:
        return f"{self.approach}-{re.sub(r'[^a-z0-9]+', '_', self.model.lower())}"


GEMMA, QWEN, LUNA = "gemma4:12b", "qwen3:14b", "gpt-6-luna"
GROUPS: Final = (
    Group("check", GEMMA, 12),
    Group("check", QWEN, 20),
    Group("direct", GEMMA, 6),
    Group("direct", QWEN, 10),
    Group("chain", GEMMA, 10),
    Group("chain", QWEN, 18),
    Group("direct", LUNA, 4, external=True),
    Group("chain", LUNA, 7, external=True),
)
"""In the order they run: the check first (rule 6), the external model last."""


@dataclass(frozen=True)
class Chunk:
    group: Group
    cases: str
    arm: str
    block: int

    @property
    def label(self) -> str:
        return f"xb-{self.group.key}-{self.cases}-{self.arm}-s{self.block}"

    def command(self) -> list[str]:
        g = self.group
        command = [sys.executable, str(HERE / "run.py"), "--model", g.model]
        if g.external:
            command += ["--url", OPENAI[0], "--api-key-env", OPENAI[1]]
        return [
            *command,
            "--approach", g.approach, "--cases", self.cases, "--arm", self.arm,
            "--seed-start", str(self.block), "--repeat", str(REPEAT),
            "--temperature", str(TEMPERATURE), "--label", self.label,
        ]  # fmt: skip


def chunks() -> Iterator[Chunk]:
    """Every chunk, in running order: per group and seed block, the arms of
    one file together, so A runs fresh beside B and C."""
    for group in GROUPS:
        for block in BLOCKS:
            for cases in FILES:
                for arm in ARMS:
                    yield Chunk(group, cases, arm, block)


def expected() -> dict[tuple[str, str], int]:
    """Answers per chunk by file and approach: its cases, without those that
    copy a pool case or want the approach offered as the other one."""
    every = (*start_set(), *chain_set(), *layer_set())
    pool = [k for k in every if k.split == "tuning"]
    found = {}
    for name in FILES:
        cases = load_cases(name)
        copied = {c for c, _ in copies(cases, pool)}
        for approach in ("direct", "chain", "check"):
            offered = "direct" if approach == "check" else approach
            kept = [c for c in cases if c.id not in copied and c.other_approach != offered]
            found[name, approach] = len(kept) * REPEAT
    return found


def newest(label: str) -> Path | None:
    files = sorted(
        p for p in RESULTS.glob(f"*-{label}.jsonl") if p.name.split("-", 2)[2] == f"{label}.jsonl"
    )
    return files[-1] if files else None


def answers(path: Path | None) -> int:
    if path is None:
        return 0
    with path.open(encoding="utf-8") as lines:
        return max(sum(1 for _ in lines) - 1, 0)


def logged() -> dict[str, dict[str, Any]]:
    """The last log entry of each label."""
    if not LOG.is_file():
        return {}
    entries = (json.loads(line) for line in LOG.read_text("utf-8").splitlines() if line)
    return {e["label"]: e for e in entries}


def commit() -> str:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=HERE, capture_output=True, text=True, check=True
        ).stdout.strip()

    head = git("rev-parse", "--short", "HEAD")
    paths = [str(HERE.parent / "src"), str(HERE), str(HERE.parent.parent / "schema")]
    return head + ("+dirty" if git("status", "--porcelain", "--", *paths) else "")


def per_answer(group: Group, log: dict[str, dict[str, Any]]) -> float:
    """Seconds per answer from the group's done chunks, else the guess."""
    spent = [
        (e["seconds"], e["answers"])
        for e in log.values()
        if e.get("group") == group.key and e.get("exit") == 0 and e.get("answers")
    ]
    if not spent:
        return group.seconds
    return float(sum(s for s, _ in spent) / sum(n for _, n in spent))


def state() -> list[tuple[Chunk, int, int, float]]:
    """Each chunk with its answers found, wanted and estimated seconds."""
    want, log = expected(), logged()
    rows = []
    for chunk in chunks():
        wanted = want[chunk.cases, chunk.group.approach]
        found = answers(newest(chunk.label))
        rows.append((chunk, found, wanted, wanted * per_answer(chunk.group, log)))
    return rows


def hours(seconds: float) -> str:
    return f"{seconds / 3600:.1f} h"


def status_table() -> str:
    rows, log = state(), logged()
    lines = [
        "| Group | Chunks done | Left | Estimate left | Commits |",
        "|---|---|---|---|---|",
    ]
    for group in GROUPS:
        mine = [r for r in rows if r[0].group == group]
        done = [r for r in mine if r[1] >= r[2]]
        left = sum(r[3] for r in mine if r[1] < r[2])
        commits = sorted({log[r[0].label]["commit"] for r in done if r[0].label in log})
        warn = " ⚠ mixed" if len(commits) > 1 else ""
        name = group.key + (" (external)" if group.external else "")
        lines.append(
            f"| `{name}` | {len(done)}/{len(mine)} | {len(mine) - len(done)} | "
            f"{hours(left)} | {', '.join(commits) or '-'}{warn} |"
        )
    total = sum(r[3] for r in rows if r[1] < r[2])
    lines.append(f"\nLeft in all: {hours(total)} (estimate, {datetime.now():%Y-%m-%d %H:%M}).")
    return "\n".join(lines)


def write_status() -> None:
    text = DOC.read_text("utf-8")
    start, end = text.index(MARK[0]) + len(MARK[0]), text.index(MARK[1])
    DOC.write_text(text[:start] + "\n" + status_table() + "\n" + text[end:], "utf-8")


def run_chunk(chunk: Chunk, wanted: int) -> bool:
    """Run ``chunk`` to its end; an unfinished file becomes ``.partial``."""
    started, head = time.time(), commit()
    entry: dict[str, Any] = {"label": chunk.label, "group": chunk.group.key, "commit": head}
    entry["start"] = datetime.now().isoformat(timespec="seconds")
    print(f"\n=== {chunk.label} ({wanted} answers, commit {head})", flush=True)
    try:
        code = subprocess.run(chunk.command(), cwd=HERE.parent).returncode
    except KeyboardInterrupt:
        code = 130
    path = newest(chunk.label)
    found = answers(path)
    if path is not None and (code != 0 or found < wanted):
        path.rename(path.with_name(path.name + ".partial"))
    entry |= {"end": datetime.now().isoformat(timespec="seconds"), "exit": code}
    entry |= {"seconds": round(time.time() - started), "answers": found}
    RESULTS.mkdir(exist_ok=True)
    with LOG.open("a", encoding="utf-8") as log:
        log.write(json.dumps(entry) + "\n")
    return code == 0 and found >= wanted


def planned(
    budget: float, only: str | None, external: bool
) -> tuple[list[tuple[Chunk, int]], float]:
    """The chunks left, in order, while their estimate fits ``budget``
    (seconds); always at least one. With their answers wanted, and the sum."""
    plan: list[tuple[Chunk, int]] = []
    spent = 0.0
    for chunk, found, wanted, estimate in state():
        skipped = (only and chunk.group.key != only) or (chunk.group.external and not external)
        if found >= wanted or skipped:
            continue
        if plan and spent + estimate > budget:
            break
        plan.append((chunk, wanted))
        spent += estimate
    return plan, spent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="action", required=True)
    status = sub.add_parser("status", help="chunks done and left per group")
    status.add_argument("--write", action="store_true", help=f"also into {DOC.name}")
    step = sub.add_parser("next", help="run the next chunks that fit in --hours")
    step.add_argument("--hours", type=float, required=True)
    step.add_argument("--only", metavar="GROUP", help="one group, e.g. check-gemma4_12b")
    step.add_argument("--external", action="store_true", help="include gpt-6-luna (paid API)")
    step.add_argument("--dry-run", action="store_true", help="print the commands only")
    report = sub.add_parser("compare", help="the compare.py command of a group, A first")
    report.add_argument("group")
    args = parser.parse_args()

    if args.action == "status":
        print(status_table())
        if args.write:
            write_status()
        return 0
    if args.action == "compare":
        columns = [
            "+".join(c.label for c in chunks() if c.group.key == args.group and c.arm == arm)
            for arm in ARMS
        ]
        if not columns[0]:
            parser.error(f"no group {args.group!r}")
        print(" ".join(["uv run python evals/compare.py --stats", *columns]))
        return 0
    plan, spent = planned(args.hours * 3600, args.only, args.external)
    if not plan:
        print("nothing left to run" + (f" in {args.only}" if args.only else ""))
        return 0
    print(f"{len(plan)} chunks, about {hours(spent)}:")
    for chunk, _ in plan:
        print("  " + " ".join(chunk.command()[1:]))
    if args.dry_run:
        return 0
    if any(c.group.external for c, _ in plan) and not os.environ.get(OPENAI[1]):
        parser.error(f"{OPENAI[1]} is not set")
    if commit().endswith("+dirty"):
        parser.error("uncommitted changes under backend/ or schema/: commit first (6.5)")
    for chunk, wanted in plan:
        if not run_chunk(chunk, wanted):
            print(f"stopped: {chunk.label} did not finish (kept as .partial)")
            write_status()
            return 1
    write_status()
    print("\n" + status_table())
    return 0


if __name__ == "__main__":
    sys.exit(main())
