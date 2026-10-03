"""Execution engine against the sample dataset.

Spatial results are checked against an independent oracle: the same sample
files evaluated with shapely in application code.
"""

import json
import os
from pathlib import Path
from typing import Any

import pytest
import shapely
from shapely.geometry import mapping, shape
from shapely.geometry.base import BaseGeometry

from geotandem.data import DataBackend, Limits
from geotandem.data.view import LayerView
from geotandem.engine import QueryError, QueryResult, count_query, run_query
from geotandem.geo import WGS84, reprojector
from geotandem.sample import DATA_DIR
from geotandem.sample.load import dataset_version
from geotandem_query import QueryObject, query_hash

GOLDEN = Path(__file__).parent / "golden"
LIMITS = Limits(max_features=1000, timeout_s=10)
BOWTIE = [[7, 46], [8, 47], [8, 46], [7, 47], [7, 46]]  # self-intersecting


def oracle(layer: str) -> list[tuple[int, BaseGeometry, dict[str, Any]]]:
    """(fid, geometry in LV95, properties) exactly as the loader stores them."""
    to_lv95 = reprojector(WGS84, 2056)
    features = json.loads((DATA_DIR / f"{layer}.geojson").read_text("utf-8"))["features"]
    return [(i + 1, to_lv95(shape(f["geometry"])), f["properties"]) for i, f in enumerate(features)]


def aare_geometry() -> BaseGeometry:
    """The Aare is several features, one per connected stretch."""
    return shapely.union_all([g for _, g, p in oracle("gewaesser") if p["name"] == "Aare"])


def run(backend: DataBackend, query: dict[str, Any], limits: Limits = LIMITS) -> QueryResult:
    return run_query(QueryObject.model_validate(query), backend, limits)


def ids(result: QueryResult) -> list[int]:
    return [f.id for f in result.features]


# --- operations against the oracle ---------------------------------------------


def test_dwithin_matches_oracle(sample: DataBackend) -> None:
    aare = aare_geometry()
    expected = [fid for fid, g, _ in oracle("schulen") if g.distance(aare) <= 500]
    result = run(
        sample,
        {
            "source": "schulen",
            "spatial_relation": {
                "layer": "gewaesser",
                "predicate": "dwithin",
                "distance_m": 500,
                "where": {"op": "compare", "attr": "name", "cmp": "eq", "value": "Aare"},
            },
        },
    )
    assert ids(result) == expected
    assert 0 < len(expected) < 137


@pytest.mark.parametrize("predicate", ["within", "intersects"])
def test_aggregate_matches_oracle(sample: DataBackend, predicate: str) -> None:
    schools = oracle("schulen")
    expected = {
        fid: sorted(p["standorte"] for _, s, p in schools if getattr(s, predicate)(area))
        for fid, area, _ in oracle("gemeinden")
    }
    result = run(
        sample,
        {
            "source": "schulen",
            "aggregate": {
                "by_layer": "gemeinden",
                "predicate": predicate,
                "metrics": [
                    {"fn": "count", "as": "n"},
                    {"fn": "sum", "attr": "standorte", "as": "total"},
                    {"fn": "min", "attr": "standorte", "as": "lo"},
                    {"fn": "max", "attr": "standorte", "as": "hi"},
                ],
            },
        },
    )
    assert ids(result) == sorted(expected)
    assert any(not values for values in expected.values()), "a municipality without schools"
    for f in result.features:
        values = expected[f.id]
        assert f.properties == {"n": len(values), "total": sum(values) if values else None,
                                "lo": min(values, default=None),
                                "hi": max(values, default=None)}  # fmt: skip
        assert f.geometry is not None and f.geometry["type"] in ("Polygon", "MultiPolygon")


def test_buffer_then_relation_matches_oracle(sample: DataBackend) -> None:
    roads = [g for _, g, _ in oracle("strassen")]
    expected = [
        fid for fid, g, _ in oracle("schulen") if any(g.buffer(200).intersects(r) for r in roads)
    ]
    result = run(
        sample,
        {
            "source": "schulen",
            "buffer": {"distance_m": 200},
            "spatial_relation": {"layer": "strassen", "predicate": "intersects"},
        },
    )
    assert ids(result) == expected
    # Result geometry is the buffer, in WGS84.
    assert result.features[0].geometry is not None
    assert result.features[0].geometry["type"] == "Polygon"


