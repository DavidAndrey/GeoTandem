"""The examples a prompt may be given (docs/plan-improve-examples.md 5, D2 and
D6; ``evaluation/examples.py``).

On the sample data the shipped cases give the measurement's pool. An own case
joins it on its tuning split, on the prompt's world; on an external connection
only with a reference that holds no data contents. A layer the account cannot
see keeps every case on it out.
"""

from typing import Any

import pytest

from geotandem.config import Settings
from geotandem.data import Limits
from geotandem.evaluation.cases import World, sample_world
from geotandem.evaluation.examples import example_pool, shareable, shipped_cases
from geotandem.evaluation.schemas import EvalCase
from geotandem.model.pool import pool_hash

LIMITS = Limits(max_features=10_000, timeout_s=10)
MEASURED = "c8fd1b3e8b23a6f54fa9b979d43a724a4aea1c17"
"""The start of the pool's hash in every arm C run of the measurement."""

BAHN = {
    "op": "related",
    "layer": "haltestellen",
    "predicate": "dwithin",
    "distance_m": 300,
    "where": {"op": "compare", "attr": "verkehrsmittel", "cmp": "eq", "value": "bahn"},
}
PRIMAR = {"op": "compare", "attr": "typ", "cmp": "eq", "value": "primar"}
KOENIZ = {
    "op": "related",
    "layer": "gemeinden",
    "predicate": "within",
    "where": {"op": "compare", "attr": "name", "cmp": "eq", "value": "Köniz"},
}


def own(case_id: str, where: dict[str, Any], *, split: str = "tuning") -> EvalCase:
    return EvalCase.model_validate(
        {
            "id": case_id,
            "prompt": "Welche Schulen?",
            "tags": ["own"],
            "split": split,
            "origin": "authored",
            "data_state": "sample",
            "schema_version": "2",
            "gold": {"source": "schulen", "where": where},
        }
    )


CODED = own("own-primar-nahe-bahn", {"op": "and", "args": [PRIMAR, BAHN]})
"""Codes and a distance only: may go out."""
NAMED = own("own-schulen-koeniz", KOENIZ)
"""A municipality's name: a data content, local only."""


@pytest.fixture(scope="module")
def world() -> World:
    return sample_world(Settings(), LIMITS)


@pytest.fixture(scope="module")
def shipped() -> tuple[EvalCase, ...]:
    return shipped_cases(Settings())


def ids(pool: list[Any]) -> set[str]:
    return {e.case for e in pool}


def test_the_shipped_cases_give_the_measured_pool_on_every_connection(
    world: World, shipped: tuple[EvalCase, ...]
) -> None:
    local = example_pool((), world, "local", shipped)
    assert len(local) == 62
    assert pool_hash(local).startswith(MEASURED)
    assert example_pool((), world, "external", shipped) == local


def test_an_own_case_goes_out_only_without_data_contents(
    world: World, shipped: tuple[EvalCase, ...]
) -> None:
    measured = ids(example_pool((), world, "local", shipped))
    local = ids(example_pool([CODED, NAMED], world, "local", shipped))
    external = ids(example_pool([CODED, NAMED], world, "external", shipped))
    assert local - measured == {CODED.id, NAMED.id}
    assert external - measured == {CODED.id}


def test_confirm_cases_and_shadowed_ids_never_join(
    world: World, shipped: tuple[EvalCase, ...]
) -> None:
    confirm = own("own-confirm", PRIMAR, split="confirm")
    taken = own("doc3-weit-von-bahn", PRIMAR)
    pool = example_pool([confirm, taken], world, "local", shipped)
    assert confirm.id not in ids(pool)
    start = next(e for e in pool if e.case == taken.id)
    assert start.question != taken.prompt


def test_a_layer_the_account_cannot_see_keeps_its_cases_out(
    world: World, shipped: tuple[EvalCase, ...]
) -> None:
    layers = [lp for lp in world.profile.layers if lp.name != "haltestellen"]
    hidden = World(
        world.data_state,
        world.context,
        world.profile.model_copy(update={"layers": layers}),
        world.versions,
    )
    pool = example_pool([CODED, NAMED], hidden, "local", shipped)
    assert CODED.id not in ids(pool)
    assert NAMED.id in ids(pool)
    for example in pool:
        named = [example.reading["source"], *(str(s["arguments"]) for s in example.plan)]
        assert not any("haltestellen" in text for text in named), example.case


@pytest.mark.parametrize(
    ("where", "out"),
    [
        (PRIMAR, True),
        ({"op": "compare", "attr": "kindergarten", "cmp": "eq", "value": True}, True),
        ({"op": "in", "attr": "typ", "values": ["primar", "sekundar"]}, True),
        ({"op": "between", "attr": "standorte", "min": 1, "max": 3}, True),
        ({"op": "not", "arg": {"op": "is_null", "attr": "name"}}, True),
        ({"op": "in", "attr": "typ", "values": ["primar", "Schule Wabern"]}, False),
        ({"op": "compare", "attr": "name", "cmp": "eq", "value": "Schule Wabern"}, False),
        ({"op": "text_match", "attr": "name", "text": "Wabern"}, False),
        ({"op": "near_feature", "layer": "gemeinden", "fid": 3, "distance_m": 0}, False),
        (KOENIZ, False),
        (BAHN, True),
    ],
)
def test_what_counts_as_data_contents(world: World, where: dict[str, Any], out: bool) -> None:
    assert shareable({"source": "schulen", "where": where}, world.profile) is out


def test_anything_beside_source_and_condition_stays_local(world: World) -> None:
    reading = {"source": "schulen", "where": PRIMAR, "limit": 5}
    assert not shareable(reading, world.profile)
