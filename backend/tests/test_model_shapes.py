"""Shapes that mean the same are written plain (testplan E-3)."""

from typing import Any

import pytest

from geotandem.data import DataBackend, Limits
from geotandem.engine import ids_query
from geotandem.model.shapes import COMPLEMENT, plain
from geotandem_query import QueryObject

LIMITS = Limits(10_000, 10)

A: dict[str, Any] = {"op": "compare", "attr": "typ", "cmp": "eq", "value": "primar"}
B: dict[str, Any] = {"op": "is_null", "attr": "name"}


def query(where: dict[str, Any]) -> QueryObject:
    return QueryObject.model_validate({"source": "schulen", "where": where})


def related(where: dict[str, Any]) -> dict[str, Any]:
    return {"op": "related", "layer": "gemeinden", "predicate": "within", "where": where}


@pytest.mark.parametrize(
    ("written", "meant"),
    [
        ({"op": "and", "args": [A]}, A),
        ({"op": "or", "args": [A]}, A),
        ({"op": "and", "args": [{"op": "or", "args": [{"op": "and", "args": [A]}]}]}, A),
        ({"op": "not", "arg": {"op": "not", "arg": A}}, A),
        (
            {"op": "not", "arg": {"op": "not", "arg": {"op": "not", "arg": A}}},
            {"op": "not", "arg": A},
        ),
        ({"op": "not", "arg": {"op": "and", "args": [A]}}, {"op": "not", "arg": A}),
        (
            {"op": "and", "args": [B, {"op": "or", "args": [A]}]},
            {"op": "and", "args": [B, A]},
        ),
        (related({"op": "and", "args": [A]}), related(A)),
        (related({"op": "not", "arg": A}), related({**A, "cmp": "ne"})),
        (
            related(
                {
                    "op": "not",
                    "arg": {"op": "compare", "attr": "flaeche_km2", "cmp": "lt", "value": 5},
                }
            ),
            related({"op": "compare", "attr": "flaeche_km2", "cmp": "ge", "value": 5}),
        ),
        (related({"op": "not", "arg": {"op": "and", "args": [A]}}), related({**A, "cmp": "ne"})),
    ],
)
def test_a_shape_that_means_the_same_is_written_plain(
    written: dict[str, Any], meant: dict[str, Any]
) -> None:
    assert plain(query(written)) == query(meant)


@pytest.mark.parametrize(
    "where",
    [
        A,
        {"op": "and", "args": [A, B]},
        {"op": "not", "arg": A},
        {"op": "and", "args": [A, {"op": "and", "args": [A, B]}]},  # a nested group stays
        related(A),
        related({"op": "not", "arg": B}),  # no comparison: the controls refuse it
        related({"op": "not", "arg": {"op": "in", "attr": "typ", "values": ["primar"]}}),
    ],
)
def test_a_plain_query_stays_the_same_object(where: dict[str, Any]) -> None:
    written = query(where)
    assert plain(written) is written


def test_a_negated_comparison_means_its_complement_in_the_data(sample: DataBackend) -> None:
    """``not`` of a comparison and its complement find the same features (F12):
    a missing value fails both, so the rewrite in a relation's filter changes
    no result."""
    for value, cmp in (("bus", "eq"), ("bus", "ne"), (5, "lt"), (5, "ge")):
        attr, layer = (
            ("verkehrsmittel", "haltestellen") if value == "bus" else ("flaeche_km2", "gemeinden")
        )
        compare = {"op": "compare", "attr": attr, "cmp": cmp, "value": value}
        negated = {"op": "not", "arg": compare}
        affirmed = {**compare, "cmp": COMPLEMENT[cmp]}
        found = [
            ids_query(QueryObject.model_validate({"source": layer, "where": w}), sample, LIMITS)
            for w in (negated, affirmed)
        ]
        assert found[0] == found[1]


def test_a_query_without_conditions_stays() -> None:
    written = QueryObject.model_validate({"source": "schulen"})
    assert plain(written) is written
