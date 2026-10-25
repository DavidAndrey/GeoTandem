"""Grade the stored answers of runs again against the current cases.

    uv run python evals/regrade.py x-p0-sonnet p0-gemma4_12b p0-gemma4_12b-s6

A case changed (a second fair reading in ``gold_any``) needs no new model
call: each answer is checked and graded as ``run.py`` does, over a fresh
sample dataset, and the run is written again as ``results/<time>-<label>.jsonl``
with ``regraded_from`` in its header, so ``compare.py`` takes it as the newest.
Answers that were errors stay errors, except an unreadable one the parser
now reads (its verbatim ``raw``, H-4).
"""

import json
import sys
from datetime import datetime

from casefiles import load_cases
from compare import newest
from run import HERE, LIMITS

from geotandem.catalog import ModelProfile, model_profile
from geotandem.config import Settings
from geotandem.data.spatialite import SpatiaLiteBackend
from geotandem.evaluation.grade import grade, reading_ids
from geotandem.evaluation.sample import build_sample
from geotandem.llm import Completion
from geotandem.model.errors import ActionError
from geotandem.model.result import parse_answer
from geotandem.model.schemas import QueryAnswer
from geotandem.model.validate import Validated, validate_model_query
from geotandem.tools import ToolContext


def main() -> int:
    labels = sys.argv[1:]
    if not labels:
        raise SystemExit(__doc__)
    worlds: dict[str, tuple[SpatiaLiteBackend, ModelProfile, ToolContext]] = {}

    def world(mode: str) -> tuple[SpatiaLiteBackend, ModelProfile, ToolContext]:
        """The sample with the metadata the run's model saw (``--profile``, Phase 4):
        an answer is checked against the profile it was given, not the full one."""
        if mode not in worlds:
            built = build_sample(Settings(), prefix="geotandem-regrade-", profile=mode)
            backend = built.backend
            profile = model_profile(built.engine, backend.layer_names())
            worlds[mode] = backend, profile, ToolContext(backend=backend, limits=LIMITS)
        return worlds[mode]

    for label in labels:
        source = newest(label)
        lines = source.read_text("utf-8").splitlines()
        header = json.loads(lines[0])
        backend, profile, context = world(header.get("profile") or "full")
        cases = {c.id: c for c in load_cases(header.get("cases") or "cases")}
        # Checked and read once per case, as a run does.
        readings = {c.id: reading_ids(c, context, profile) for c in cases.values()}
        out = HERE / "results" / f"{datetime.now():%Y%m%d-%H%M%S}-{label}.jsonl"
        changed = 0
        with out.open("w", encoding="utf-8") as log:
            log.write(json.dumps(header | {"regraded_from": source.name}) + "\n")
            for line in lines[1:]:
                record = json.loads(line)
                answer = None
                if record.get("answer") is not None:
                    answer = parse_answer(Completion(text=json.dumps(record["answer"])), "direct")
                elif record["verdict"] == "error:model_unreadable" and record.get("raw"):
                    # Read again: the parser may have learnt to read it (X-7, X-10).
                    try:
                        answer = parse_answer(Completion(text=record["raw"]), "direct")
                        record["answer"] = answer.model_dump(mode="json")
                    except ActionError:
                        pass
                if answer is not None:
                    query = refusal = None
                    if isinstance(answer, QueryAnswer):
                        checked = validate_model_query(answer.query, context, profile)
                        if isinstance(checked, Validated):
                            query = checked.query
                        else:
                            refusal = checked
                    case = cases[record["case"]]
                    graded = grade(case, answer, refusal, query, backend, LIMITS, readings[case.id])
                    verdict = graded.tag
                    changed += verdict != record["verdict"]
                    record["verdict"] = verdict
                log.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(f"{label}: {changed} verdicts changed · {out.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
