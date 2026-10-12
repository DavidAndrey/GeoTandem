"""Ask a real model the questions of ``cases.json`` and grade its answers.

The direct query as the prompt flow sends it (``direct_prompt``,
``DirectQuery.ask``: the real client, parser and checks), over a fresh sample
dataset and the default level; only the grading is the harness's own. See
``evals/README.md``.

    uv run python evals/run.py --model qwen3:8b --label baseline
"""

import argparse
import json
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from geotandem.catalog import model_profile
from geotandem.config import Settings
from geotandem.data import Limits
from geotandem.data.spatialite import SpatiaLiteBackend
from geotandem.db.bootstrap import bootstrap
from geotandem.engine import ids_query
from geotandem.levels.store import load_levels
from geotandem.llm import Endpoint, LLMError
from geotandem.llm.openai_compat import OpenAICompatClient
from geotandem.model import prompt as prompt_module
from geotandem.model.direct import DirectQuery, direct_prompt
from geotandem.model.errors import ActionError
from geotandem.model.schemas import QueryAnswer
from geotandem.sample.load import load_sample
from geotandem.tools import ToolContext
from geotandem_query import QueryObject

HERE = Path(__file__).parent
LIMITS = Limits(max_features=10_000, timeout_s=10)
PASS = "pass"


def query_of(doc: dict[str, Any]) -> QueryObject:
    return QueryObject.model_validate({"schema_version": "2", "output": "map", **doc})


def conditions(node: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Every condition of a where tree, a relation's own filter included."""
    if not node:
        return []
    found = [node]
    for child in [*node.get("args", []), node.get("arg"), node.get("where")]:
        found += conditions(child)
    return found


def matches(want: dict[str, Any], got: dict[str, Any]) -> bool:
    for key, value in want.items():
        if key == "distance_m":
            low, high = value
            if not low <= (got.get(key) or 0) <= high:
                return False
        elif got.get(key) != value:
            return False
    return True


def grade(
    case: dict[str, Any],
    answer: Any,
    refusal: Any,
    query: QueryObject | None,
    backend: SpatiaLiteBackend,
) -> str:
    """``pass``, or the first thing that went wrong, as a short tag."""
    said = json.dumps(answer.model_dump(mode="json"), ensure_ascii=False).casefold()
    for word in case.get("forbid", []):
        if word.casefold() in said:
            return f"forbidden:{word}"
    if answer.kind in case.get("also", []):
        return PASS
    if "expect" in case:
        if answer.kind != case["expect"]:
            return f"kind:{answer.kind}"
        if "other_approach" in case and answer.other_approach != case["other_approach"]:
            return f"other_approach:{answer.other_approach}"
        return PASS
    if not isinstance(answer, QueryAnswer):
        return f"kind:{answer.kind}"
    if refusal is not None:
        return f"refused:{refusal.code}"
    assert query is not None
    if "gold" in case:
        want = ids_query(query_of(case["gold"]), backend, LIMITS)
        got = ids_query(query, backend, LIMITS)
        return PASS if got == want else f"wrong:{len(got)}≠{len(want)}"
    need = case["require"]
    if query.source != need["source"]:
        return f"wrong:source={query.source}"
    present = conditions(query.model_dump(mode="json", exclude_none=True).get("where"))
    for want_condition in need["conditions"]:
        if not any(matches(want_condition, c) for c in present):
            return f"wrong:missing {want_condition['op']}"
    return PASS


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--url", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--effort", default="none", choices=["default", "none", "low", "medium", "high"]
    )
    parser.add_argument("--temperature", type=float, default=0)
    parser.add_argument(
        "--repeat", type=int, default=3, help="runs per case; seeds 1..N, so repeats differ"
    )
    parser.add_argument("--only", help="comma-separated case ids")
    parser.add_argument("--label", default="run")
    parser.add_argument(
        "--no-examples",
        action="store_true",
        help="leave the prompt's worked examples out (to measure them)",
    )
    args = parser.parse_args()
    if args.no_examples:
        prompt_module._EXAMPLES.clear()

    cases = json.loads((HERE / "cases.json").read_text("utf-8"))["cases"]
    if args.only:
        cases = [c for c in cases if c["id"] in args.only.split(",")]

    settings = Settings(data_dir=Path(tempfile.mkdtemp(prefix="geotandem-eval-")))
    engine = bootstrap(settings)
    backend = SpatiaLiteBackend(engine, settings.internal_crs)
    load_sample(backend)
    profile = model_profile(engine, backend.layer_names())
    level = next(lv for lv in load_levels(engine) if lv.is_default)
    context = ToolContext(backend=backend, limits=LIMITS)

    out = HERE / "results" / f"{datetime.now():%Y%m%d-%H%M%S}-{args.label}.jsonl"
    out.parent.mkdir(exist_ok=True)
    tally: dict[str, Counter[str]] = {}
    started = time.monotonic()
    with out.open("w", encoding="utf-8") as log:
        header = {
            "label": args.label,
            "model": args.model,
            "effort": args.effort,
            "examples": not args.no_examples,
            "temperature": args.temperature,
            "level": level.name,
        }
        log.write(json.dumps(header) + "\n")
        for case in cases:
            tally[case["id"]] = Counter()
            for seed in range(1, args.repeat + 1):
                endpoint = Endpoint(
                    base_url=args.url,
                    model=args.model,
                    seed=seed,
                    temperature=args.temperature,
                    timeout_s=300,
                    reasoning_effort=args.effort,
                )
                prompt = direct_prompt(case["prompt"], level=level, profile=profile)
                record: dict[str, Any] = {"case": case["id"], "seed": seed}
                client = OpenAICompatClient(endpoint)
                try:
                    found = DirectQuery(client, context, level).ask(prompt, profile=profile)
                    verdict = grade(case, found.answer, found.refusal, found.query, backend)
                    record |= {
                        "answer": found.answer.model_dump(mode="json"),
                        "refusal": found.refusal.model_dump(mode="json") if found.refusal else None,
                        "latency_ms": found.latency_ms,
                    }
                except (LLMError, ActionError) as exc:
                    verdict = f"error:{exc.code}"
                finally:
                    client.close()
                record["verdict"] = verdict
                log.write(json.dumps(record, ensure_ascii=False) + "\n")
                tally[case["id"]][verdict] += 1
                print(f"{case['id']:<32} seed {seed}  {verdict}", flush=True)

    runs = sum(sum(c.values()) for c in tally.values())
    passed = sum(c[PASS] for c in tally.values())
    print(
        f"\n{args.label} · {args.model} · effort {args.effort} · "
        f"{passed}/{runs} passed · {time.monotonic() - started:.0f} s · {out}"
    )
    for case_id, counts in tally.items():
        rest = ", ".join(f"{k} x{n}" for k, n in counts.items() if k != PASS)
        print(f"  {counts[PASS]}/{sum(counts.values())}  {case_id:<32} {rest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
