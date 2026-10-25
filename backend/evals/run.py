"""Ask a real model the questions of the start set and grade its answers.

The direct query as the prompt flow sends it (``direct_prompt``,
``DirectQuery.ask``: the real client, parser and checks), over a fresh sample
dataset and the default level; only the grading is the harness's own. With
``--approach chain`` the tool chain instead, planned, run and re-planned as
the application runs it at *Automatisch* (``evaluation.chain.drive``). See
``evals/README.md``.

    uv run python evals/run.py --model qwen3:8b --label baseline
    uv run python evals/run.py --model qwen3:8b --variant p9 --label p9-qwen3
    uv run python evals/run.py --model qwen3:8b --approach chain --cases chain --label k-qwen3
"""

import argparse
import hashlib
import json
import os
import statistics
import sys
import time
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any

from casefiles import CASE_FILES, load_cases
from variants import (
    APP_EXAMPLES,
    VARIANTS,
    load_examples,
    prompt_hash,
    prompt_profile,
    with_examples,
)

from geotandem.catalog import ModelProfile, model_profile
from geotandem.config import Settings
from geotandem.data import Limits
from geotandem.evaluation.chain import drive, graded
from geotandem.evaluation.grade import PASS, Graded, errored, grade, reading_ids
from geotandem.evaluation.profiles import PROFILES
from geotandem.evaluation.sample import build_sample
from geotandem.evaluation.schemas import EvalCase
from geotandem.levels import Level
from geotandem.levels.store import load_levels
from geotandem.llm import Completion, Endpoint, LLMError, Message
from geotandem.llm.hosts import host_of
from geotandem.llm.openai_compat import OpenAICompatClient
from geotandem.model.chain.ask import replan_message
from geotandem.model.direct import DirectQuery, direct_prompt
from geotandem.model.errors import ActionError
from geotandem.model.prompt import Prompt, build_prompt
from geotandem.model.schemas import ModelView
from geotandem.tools import ToolContext

HERE = Path(__file__).parent
LIMITS = Limits(max_features=10_000, timeout_s=10)


class Recording(OpenAICompatClient):
    """The real client, keeping its completions: tokens for every answer
    (H-3), the verbatim text when the answer does not read (H-4); a chain's
    re-plans each add one."""

    last: Completion | None = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.completions: list[Completion] = []

    def complete(self, messages: Sequence[Message], **kwargs: Any) -> Completion:
        self.last = None
        self.last = super().complete(messages, **kwargs)
        self.completions.append(self.last)
        return self.last


def replan_hash() -> str:
    """Over the re-plan's input for a placeholder step: two chain runs with the
    same hash told the model the same after a step (``ask.replan_message``)."""
    seen = [(1, "filter", ModelView(outcome="ok", empty=True, count=0))]
    text = replan_message(seen, kept=[1], first=2)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class World:
    """What every question of a run is asked and graded in."""

    context: ToolContext
    profile: ModelProfile
    level: Level


Readings = list[list[int]] | None


def ask_direct(
    client: Recording, prompt: Prompt, case: EvalCase, world: World, readings: Readings
) -> tuple[Graded, dict[str, Any]]:
    """One direct query, graded; what the record keeps of it."""
    found = DirectQuery(client, world.context, world.level).ask(prompt, profile=world.profile)
    backend = world.context.backend
    verdict = grade(case, found.answer, found.refusal, found.query, backend, LIMITS, readings)
    return verdict, {
        "answer": found.answer.model_dump(mode="json"),
        "refusal": found.refusal.model_dump(mode="json") if found.refusal else None,
        "latency_ms": found.latency_ms,
    }


def ask_chain(
    client: Recording, prompt: Prompt, case: EvalCase, world: World, readings: Readings
) -> tuple[Graded, dict[str, Any]]:
    """One chain to its end, graded; what the record keeps of it: every call
    and every step (plan-chain-eval 3, item 2)."""
    started = time.monotonic()
    chain = drive(client, prompt, world.context, world.profile)
    latency = round((time.monotonic() - started) * 1000)
    verdict = graded(case, chain, world.context.backend, LIMITS, readings)
    return verdict, {
        "answer": chain.answer.model_dump(mode="json"),
        "refusal": chain.refusal.model_dump(mode="json") if chain.refusal else None,
        "end": chain.end,
        "error": chain.error,
        "replans": chain.replans,
        "count": chain.count,
        "latency_ms": latency,
        "calls": [
            {
                "replan": c.replan,
                "latency_ms": c.latency_ms,
                "prompt_tokens": c.tokens.prompt,
                "completion_tokens": c.tokens.completion,
                "outcome": c.outcome,
            }
            for c in chain.calls
        ],
        "steps": [
            {
                "position": s.position,
                "tool": s.tool,
                "arguments": s.arguments,
                "status": s.status,
                "count": s.count,
                "code": s.code,
                "duration_ms": s.duration_ms,
                "replan": s.replan,
            }
            for s in chain.steps
        ],
    }


