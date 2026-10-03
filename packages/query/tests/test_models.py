import pytest
from pydantic import ValidationError

from geotandem_query import QueryObject, canonical_json, query_hash


def q(**kwargs: object) -> QueryObject:
    return QueryObject.model_validate({"source": "schulen", **kwargs})


def test_minimal_query_gets_defaults() -> None:
    query = q()
    assert query.schema_version == "2"
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
        {"spatial_relation": {"layer": "fluss", "predicate": "dwithin"}},
        {"spatial_relation": {"layer": "fluss", "predicate": "within", "distance_m": 5}},
        {"buffer": {"distance_m": 0}},
        {"aggregate": {"by_layer": "g", "metrics": [{"fn": "sum", "as": "s"}]}},
        {"aggregate": {"by_layer": "g", "metrics": [{"fn": "count", "attr": "a", "as": "n"}]}},
        {"schema_version": "3"},
        {"where": {"op": "related", "layer": "g", "predicate": "dwithin"}},
        {"where": {"op": "related", "layer": "g", "predicate": "within", "distance_m": 5}},
        {"where": {"op": "related", "layer": "G", "predicate": "within"}},
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


# --- v1 (E1.5) -----------------------------------------------------------------


def test_v0_document_is_read_as_v1_with_the_same_hash() -> None:
    v0 = q(schema_version="0", where={"op": "compare", "attr": "a", "cmp": "eq", "value": 1})
    v1 = q(where={"op": "compare", "attr": "a", "cmp": "eq", "value": 1})
    assert v0.schema_version == "2"
    assert query_hash(v0) == query_hash(v1)


def test_related_combines_with_and_or_not() -> None:
    reference = {
        "op": "and",
        "args": [
            {"op": "in", "attr": "typ", "values": ["primar"]},
            {"op": "related", "layer": "strassen", "predicate": "dwithin", "distance_m": 500},
            {
                "op": "not",
                "arg": {
                    "op": "related",
                    "layer": "gemeinden",
                    "predicate": "within",
                    "where": {"op": "compare", "attr": "gem_nr", "cmp": "eq", "value": 101},
                },
            },
        ],
    }
    query = q(where=reference)
    assert canonical_json(query).count('"op":"related"') == 2


# --- no hidden rules: order is normalised, not enforced -----------------------


def test_reversed_range_and_bbox_are_normalised() -> None:
    reversed_ = q(where={"op": "between", "attr": "a", "min": 9, "max": 2})
    ordered = q(where={"op": "between", "attr": "a", "min": 2, "max": 9})
    assert (reversed_.where.min, reversed_.where.max) == (2, 9)  # type: ignore[union-attr]
    assert query_hash(reversed_) == query_hash(ordered)
    corners = q(where={"op": "bbox", "bbox": [8, 47, 7, 46]})
    assert corners.where.bbox == (7, 46, 8, 47)  # type: ignore[union-attr]


def test_variants_carry_only_their_fields() -> None:
    query = q(
        where={"op": "related", "layer": "g", "predicate": "within"},
        aggregate={"by_layer": "g", "metrics": [{"fn": "count", "as": "n"}]},
    )
    dumped = query.model_dump(mode="json", by_alias=True, exclude_none=False)
    assert "distance_m" not in dumped["where"]
    assert "attr" not in dumped["aggregate"]["metrics"][0]


# --- v2 (E1.6) -----------------------------------------------------------------


def test_v1_document_is_read_as_v2_with_the_same_hash() -> None:
    where = {"op": "related", "layer": "strassen", "predicate": "dwithin", "distance_m": 500}
    assert query_hash(q(schema_version="1", where=where)) == query_hash(q(where=where))


def test_columns_are_told_apart_by_fn() -> None:
    query = q(
        columns=[
            {"fn": "distance_to", "name": "d", "layer": "strassen"},
            {"fn": "value_of", "name": "g", "layer": "gemeinden", "attr": "name"},
        ]
    )
    distance, value = query.columns
    assert distance.fn == "distance_to"
    assert value.fn == "value_of" and value.predicate == "within"
