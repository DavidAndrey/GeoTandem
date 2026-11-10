"""The cases on units and keys (``schema/eval-cases/metadata-cases.json``,
docs/plan-attribute-metadata.md A1).

Their ids are their own, both splits hold each kind, and every reference passes
the checks of a model's query and finds something, less than its whole layer,
in every ablation mode it is asked under. A unit case's reference finds
something the question's number read in the attribute's unit does not.
"""

import pytest

from geotandem.config import Settings
from geotandem.data import Limits
from geotandem.engine import ids_query
from geotandem.evaluation.cases import (
    World,
    behaviour_set,
    chain_set,
    layer_set,
    metadata_set,
    sample_world,
    start_set,
)
from geotandem.evaluation.grade import query_of, reading_ids

LIMITS = Limits(max_features=10_000, timeout_s=10)
CASES = {case.id: case for case in metadata_set()}
KINDS = ("unit", "key", "key-value")


@pytest.fixture(scope="module")
def world() -> World:
    return sample_world(Settings(), LIMITS)


def test_the_ids_are_their_own_and_each_split_holds_each_kind() -> None:
    assert len(CASES) == len(metadata_set()) == 8
    others = (*start_set(), *chain_set(), *layer_set(), *behaviour_set())
    assert not set(CASES) & {c.id for c in others}
    for split in ("tuning", "confirm"):
        tags = {t for c in CASES.values() if c.split == split for t in c.tags}
        assert set(KINDS) <= tags, split
    for case in CASES.values():
        assert len(set(KINDS) & set(case.tags)) == 1, case.id
        assert case.gold is not None, case.id


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_every_reference_passes_the_checks_and_finds_less_than_its_layer(
    case_id: str, world: World
) -> None:
    case = CASES[case_id]
    backend = world.context.backend
    whole = len(ids_query(query_of({"source": case.readings()[0]["source"]}, "2"), backend, LIMITS))
    for found in reading_ids(case, world.context, world.profile) or []:
        assert 0 < len(found) < whole


UNCONVERTED = {
    "md01-hektaren": {"op": "compare", "attr": "flaeche_km2", "cmp": "gt", "value": 2000},
    "md02-meter": {"op": "compare", "attr": "laenge_km", "cmp": "gt", "value": 10_000},
    "md05-quadratmeter": {"op": "compare", "attr": "flaeche_km2", "cmp": "lt", "value": 3_000_000},
    "md06-hektaren-bereich": {"op": "between", "attr": "flaeche_km2", "min": 500, "max": 1000},
}
"""Each unit case's number taken as it stands: a model that ignores the unit."""


def test_a_unit_case_fails_a_model_that_ignores_the_unit(world: World) -> None:
    assert set(UNCONVERTED) == {c.id for c in CASES.values() if "unit" in c.tags}
    backend = world.context.backend
    for case_id, where in UNCONVERTED.items():
        gold = CASES[case_id].readings()[0]
        right = ids_query(query_of(gold, "2"), backend, LIMITS)
        unconverted = query_of({"source": gold["source"], "where": where}, "2")
        wrong = ids_query(unconverted, backend, LIMITS)
        assert sorted(wrong) != sorted(right), case_id
