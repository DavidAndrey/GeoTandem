"""Load-bearing conditions (plan-improve-examples 6.1, 6.3; ``evaluation/bearing.py``).

Every condition of every reference must change the result on the sample data,
or a case passes an answer that drops it. The cases measured before the check
existed keep their idle conditions (they stay as they were measured, Lauf 1-13)
and are listed here; a new or edited case must not add one, and a listed case
that is fixed must leave the list.
"""

import pytest

from geotandem.data import DataBackend, Limits
from geotandem.evaluation.bearing import idle_conditions, label, without_one
from geotandem.evaluation.cases import chain_set, layer_set, start_set

LIMITS = Limits(max_features=10_000, timeout_s=10)
CASES = {case.id: case for case in (*start_set(), *chain_set(), *layer_set())}

IDLE = {
    # Without the bus condition, the same 11 schools in Köniz.
    "kb04-koeniz-nahe-bus": ["related dwithin haltestellen", "verkehrsmittel eq bus"],
    # Every cable car station lies within 1 km of a school.
    "kb15-seilbahn-nahe-schule": ["related dwithin schulen"],
    # Near a stop of any kind is near a bus stop here.
    "kb24-sek-klein-nahe-bus": ["verkehrsmittel eq bus"],
    # One branch of the «oder» adds no school.
    "doc6-verschachtelt": ["sprache eq de"],
    "h14-sek-kg-oder-gross": ["standorte gt 3"],
}

SEK = {"op": "compare", "attr": "sekundarstufe", "cmp": "eq", "value": True}
BUS = {"op": "compare", "attr": "verkehrsmittel", "cmp": "eq", "value": "bus"}
NEAR_BUS = {
    "op": "related",
    "layer": "haltestellen",
    "predicate": "dwithin",
    "distance_m": 300,
    "where": BUS,
}


def test_every_condition_is_left_out_once() -> None:
    """An ``and`` of one becomes its argument; the relation inside the ``not``
    is the ``not`` itself, its filter is left out on its own."""
    near = {k: v for k, v in NEAR_BUS.items() if k != "where"}
    outside = {"op": "not", "arg": NEAR_BUS}
    found = list(without_one({"op": "and", "args": [SEK, outside]}))
    assert found == [
        (SEK, outside),
        (outside, SEK),
        (BUS, {"op": "and", "args": [SEK, {"op": "not", "arg": near}]}),
    ]
    assert [label(c) for c, _ in found] == ["sekundarstufe eq True", "not", "verkehrsmittel eq bus"]


def test_a_relation_is_left_out_with_its_filter_and_its_filter_alone() -> None:
    near = {k: v for k, v in NEAR_BUS.items() if k != "where"}
    assert list(without_one(NEAR_BUS)) == [(NEAR_BUS, None), (BUS, near)]


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_every_condition_of_a_reference_bears_load(case_id: str, sample: DataBackend) -> None:
    assert idle_conditions(CASES[case_id], sample, LIMITS) == IDLE.get(case_id, [])