def test_geometry_and_bbox_filters_match_oracle(sample: DataBackend) -> None:
    municipality = oracle("gemeinden")[5][1]
    drawn = reprojector(2056, WGS84)(municipality)
    expected = [fid for fid, g, _ in oracle("schulen") if municipality.intersects(g)]
    result = run(
        sample,
        {
            "source": "schulen",
            "where": {"op": "geometry", "geometry": mapping(drawn)},
        },
    )
    assert ids(result) == expected

    min_x, min_y, max_x, max_y = drawn.bounds
    box = reprojector(WGS84, 2056)(shapely.box(min_x, min_y, max_x, max_y))
    result = run(sample, {"source": "schulen", "where": {"op": "bbox", "bbox": list(drawn.bounds)}})
    assert ids(result) == [fid for fid, g, _ in oracle("schulen") if box.intersects(g)]


def test_near_feature_matches_oracle(sample: DataBackend) -> None:
    road = oracle("strassen")[0][1]
    expected = [fid for fid, g, _ in oracle("schulen") if g.distance(road) <= 300]
    result = run(
        sample,
        {"source": "schulen", "where": {"op": "near_feature", "layer": "strassen", "fid": 1,
                                        "distance_m": 300}},
    )  # fmt: skip
    assert ids(result) == expected


# --- attribute operations ------------------------------------------------------


def test_attribute_join_filter_and_order(sample: DataBackend) -> None:
    result = run(
        sample,
        {
            "source": "gemeinden",
            "attribute_join": {"layer": "gemeindedaten", "left_key": "gem_nr",
                               "right_key": "gem_nr", "fields": ["einwohner"], "prefix": "b_"},
            "where": {"op": "between", "attr": "b_einwohner", "min": 5000, "max": 9000},
            "select": ["name", "b_einwohner"],
            "order_by": [{"attr": "b_einwohner", "dir": "desc"}],
        },
    )  # fmt: skip
    values = [f.properties["b_einwohner"] for f in result.features]
    assert values == sorted(values, reverse=True)
    assert all(5000 <= v <= 9000 for v in values)
    assert set(result.features[0].properties) == {"name", "b_einwohner"}


@pytest.mark.parametrize(
    ("text", "mode", "case_sensitive", "expected"),
    [
        (
            "berg",
            "contains",
            False,
            ["Guggisberg", "Jaberg", "Mühleberg", "Riggisberg", "Rüeggisberg"],
        ),
        ("BERG", "contains", True, []),
        ("Ober", "starts_with", True, ["Oberbalm", "Oberdiessbach", "Oberhünigen", "Oberthal"]),
        (
            "WIL",
            "ends_with",
            False,
            ["Bowil", "Bäriswil", "Iffwil", "Kriechenwil", "Landiswil", "Wiggiswil", "Zäziwil"],
        ),
        ("köniz", "equals", False, ["Köniz"]),
        ("köniz", "equals", True, []),
        ("%", "contains", False, []),  # wildcards are literal
    ],
)
def test_text_match(
    sample: DataBackend, text: str, mode: str, case_sensitive: bool, expected: list[str]
) -> None:
    result = run(
        sample,
        {"source": "gemeinden", "where": {"op": "text_match", "attr": "name", "text": text,
                                          "mode": mode, "case_sensitive": case_sensitive}},
    )  # fmt: skip
    assert sorted(f.properties["name"] for f in result.features) == expected


def test_table_layer_query_has_null_geometry(sample: DataBackend) -> None:
    result = run(sample, {"source": "gemeindedaten", "limit": 3})
    assert len(result.features) == 3
    assert all(f.geometry is None for f in result.features)


# --- reproducibility (F-8.9) ---------------------------------------------------


def test_result_is_reproducible_and_tied_to_query(sample: DataBackend) -> None:
    query = json.loads((GOLDEN / "schools_per_municipality.query.json").read_text("utf-8"))
    first, second = run(sample, query), run(sample, query)
    assert first.features == second.features
    assert first.meta.query_hash == second.meta.query_hash
    assert first.meta.query_hash == query_hash(QueryObject.model_validate(query))
    version = dataset_version()
    assert first.meta.data_versions == {"schulen": version, "gemeinden": version}


