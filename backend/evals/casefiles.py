"""The start set the harness asks (plan E3, D2): ``schema/eval-cases/``.

The harness keeps its names: ``cases`` is the tuning split, ``heldout`` the
confirmation split, so ``--cases`` and the result files of the testplans read
as before. The cases are read by the application's own reader
(``evaluation.cases.start_set``), so the harness and a run grade the same case.
"""

from geotandem.evaluation.cases import start_set
from geotandem.evaluation.schemas import EvalCase, Split

CASE_FILES: dict[str, Split] = {"cases": "tuning", "heldout": "confirm"}


def load_cases(name: str) -> list[EvalCase]:
    """The cases of the harness file ``name`` (``cases`` or ``heldout``)."""
    return [case for case in start_set() if case.split == CASE_FILES[name]]
