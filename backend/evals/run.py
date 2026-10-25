"""Ask a real model the questions of the start set and grade its answers.

The direct query as the prompt flow sends it (``direct_prompt``,
``DirectQuery.ask``: the real client, parser and checks), over a fresh sample
dataset and the default level; only the grading is the harness's own. See
``evals/README.md``.

    uv run python evals/run.py --model qwen3:8b --label baseline
    uv run python evals/run.py --model qwen3:8b --variant p9 --label p9-qwen3
"""

import argparse
import json
import os
import statistics
import sys
import time
from collections import Counter
from collections.abc import Sequence
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any

from casefiles import CASE_FILES, load_cases
from variants import VARIANTS, load_examples, prompt_hash, with_examples

from geotandem.catalog import model_profile
from geotandem.config import Settings
from geotandem.data import Limits
from geotandem.evaluation.grade import PASS, errored, grade, reading_ids
from geotandem.evaluation.profiles import PROFILES
from geotandem.evaluation.sample import build_sample
from geotandem.levels.store import load_levels
from geotandem.llm import Completion, Endpoint, LLMError, Message
from geotandem.llm.hosts import host_of
from geotandem.llm.openai_compat import OpenAICompatClient
from geotandem.model.direct import DirectQuery, direct_prompt
from geotandem.model.errors import ActionError
from geotandem.model.prompt import Prompt
from geotandem.tools import ToolContext

HERE = Path(__file__).parent
LIMITS = Limits(max_features=10_000, timeout_s=10)


class Recording(OpenAICompatClient):
    """The real client, keeping its last completion: tokens for every answer
    (H-3), the verbatim text when the answer does not read (H-4). With
    ``text_only`` the schema is not sent as constrained output; the prompt
    still holds it as text, as for an endpoint that ignores it (H-8)."""

    last: Completion | None = None
    text_only = False

    def complete(self, messages: Sequence[Message], **kwargs: Any) -> Completion:
        self.last = None
        if self.text_only:
            kwargs["schema"] = None
        self.last = super().complete(messages, **kwargs)
        return self.last


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
        help="cases (the tuning split of schema/eval-cases, default) or heldout (confirmation)",
    )
    parser.add_argument(
        "--no-format",
        action="store_true",
        help="no constrained output; the schema only as text in the prompt (H-8)",
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
        help="how the messages are rebuilt (docs/testplan-system-context.md, 5)",
    )
    parser.add_argument(
        "--examples",
        metavar="NAME",
        help="examples/NAME.txt in place of the prompt's examples section",
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
    examples = "" if args.no_examples else load_examples(args.examples) if args.examples else None
    variant = VARIANTS[args.variant]
    api_key = None
    if args.api_key_env:
        api_key = os.environ.get(args.api_key_env)
        if not api_key:
            parser.error(f"--api-key-env: {args.api_key_env} is not set")

    cases = load_cases(args.cases)
    if args.only:
        cases = [c for c in cases if c.id in args.only.split(",")]

    built = build_sample(Settings(), prefix="geotandem-eval-", profile=args.profile)
    engine, backend = built.engine, built.backend
    profile = model_profile(engine, backend.layer_names())
    level = next(lv for lv in load_levels(engine) if lv.is_default)
    context = ToolContext(backend=backend, limits=LIMITS)

    def build(text: str) -> Prompt:
        """The prompt of ``text`` as this run sends it: examples, then variant."""
        prompt = direct_prompt(text, level=level, profile=profile)
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
        }
        log.write(json.dumps(header) + "\n")
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
                client.text_only = args.no_format
                try:
                    found = DirectQuery(client, context, level).ask(prompt, profile=profile)
                    verdict = grade(
                        case, found.answer, found.refusal, found.query, backend, LIMITS, readings
                    ).tag

                    record |= {
                        "answer": found.answer.model_dump(mode="json"),
                        "refusal": found.refusal.model_dump(mode="json") if found.refusal else None,
                        "latency_ms": found.latency_ms,
                    }
                except LLMError as exc:
                    verdict = errored(exc.code).tag
                    record |= {"cause": exc.cause, "retries": exc.retries}
                except ActionError as exc:
                    verdict = errored(exc.code).tag
                    record["details"] = exc.details
                finally:
                    client.close()
                if (completion := client.last) is not None:
                    record |= {
                        "prompt_tokens": completion.prompt_tokens,
                        "completion_tokens": completion.completion_tokens,
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
        f"\n{args.label} · {args.model} · effort {args.effort} · {args.variant} · "
        f"{passed}/{runs} passed · {time.monotonic() - started:.0f} s · {out}"
    )
    print("  " + " · ".join(cost(records)))
    for case_id, counts in tally.items():
        rest = ", ".join(f"{k} x{n}" for k, n in counts.items() if k != PASS.tag)
        print(f"  {counts[PASS.tag]}/{sum(counts.values())}  {case_id:<32} {rest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
