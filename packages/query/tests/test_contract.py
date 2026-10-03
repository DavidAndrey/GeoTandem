"""The exported JSON schema is the whole intrinsic contract (plan E1.5, option A).

For every document, the schema and the pydantic models give the same verdict.
A rule that only the models enforce would be invisible to every other user of
the schema — the frontend, the model in E2, MCP clients in E4 — so this test
fails as soon as one sneaks back in.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from geotandem_query import QueryObject
from geotandem_query.version import SCHEMA_VERSION

SCHEMA = json.loads(
    (Path(__file__).parents[3] / "schema" / "query-object" / f"v{SCHEMA_VERSION}.json").read_text()
)
VALIDATOR = Draft202012Validator(SCHEMA)
GOLDEN = Path(__file__).parents[3] / "backend" / "tests" / "golden"

VALID: list[dict[str, Any]] = [
    {"where": {"op": "related", "layer": "g", "predicate": "dwithin", "distance_m": 5}},
    {"where": {"op": "not", "arg": {"op": "related", "layer": "g", "predicate": "within"}}},
    {"where": {"op": "between", "attr": "a", "min": 9, "max": 2}},  # normalised
    {"where": {"op": "bbox", "bbox": [8, 47, 7, 46]}},  # normalised
    {"spatial_relation": {"layer": "g", "predicate": "contains"}},
    {"aggregate": {"by_layer": "g", "metrics": [{"fn": "count", "as": "n"}]}},
    {"aggregate": {"by_layer": "g", "metrics": [{"fn": "avg", "attr": "a", "as": "m"}]}},
    *[
        {k: v for k, v in json.loads(p.read_text()).items() if k != "source"}
        for p in sorted(GOLDEN.glob("*.query.json"))
    ],
]

INVALID: list[dict[str, Any]] = [
    {"unknown_field": 1},
    {"source": "Schulen"},
    {"where": {"op": "compare", "attr": "a", "cmp": "like", "value": 1}},
    {"where": {"op": "and", "args": []}},
    {"where": {"op": "touches", "layer": "g"}},
    {"where": {"op": "related", "layer": "g", "predicate": "dwithin"}},
    {"where": {"op": "related", "layer": "g", "predicate": "within", "distance_m": 5}},
    {"where": {"op": "related", "layer": "g", "predicate": "dwithin", "distance_m": 0}},
    {"spatial_relation": {"layer": "g", "predicate": "dwithin"}},
    {"spatial_relation": {"layer": "g", "predicate": "within", "distance_m": 5}},
    {"aggregate": {"by_layer": "g", "metrics": [{"fn": "sum", "as": "s"}]}},
    {"aggregate": {"by_layer": "g", "metrics": [{"fn": "count", "attr": "a", "as": "n"}]}},
    {"aggregate": {"by_layer": "g", "metrics": []}},
    {"buffer": {"distance_m": 0}},
    {"symbology": {"kind": "classified", "attr": "a", "method": "quantile", "classes": 20}},
    {"schema_version": "2"},
]


def pydantic_accepts(document: dict[str, Any]) -> bool:
    try:
        QueryObject.model_validate(document)
    except ValidationError:
        return False
    return True


@pytest.mark.parametrize("payload", VALID + INVALID)
def test_schema_and_models_agree(payload: dict[str, Any]) -> None:
    document = {"schema_version": SCHEMA_VERSION, "source": "schulen", **payload}
    by_schema = VALIDATOR.is_valid(document)
    assert by_schema == pydantic_accepts(document), list(VALIDATOR.iter_errors(document))
    assert by_schema == (payload in VALID)


def test_the_one_deliberate_difference_is_reading_v0() -> None:
    """The server reads a v0 document as v1 (F-10.3); the v1 schema describes v1 only."""
    v0 = {"schema_version": "0", "source": "schulen"}
    assert pydantic_accepts(v0)
    assert not VALIDATOR.is_valid(v0)
