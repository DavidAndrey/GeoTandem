"""Signatures and the groups of the measurement (docs/plan-improve-examples.md
6.4; ``evaluation/signature.py``).

The groups are fixed before the runs: their sizes over every confirm case are
pinned here, so a case added to the pool or the confirm split shows up as a
change of this test, not as a quiet shift in the measurement. Each group has
at least 8 confirm cases. The copies across the splits are the three the sets
held before the check; the measurement of examples leaves them out.
"""

from collections import Counter
from typing import Any

from geotandem.evaluation.cases import chain_set, layer_set, start_set
from geotandem.evaluation.signature import copies, group, signature

CASES = (*start_set(), *chain_set(), *layer_set())
POOL = [case for case in CASES if case.split == "tuning"]
CONFIRM = [case for case in CASES if case.split == "confirm"]

GROUPS = {1: 57, 2: 11, 3: 14, 4: 12, None: 12}
"""Group sizes over the confirm cases; ``None`` are the behaviour cases."""
COPIES = [
    ("h29-english-french", "attr-franzoesisch"),
    ("kb08-weit-weg-von-bahn", "doc3-weit-von-bahn"),
    ("kb16-schulen-puffer-national", "dist-nationalstrasse"),
]

SEK = {"op": "compare", "attr": "sekundarstufe", "cmp": "eq", "value": True}
BAHN = {"op": "compare", "attr": "verkehrsmittel", "cmp": "eq", "value": "bahn"}


def schools(distance: int) -> dict[str, Any]:
    """Schools with Sekundarstufe I, not in a municipality, near a rail stop."""
    near = {
        "op": "related",
        "layer": "haltestellen",
        "predicate": "dwithin",
        "distance_m": distance,
        "where": BAHN,
    }
    outside = {"op": "not", "arg": {"op": "related", "layer": "gemeinden", "predicate": "within"}}
    return {"source": "schulen", "where": {"op": "and", "args": [SEK, outside, near]}}


def test_a_signature_has_layers_and_shape_without_values() -> None:
    found = signature(schools(300))
    assert found.layers == ("schulen", ("gemeinden", "haltestellen"))
    assert found.shape == (True, ((False, "dwithin", True), (True, "within", False)))
    assert signature(schools(500)).shape == found.shape
    assert signature(schools(500)).full != found.full


def test_the_groups_are_as_fixed_before_the_runs() -> None:
    sizes = Counter(group(case, POOL) for case in CONFIRM)
    assert dict(sizes) == GROUPS
    assert all(n >= 8 for g, n in GROUPS.items() if g is not None)


def test_no_confirm_case_copies_a_pool_case_but_the_three_known() -> None:
    assert copies(CONFIRM, POOL) == COPIES
