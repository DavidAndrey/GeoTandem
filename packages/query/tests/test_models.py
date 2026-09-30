import pytest
from pydantic import ValidationError

from geotandem_query import QueryObject, canonical_json, query_hash


def q(**kwargs: object) -> QueryObject:
    return QueryObject.model_validate({"source": "schulen", **kwargs})


def test_minimal_query_gets_defaults() -> None:
    query = q()
    assert query.schema_version == "0"
    assert query.output == "map"
    assert query.order_by == []


def test_full_query_validates() -> None:
    q(
        attribute_join={
            "layer": "bevoelkerung",
            "left_key": "gem_nr",
            "right_key": "gem_nr",
            "fields": ["einwohner"],
        },
        where={
            "op": "and",
            "args": [
                {"op": "compare", "attr": "schueler", "cmp": "ge", "value": 100},
                {"op": "not", "arg": {"op": "is_null", "attr": "typ"}},
                {"op": "in", "attr": "typ", "values": ["primar", "sekundar"]},
                {"op": "between", "attr": "schueler", "min": 1, "max": 900},
                {"op": "text_match", "attr": "name", "text": "Schul"},
                {"op": "bbox", "bbox": [7.0, 46.0, 8.0, 47.0]},
                {"op": "near_feature", "layer": "gemeinden", "fid": 3, "distance_m": 0},
                {
                    "op": "geometry",
                    "geometry": {"type": "Point", "coordinates": [7.5, 46.5]},
                },
            ],
        },
        buffer={"distance_m": 50},
        spatial_relation={
            "layer": "fluss",
            "predicate": "dwithin",
            "distance_m": 500,
            "where": {"op": "compare", "attr": "name", "cmp": "eq", "value": "Tand"},
        },
        aggregate={
            "by_layer": "gemeinden",
            "area_fields": ["name"],
            "metrics": [{"fn": "count", "as": "n"}, {"fn": "sum", "attr": "schueler", "as": "s"}],
        },
        order_by=[{"attr": "n", "dir": "desc"}],
        limit=5,
        symbology={"kind": "classified", "attr": "n", "method": "quantile"},
        output="table",
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"unknown_field": 1},
        {"source": "Schulen"},  # identifiers are lower case
        {"source": "x; drop table layer"},
        {"where": {"op": "compare", "attr": "a", "cmp": "like", "value": 1}},
        {"where": {"op": "and", "args": []}},
        {"where": {"op": "between", "attr": "a", "min": 5, "max": 1}},
        {"where": {"op": "bbox", "bbox": [8, 46, 7, 47]}},
        {"spatial_relation": {"layer": "fluss", "predicate": "dwithin"}},
        {"spatial_relation": {"layer": "fluss", "predicate": "within", "distance_m": 5}},
        {"buffer": {"distance_m": 0}},
        {"aggregate": {"by_layer": "g", "metrics": [{"fn": "sum", "as": "s"}]}},
        {"aggregate": {"by_layer": "g", "metrics": [{"fn": "count", "attr": "a", "as": "n"}]}},
        {"schema_version": "1"},
        {"symbology": {"kind": "classified", "attr": "a", "method": "quantile", "classes": 20}},
    ],
)
def test_invalid_queries_are_rejected(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        QueryObject.model_validate({"source": "schulen", **payload})


def test_hash_ignores_key_order_defaults_and_integral_floats() -> None:
    a = QueryObject.model_validate(
        {
            "source": "schulen",
            "where": {"op": "compare", "attr": "schueler", "cmp": "gt", "value": 5},
        }
    )
    b = QueryObject.model_validate(
        {
            "where": {"value": 5.0, "cmp": "gt", "attr": "schueler", "op": "compare"},
            "output": "map",
            "schema_version": "0",
            "source": "schulen",
        }
    )
    assert canonical_json(a) == canonical_json(b)
    assert query_hash(a) == query_hash(b)


def test_hash_distinguishes_different_queries() -> None:
    assert query_hash(q(limit=1)) != query_hash(q(limit=2))


def test_metric_alias_round_trips() -> None:
    query = q(aggregate={"by_layer": "g", "metrics": [{"fn": "count", "as": "n"}]})
    dumped = query.model_dump(mode="json", by_alias=True)
    assert dumped["aggregate"]["metrics"][0]["as"] == "n"
    assert QueryObject.model_validate(dumped) == query