ASK = {"direct": ask_direct, "chain": ask_chain}


def total(values: Iterable[int | None]) -> int | None:
    """The values added up; ``None`` when none was reported."""
    known = [v for v in values if v is not None]
    return sum(known) if known else None


def cost(records: list[dict[str, Any]]) -> list[str]:
    """Median latency and mean tokens over the answers that have them."""
    found = []
    for key, name, average in [
        ("latency_ms", "latency median {:.0f} ms", statistics.median),
        ("prompt_tokens", "prompt {:.0f} tokens", statistics.mean),
        ("completion_tokens", "answer {:.0f} tokens", statistics.mean),
    ]:
        values = [r[key] for r in records if r.get(key) is not None]
        found.append(name.format(average(values)) if values else name.split(" {")[0] + " -")
    errors = sum(r["verdict"].startswith("error:") for r in records)
    return [*found, f"{errors} errors"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--url", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--api-key-env",
        metavar="NAME",
        help="the API key from this environment variable; the run names it, never its value",
    )
    parser.add_argument(
        "--effort", default="none", choices=["default", "none", "low", "medium", "high"]
    )
    parser.add_argument("--temperature", type=float, default=0)
    parser.add_argument(
        "--repeat",
        type=int,
        default=3,
        help="runs per case; seeds start..start+N-1, so repeats differ",
    )
    parser.add_argument(
        "--seed-start", type=int, default=1, help="first seed; another start measures the noise"
    )
    parser.add_argument("--only", help="comma-separated case ids")
    parser.add_argument(
        "--cases",
        default="cases",
        metavar="NAME",
        choices=list(CASE_FILES),
        help="cases (the tuning split of schema/eval-cases, default) or heldout (confirmation); "
        "chain or chain-heldout for the chain's cases (chain-cases.json)",
    )
    parser.add_argument(
        "--approach",
        default="direct",
        choices=list(ASK),
        help="direct (default) or chain: the tool chain, run to its end as at Automatisch "
        "(docs/plan-chain-eval.md)",
    )
    parser.add_argument(
        "--no-format",
        action="store_true",
        help="no constrained output; the schema only as text in the prompt (H-8; "
        "the prompt profile's output 'text')",
    )
    parser.add_argument("--label", default="run")
    parser.add_argument(
        "--no-examples",
        action="store_true",
        help="leave the prompt's examples section out, rules included (to measure it)",
    )
    parser.add_argument(
        "--variant",
        default="p0",
        choices=sorted(VARIANTS),
        help="how the messages are written (docs/testplan-system-context.md, 5): p0, p5 and "
        "p9 by the application's builder, the others rebuilt from p0 (measurement only)",
    )
    parser.add_argument(
        "--examples",
        metavar="NAME",
        help="an example set in place of the prompt's examples section: 12 the "
        "application's (builder), any other examples/NAME.txt",
    )
    parser.add_argument(
        "--profile",
        default="full",
        choices=list(PROFILES),
        help="strip metadata from the layer profile (docs/testplan-system-context.md, Phase 4)",
    )
    parser.add_argument(
        "--show",
        action="store_true",
        help="print the messages of the first case as they would be sent, and stop",
    )
    args = parser.parse_args()
    if args.no_examples and (args.examples or args.variant != "p0"):
        parser.error("--no-examples takes neither --examples nor a variant")
    chain = args.approach == "chain"
    if chain and (args.no_examples or args.examples or args.variant != "p0" or args.no_format):
        # The chain keeps the default prompt until it is evaluated (plan E3, 9).
        parser.error("--approach chain takes no prompt variant, examples or --no-format yet")
    in_app = args.examples in APP_EXAMPLES
    examples = (
        ""
        if args.no_examples
        else load_examples(args.examples)
        if args.examples and not in_app
        else None
    )
    variant = VARIANTS[args.variant]
    # What the application's builder writes (plan E3, D9): same options, same prompt.
    written = prompt_profile(args.variant, args.examples, args.no_format)
    api_key = None
    if args.api_key_env:
        api_key = os.environ.get(args.api_key_env)
        if not api_key:
            parser.error(f"--api-key-env: {args.api_key_env} is not set")

    cases = load_cases(args.cases)
    if args.only:
        cases = [c for c in cases if c.id in args.only.split(",")]
    # A case that wants this approach offered as the other one says nothing of it.
    left_out = [c.id for c in cases if c.other_approach == args.approach]
    cases = [c for c in cases if c.id not in left_out]
    if left_out:
        print(f"left out, they offer {args.approach} as the other approach: {', '.join(left_out)}")

    built = build_sample(Settings(), prefix="geotandem-eval-", profile=args.profile)
    engine, backend = built.engine, built.backend
    profile = model_profile(engine, backend.layer_names())
    level = next(lv for lv in load_levels(engine) if lv.is_default)
    context = ToolContext(backend=backend, limits=LIMITS)

    def build(text: str) -> Prompt:
        """The prompt of ``text`` as this run sends it: the builder's after the
        prompt profile, then an example set of this directory, then a
        measurement-only variant. The chain's as the application writes it."""
        if chain:
            return build_prompt(text, approach="chain", level=level, profile=profile)
        prompt = direct_prompt(text, level=level, profile=profile, prompt_profile=written)
        messages = variant(with_examples(list(prompt.messages), examples))
        return replace(prompt, messages=tuple(messages))

    if args.show:
        for message in build(cases[0].prompt).messages:
            print(f"===== {message.role} ({len(message.content)} chars)\n{message.content}\n")
        return 0
    # Over the prompt of a placeholder question: one hash names the run's
    # template, whatever the cases (H-5).
    template = build("{prompt}")

    out = HERE / "results" / f"{datetime.now():%Y%m%d-%H%M%S}-{args.label}.jsonl"
    out.parent.mkdir(exist_ok=True)
    tally: dict[str, Counter[str]] = {}
    records: list[dict[str, Any]] = []
    started = time.monotonic()
    with out.open("w", encoding="utf-8") as log:
        header = {
            "label": args.label,
            "model": args.model,
            "host": host_of(args.url),
            "api_key_env": args.api_key_env,
            "effort": args.effort,
            "variant": args.variant,
            "cases": args.cases,
            "format": "text" if args.no_format else "constrained",
            "examples": "none" if args.no_examples else args.examples or "default",
            "profile": args.profile,
            "profile_sha256": profile.hash,
            "prompt_sha256": prompt_hash(list(template.messages), template.schema),
            "messages": [m.role for m in template.messages],
            "temperature": args.temperature,
            "seeds": [args.seed_start, args.seed_start + args.repeat - 1],
            "level": level.name,
            "approach": args.approach,
        }
        if chain:
            header["replan_sha256"] = replan_hash()
        log.write(json.dumps(header) + "\n")
        world = World(context, profile, level)
        for case in cases:
            tally[case.id] = Counter()
            # Checked and read once per case, as a run of the application does.
            readings = reading_ids(case, context, profile)
            for seed in range(args.seed_start, args.seed_start + args.repeat):
                endpoint = Endpoint(
                    base_url=args.url,
                    model=args.model,
                    api_key=api_key,
                    seed=seed,
                    temperature=args.temperature,
                    timeout_s=300,
                    reasoning_effort=args.effort,
                )
                prompt = build(case.prompt)
                record: dict[str, Any] = {"case": case.id, "seed": seed}
                client = Recording(endpoint)
                try:
                    graded_as, kept = ASK[args.approach](client, prompt, case, world, readings)
                    verdict = graded_as.tag
                    record |= kept
                    if graded_as.flags:
                        record["flags"] = list(graded_as.flags)
                except LLMError as exc:
                    verdict = errored(exc.code).tag
                    record |= {"cause": exc.cause, "retries": exc.retries}
                except ActionError as exc:
                    verdict = errored(exc.code).tag
                    record["details"] = exc.details
                finally:
                    client.close()
                if (completion := client.last) is not None:
                    # A chain's tokens are its calls' together (``calls`` has each).
                    record |= {
                        "prompt_tokens": total(c.prompt_tokens for c in client.completions),
                        "completion_tokens": total(c.completion_tokens for c in client.completions),
                        "finish_reason": completion.finish_reason,
                    }
                    if verdict.startswith("error:"):
                        record |= {"latency_ms": completion.latency_ms, "raw": completion.text}
                record["verdict"] = verdict
                records.append(record)
                log.write(json.dumps(record, ensure_ascii=False) + "\n")
                tally[case.id][verdict] += 1
                print(f"{case.id:<32} seed {seed}  {verdict}", flush=True)

    runs = sum(sum(c.values()) for c in tally.values())
    passed = sum(c[PASS.tag] for c in tally.values())
    print(
        f"\n{args.label} · {args.model} · effort {args.effort} · {args.approach} · "
        f"{args.variant} · {passed}/{runs} passed · {time.monotonic() - started:.0f} s · {out}"
    )
    print("  " + " · ".join(cost(records)))
    for case_id, counts in tally.items():
        rest = ", ".join(f"{k} x{n}" for k, n in counts.items() if k != PASS.tag)
        print(f"  {counts[PASS.tag]}/{sum(counts.values())}  {case_id:<32} {rest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
