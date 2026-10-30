"""The cases across layers (``schema/eval-cases/layer-cases.json``,
docs/plan-improve-examples.md 6.3).

Each case names its template (``tpl:<shape>``), so the splits and the groups of
6.4 can be read from the file. Every reference passes the checks of a model's
query and finds something, less than its whole layer; that every condition
changes the result is held by ``test_eval_bearing.py``.
"""

import pytest

from geotandem.config import Settings
from geotandem.data import Limits
from geotandem.engine import ids_query
from geotandem.evaluation.cases import World, chain_set, layer_set, sample_world, start_set
from geotandem.evaluation.grade import query_of, reading_ids

LIMITS = Limits(max_features=10_000, timeout_s=10)
CASES = {case.id: case for case in layer_set()}


@pytest.fixture(scope="module")
def world() -> World:
    return sample_world(Settings(), LIMITS)


def test_the_ids_are_their_own_and_every_case_names_one_template() -> None:
    assert len(CASES) == len(layer_set())
    assert not set(CASES) & {c.id for c in (*start_set(), *chain_set())}
    for case in CASES.values():
        assert len([t for t in case.tags if t.startswith("tpl:")]) == 1, case.id
        assert case.readings(), case.id


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_every_reference_passes_the_checks_and_finds_less_than_its_layer(
    case_id: str, world: World
) -> None:
    case = CASES[case_id]
    backend = world.context.backend
    whole = len(ids_query(query_of({"source": case.readings()[0]["source"]}, "2"), backend, LIMITS))
    for found in reading_ids(case, world.context, world.profile) or []:
        assert 0 < len(found) < whole