@pytest.mark.parametrize("name", sorted(p.name.split(".")[0] for p in GOLDEN.glob("*.query.json")))
def test_golden(sample: DataBackend, name: str) -> None:
    """Pinned results; regenerate with GEOTANDEM_UPDATE_GOLDEN=1 after a deliberate change."""
    query = json.loads((GOLDEN / f"{name}.query.json").read_text("utf-8"))
    result = run(sample, query)
    actual = {
        "query_hash": result.meta.query_hash,
        "features": [{"id": f.id, "properties": _rounded(f.properties)} for f in result.features],
    }
    expected_file = GOLDEN / f"{name}.expected.json"
    if os.environ.get("GEOTANDEM_UPDATE_GOLDEN"):
        expected_file.write_text(json.dumps(actual, indent=2, ensure_ascii=False) + "\n")
    assert actual == json.loads(expected_file.read_text("utf-8"))
    assert actual["features"], "a golden query should return something"


def _rounded(properties: dict[str, Any]) -> dict[str, Any]:
    return {k: round(v, 6) if isinstance(v, float) else v for k, v in properties.items()}


# --- rejection with a useful message (F-5.9) and limits (F-9.6) ----------------


@pytest.mark.parametrize(
    ("query", "code", "fragment"),
    [
        ({"source": "spitaeler"}, "unknown_layer", "Available: gemeindedaten, gemeinden"),
        ({"source": "schulen", "select": ["stufe"]}, "unknown_attribute", "Available: fid, gem_nr"),
        (
            {"source": "schulen", "where": {"op": "compare", "attr": "standorte", "cmp": "gt",
                                            "value": "viele"}},
            "invalid_query", "holds int values",
        ),
        (
            {"source": "schulen", "where": {"op": "text_match", "attr": "standorte", "text": "1"}},
            "invalid_query", "needs a text attribute",
        ),
        ({"source": "gemeindedaten", "buffer": {"distance_m": 5}}, "unsupported_operation",
         "table layer"),
        (
            {"source": "schulen", "aggregate": {"by_layer": "gemeinden", "metrics": [
                {"fn": "sum", "attr": "typ", "as": "x"}]}},
            "invalid_query", "not numeric",
        ),
        (
            {"source": "gemeinden", "attribute_join": {"layer": "gemeindedaten",
             "left_key": "gem_nr", "right_key": "gem_nr", "fields": ["gem_nr"]}},
            "invalid_query", "set 'prefix'",
        ),
        (
            {"source": "schulen", "where": {"op": "geometry", "geometry": {
                "type": "Polygon", "coordinates": [BOWTIE]}}},
            "invalid_query", "Invalid geometry",
        ),
    ],
)  # fmt: skip
def test_rejections(sample: DataBackend, query: dict[str, Any], code: str, fragment: str) -> None:
    with pytest.raises(QueryError) as info:
        run(sample, query)
    assert info.value.code == code
    assert fragment in info.value.message


def test_result_size_limit(sample: DataBackend) -> None:
    small = Limits(max_features=50, timeout_s=10)
    with pytest.raises(QueryError) as info:
        run(sample, {"source": "schulen"}, small)
    assert info.value.code == "result_too_large"
    assert len(run(sample, {"source": "schulen", "limit": 50}, small).features) == 50


def test_timeout(sample: DataBackend) -> None:
    with pytest.raises(QueryError) as info:
        run(sample, {"source": "schulen", "buffer": {"distance_m": 50}}, Limits(1000, 1e-9))
    assert info.value.code == "query_timeout"


# --- related (schema v1) -------------------------------------------------------


def test_related_conditions_combine_like_the_reference_question(sample: DataBackend) -> None:
    """Two relations in one AND, one of them negated: not expressible in v0."""
    motorways = [g for _, g, p in oracle("strassen") if p["klasse"] == "nationalstrasse"]
    bern = next(g for _, g, p in oracle("gemeinden") if p["gem_nr"] == 351)
    expected = [
        fid
        for fid, g, p in oracle("schulen")
        if p["typ"] == "primar"
        and any(g.distance(r) <= 500 for r in motorways)
        and not g.within(bern)
    ]
    result = run(
        sample,
        {
            "source": "schulen",
            "where": {
                "op": "and",
                "args": [
                    {"op": "in", "attr": "typ", "values": ["primar"]},
                    {
                        "op": "related",
                        "layer": "strassen",
                        "predicate": "dwithin",
                        "distance_m": 500,
                        "where": {
                            "op": "compare",
                            "attr": "klasse",
                            "cmp": "eq",
                            "value": "nationalstrasse",
                        },
                    },
                    {
                        "op": "not",
                        "arg": {
                            "op": "related",
                            "layer": "gemeinden",
                            "predicate": "within",
                            "where": {"op": "compare", "attr": "gem_nr", "cmp": "eq", "value": 351},
                        },
                    },
                ],
            },
        },
    )
    assert ids(result) == expected
    assert len(expected) > 0


