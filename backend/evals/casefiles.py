"""The start set the harness asks (plan E3, D2): ``schema/eval-cases/``.

The harness keeps its names: ``cases`` is the tuning split, ``heldout`` the
confirmation split, so ``--cases`` and the result files of the testplans read
as before. The cases are read by the application's own reader
(``evaluation.cases.start_set``), so the harness and a run grade the same case.

``chain`` and ``chain-heldout`` are the two splits of the chain's cases
(``chain-cases.json``, docs/plan-chain-eval.md 4), read by
``evaluation.cases.chain_set``; they are not part of the start set.

``layers`` and ``layers-heldout`` are the two splits of the cases across
layers (``layer-cases.json``, docs/plan-improve-examples.md 6.3), read by
``evaluation.cases.layer_set``.
"""

from geotandem.evaluation.cases import chain_set, layer_set, start_set
from geotandem.evaluation.schemas import EvalCase, Split

CASE_FILES: dict[str, Split] = {
    "cases": "tuning",
    "heldout": "confirm",
    "chain": "tuning",
    "chain-heldout": "confirm",
    "layers": "tuning",
    "layers-heldout": "confirm",
}
CHAIN_FILES = frozenset({"chain", "chain-heldout"})
LAYER_FILES = frozenset({"layers", "layers-heldout"})


def load_cases(name: str) -> list[EvalCase]:
    """The cases of the harness file ``name`` (``cases``, ``heldout``, ``chain``,
    ``chain-heldout``, ``layers`` or ``layers-heldout``)."""
    if name in CHAIN_FILES:
        found = chain_set()
    elif name in LAYER_FILES:
        found = layer_set()
    else:
        found = start_set()
    return [case for case in found if case.split == CASE_FILES[name]]
