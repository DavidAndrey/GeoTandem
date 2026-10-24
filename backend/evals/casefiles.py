"""The start set the harness asks (plan E3, D2): ``schema/eval-cases/``.

The harness keeps its names: ``cases`` is the tuning split, ``heldout`` the
confirmation split, so ``--cases`` and the result files of the testplans read
as before.
"""

import json
from pathlib import Path
from typing import Any

SCHEMA = Path(__file__).resolve().parents[2] / "schema" / "eval-cases"
CASE_FILES = {"cases": "start-tuning", "heldout": "start-confirm"}


def load_cases(name: str) -> list[dict[str, Any]]:
    """The cases of the harness file ``name`` (``cases`` or ``heldout``)."""
    cases: list[dict[str, Any]] = json.loads(
        (SCHEMA / f"{CASE_FILES[name]}.json").read_text("utf-8")
    )["cases"]
    return cases
