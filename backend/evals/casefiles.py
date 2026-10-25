"""The start set the harness asks (plan E3, D2): ``schema/eval-cases/``.

The harness keeps its names: ``cases`` is the tuning split, ``heldout`` the
confirmation split, so ``--cases`` and the result files of the testplans read
as before. A case is read as the application reads it (``EvalCase``), so the
harness and a run grade the same case.
"""

import json
from pathlib import Path

from geotandem.evaluation.schemas import EvalCase

SCHEMA = Path(__file__).resolve().parents[2] / "schema" / "eval-cases"
CASE_FILES = {"cases": "start-tuning", "heldout": "start-confirm"}


def load_cases(name: str) -> list[EvalCase]:
    """The cases of the harness file ``name`` (``cases`` or ``heldout``)."""
    cases = json.loads((SCHEMA / f"{CASE_FILES[name]}.json").read_text("utf-8"))["cases"]
    return [EvalCase.model_validate(case) for case in cases]