def test_related_under_or(sample: DataBackend) -> None:
    aare = aare_geometry()
    expected = [
        fid for fid, g, p in oracle("schulen") if p["standorte"] > 5 or g.distance(aare) <= 300
    ]
    result = run(
        sample,
        {
            "source": "schulen",
            "where": {
                "op": "or",
                "args": [
                    {"op": "compare", "attr": "standorte", "cmp": "gt", "value": 5},
                    {
                        "op": "related",
                        "layer": "gewaesser",
                        "predicate": "dwithin",
                        "distance_m": 300,
                        "where": {"op": "compare", "attr": "name", "cmp": "eq", "value": "Aare"},
                    },
                ],
            },
        },
    )
    assert ids(result) == expected


def test_related_sees_the_geometry_before_buffer(sample: DataBackend) -> None:
    """``related`` filters in ``where``, before ``buffer``; ``spatial_relation`` after it."""
    roads = [g for _, g, _ in oracle("strassen")]
    schools = oracle("schulen")
    near_50 = [fid for fid, g, _ in schools if any(g.distance(r) <= 50 for r in roads)]
    near_250 = [fid for fid, g, _ in schools if any(g.distance(r) <= 250 for r in roads)]
    relation = {"layer": "strassen", "predicate": "dwithin", "distance_m": 50}
    condition = {"op": "related", **relation}
    as_condition = run(
        sample, {"source": "schulen", "buffer": {"distance_m": 200}, "where": condition}
    )
    after_buffer = run(
        sample, {"source": "schulen", "buffer": {"distance_m": 200}, "spatial_relation": relation}
    )
    assert ids(as_condition) == near_50
    assert ids(after_buffer) == near_250
    assert len(near_50) < len(near_250)


def test_related_to_a_hidden_layer_is_an_unknown_layer(sample: DataBackend) -> None:
    view = LayerView(sample, {"schulen"})
    with pytest.raises(QueryError) as info:
        run(
            view,
            {
                "source": "schulen",
                "where": {
                    "op": "not",
                    "arg": {"op": "related", "layer": "gemeinden", "predicate": "within"},
                },
            },
        )
    assert info.value.code == "unknown_layer"
    assert info.value.details["available"] == ["schulen"]


# --- counting (B1 "7 von 39", B2 hits per condition) ---------------------------


COUNTED = [
    *[json.loads(p.read_text("utf-8")) for p in sorted(GOLDEN.glob("*.query.json"))],
    {"source": "schulen"},
    {"source": "schulen", "limit": 7},
    {"source": "gemeindedaten"},
    {
        "source": "schulen",
        "where": {
            "op": "not",
            "arg": {"op": "related", "layer": "gemeinden", "predicate": "within"},
        },
    },
]


@pytest.mark.parametrize("query", COUNTED)
def test_count_equals_the_number_of_features(sample: DataBackend, query: dict[str, Any]) -> None:
    expected = len(run(sample, query).features)
    assert count_query(QueryObject.model_validate(query), sample, LIMITS) == expected


def test_count_is_not_capped_by_the_result_size_limit(sample: DataBackend) -> None:
    small = Limits(max_features=10, timeout_s=10)
    assert count_query(QueryObject(source="schulen"), sample, small) == 137


# --- computed columns (schema v2) ------------------------------------------------


def test_distance_column_matches_oracle(sample: DataBackend) -> None:
    motorways = [g for _, g, p in oracle("strassen") if p["klasse"] == "nationalstrasse"]
    expected = {fid: min(g.distance(r) for r in motorways) for fid, g, _ in oracle("schulen")}
    result = run(
        sample,
        {
            "source": "schulen",
            "columns": [
                {
                    "fn": "distance_to",
                    "name": "distanz_nationalstrasse",
                    "layer": "strassen",
                    "where": {
                        "op": "compare",
                        "attr": "klasse",
                        "cmp": "eq",
                        "value": "nationalstrasse",
                    },
                }
            ],
        },
    )
    actual = {f.id: f.properties["distanz_nationalstrasse"] for f in result.features}
    assert actual.keys() == expected.keys()
    for fid, distance in expected.items():
        assert actual[fid] == pytest.approx(distance, abs=0.01)


