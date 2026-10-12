"""Shapes that mean the same are written plain (testplan E-3)."""

from typing import Any

import pytest

from geotandem.model.shapes import plain
from geotandem_query import QueryObject

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
    ],
)
def test_a_plain_query_stays_the_same_object(where: dict[str, Any]) -> None:
    written = query(where)
    assert plain(written) is written


def test_a_query_without_conditions_stays() -> None:
    written = QueryObject.model_validate({"source": "schulen"})
    assert plain(written) is written