def test_value_column_matches_oracle(sample: DataBackend) -> None:
    municipalities = oracle("gemeinden")
    expected = {
        fid: next((p["name"] for _, area, p in municipalities if g.within(area)), None)
        for fid, g, _ in oracle("schulen")
    }
    result = run(
        sample,
        {
            "source": "schulen",
            "columns": [
                {"fn": "value_of", "name": "gemeinde", "layer": "gemeinden", "attr": "name"}
            ],
        },
    )
    assert {f.id: f.properties["gemeinde"] for f in result.features} == expected
    assert any(expected.values())


def test_columns_are_null_when_nothing_qualifies(sample: DataBackend) -> None:
    nothing = {"op": "compare", "attr": "gem_nr", "cmp": "eq", "value": -1}
    result = run(
        sample,
        {
            "source": "schulen",
            "limit": 3,
            "columns": [
                {"fn": "distance_to", "name": "d", "layer": "gemeinden", "where": nothing},
                {
                    "fn": "value_of",
                    "name": "v",
                    "layer": "gemeinden",
                    "attr": "name",
                    "where": nothing,
                },
            ],
        },
    )
    assert [(f.properties["d"], f.properties["v"]) for f in result.features] == [(None, None)] * 3


def test_columns_can_be_selected_and_ordered_by(sample: DataBackend) -> None:
    result = run(
        sample,
        {
            "source": "schulen",
            "columns": [{"fn": "distance_to", "name": "d", "layer": "strassen"}],
            "select": ["name", "d"],
            "order_by": [{"attr": "d", "dir": "desc"}],
            "limit": 5,
        },
    )
    distances = [f.properties["d"] for f in result.features]
    assert distances == sorted(distances, reverse=True)
    assert set(result.features[0].properties) == {"name", "d"}


def test_columns_after_aggregate_use_the_area(sample: DataBackend) -> None:
    rivers = [g for _, g, _ in oracle("gewaesser")]
    expected = {fid: min(area.distance(r) for r in rivers) for fid, area, _ in oracle("gemeinden")}
    result = run(
        sample,
        {
            "source": "schulen",
            "aggregate": {"by_layer": "gemeinden", "metrics": [{"fn": "count", "as": "n"}]},
            "columns": [{"fn": "distance_to", "name": "d", "layer": "gewaesser"}],
        },
    )
    for f in result.features:
        assert f.properties["d"] == pytest.approx(expected[f.id], abs=0.01)


@pytest.mark.parametrize(
    ("columns", "code", "fragment"),
    [
        ([{"fn": "distance_to", "name": "name", "layer": "strassen"}], "invalid_query", "clashes"),
        (
            [
                {"fn": "distance_to", "name": "d", "layer": "strassen"},
                {"fn": "distance_to", "name": "d", "layer": "gemeinden"},
            ],
            "invalid_query",
            "clashes",
        ),
        (
            [{"fn": "value_of", "name": "v", "layer": "gemeinden", "attr": "einwohner"}],
            "unknown_attribute",
            "einwohner",
        ),
        (
            [{"fn": "distance_to", "name": "d", "layer": "gemeindedaten"}],
            "unsupported_operation",
            "table layer",
        ),
    ],
)
def test_bad_columns_are_rejected(
    sample: DataBackend, columns: list[dict[str, Any]], code: str, fragment: str
) -> None:
    with pytest.raises(QueryError) as info:
        run(sample, {"source": "schulen", "columns": columns})
    assert info.value.code == code
    assert fragment in str(info.value)


def test_column_on_a_hidden_layer_is_unknown(sample: DataBackend) -> None:
    view = LayerView(sample, {"schulen"})
    with pytest.raises(QueryError) as info:
        run(
            view,
            {
                "source": "schulen",
                "columns": [{"fn": "distance_to", "name": "d", "layer": "strassen"}],
            },
        )
    assert info.value.code == "unknown_layer"


def test_count_ignores_columns(sample: DataBackend) -> None:
    query = {
        "source": "schulen",
        "columns": [{"fn": "distance_to", "name": "d", "layer": "strassen"}],
    }
    assert count_query(QueryObject.model_validate(query), sample, LIMITS) == 137
