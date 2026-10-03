"""Text, buffers and join keys alike on every backend (F-2.14, F-10.7; plan E1.8).

The corpus below is backend-neutral: the expected results are written down
here once, and every backend must produce them. Today that is SpatiaLite; a
PostGIS backend runs the same file (P).
"""

from typing import Any

import pytest
from shapely.geometry import Point
from sqlalchemy import func, select

from geotandem.data import AttributeSpec, DataBackend, Limits, NewLayer
from geotandem.data import text as text_rules
from geotandem.engine import QueryError, run_query
from geotandem_query import QueryObject

LIMITS = Limits(max_features=1000, timeout_s=5)
X0, Y0 = 2_600_000, 1_200_000

NAMES = [
    "Zollikofen",
    "Ägerten",
    "Bern",
    "bern",
    "Oberdiessbach",
    "Östermundigen",
    "École cantonale",
    "Ecole",
    "Änggisteibach",
    "Üsseri Giesse",
    "Münsingen",
    "Straße",
    "Strasse",
    "Abländschen",
]


@pytest.fixture
def names(backend: DataBackend) -> DataBackend:
    backend.create_layer(
        NewLayer(
            name="namen",
            title="Namen",
            kind="vector",
            attributes=[AttributeSpec("name", "text"), AttributeSpec("nr", "integer")],
            rows=[(Point(X0 + i * 10, Y0), {"name": n, "nr": i}) for i, n in enumerate(NAMES)],
        )
    )
    return backend


def found(backend: DataBackend, query: dict[str, Any]) -> list[str]:
    result = run_query(QueryObject.model_validate({"source": "namen", **query}), backend, LIMITS)
    return [f.properties["name"] for f in result.features]


def match(text: str, mode: str = "contains", case_sensitive: bool = False) -> dict[str, Any]:
    return {
        "where": {
            "op": "text_match",
            "attr": "name",
            "text": text,
            "mode": mode,
            "case_sensitive": case_sensitive,
        }
    }


# --- case-insensitive search ------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "mode", "expected"),
    [
        ("änggi", "contains", ["Änggisteibach"]),
        ("ÄNGGI", "starts_with", ["Änggisteibach"]),
        ("üsseri", "starts_with", ["Üsseri Giesse"]),
        ("ÖSTER", "contains", ["Östermundigen"]),
        ("MÜNSINGEN", "equals", ["Münsingen"]),
        ("bern", "equals", ["Bern", "bern"]),
        ("école", "starts_with", ["École cantonale"]),
        ("GIESSE", "ends_with", ["Üsseri Giesse"]),
        # Accents still count (plan E1.8: T2 would change that) ...
        ("munsingen", "equals", []),
        ("ecole", "starts_with", ["Ecole"]),
        # ... and "ß" is not "ss", as in PostgreSQL's lower().
        ("STRASSE", "equals", ["Strasse"]),
        ("straße", "equals", ["Straße"]),
    ],
)
def test_case_insensitive_search_folds_every_letter(
    names: DataBackend, text: str, mode: str, expected: list[str]
) -> None:
    assert sorted(found(names, match(text, mode))) == sorted(expected)


def test_case_sensitive_search_is_exact(names: DataBackend) -> None:
    assert found(names, match("Bern", "equals", case_sensitive=True)) == ["Bern"]
    assert found(names, match("änggi", "contains", case_sensitive=True)) == []
    assert found(names, match("Ä", "starts_with", case_sensitive=True)) == [
        "Ägerten",
        "Änggisteibach",
    ]


# --- text order ----------------------------------------------------------------------

ORDER = [
    "Abländschen",
    "Ägerten",
    "Änggisteibach",
    "bern",
    "Bern",
    "Ecole",
    "École cantonale",
    "Münsingen",
    "Oberdiessbach",
    "Östermundigen",
    "Strasse",
    "Straße",
    "Üsseri Giesse",
    "Zollikofen",
]


def test_text_sorts_by_base_letters_then_accents_then_case(names: DataBackend) -> None:
    assert found(names, {"order_by": [{"attr": "name", "dir": "asc"}]}) == ORDER
    assert found(names, {"order_by": [{"attr": "name", "dir": "desc"}]}) == ORDER[::-1]


def test_a_limit_takes_the_first_by_that_order(names: DataBackend) -> None:
    query = {"order_by": [{"attr": "name", "dir": "asc"}], "limit": 3}
    assert found(names, query) == ORDER[:3]


def test_text_ranges_follow_the_same_order(names: DataBackend) -> None:
    before_b = {"where": {"op": "compare", "attr": "name", "cmp": "lt", "value": "B"}}
    assert sorted(found(names, before_b), key=text_rules.sort_key) == [
        "Abländschen",
        "Ägerten",
        "Änggisteibach",
    ]
    from_o = {"where": {"op": "compare", "attr": "name", "cmp": "ge", "value": "O"}}
    assert sorted(found(names, from_o), key=text_rules.sort_key) == ORDER[8:]


def test_the_order_is_total_and_python_agrees() -> None:
    assert sorted(NAMES, key=text_rules.sort_key) == ORDER
    assert text_rules.compare("Bern", "bern") != 0
    assert text_rules.compare("Bern", "Bern") == 0


# --- buffers and join keys -------------------------------------------------------------


def test_a_buffer_has_the_same_shape_on_every_backend(backend: DataBackend) -> None:
    """30 segments per quarter circle, set explicitly: 4 * 30 + 1 vertices (PostGIS: 8)."""
    d = backend.dialect
    point = d.transform(d.from_geojson('{"type":"Point","coordinates":[7.44,46.95]}', 4326), 2056)
    stmt = select(func.ST_NPoints(d.buffer(point, 100)).label("n"))
    assert backend.execute(stmt, LIMITS)[0]["n"] == 4 * text_rules.BUFFER_QUADRANT_SEGMENTS + 1


def test_join_keys_of_different_type_are_refused(names: DataBackend) -> None:
    names.create_layer(
        NewLayer(
            name="nummern",
            title="Nummern",
            kind="table",
            attributes=[AttributeSpec("nr_text", "text"), AttributeSpec("wert", "integer")],
            rows=[(None, {"nr_text": str(i), "wert": i * 10}) for i in range(3)],
        )
    )
    join = {
        "attribute_join": {
            "layer": "nummern",
            "left_key": "nr",
            "right_key": "nr_text",
            "fields": ["wert"],
        }
    }
    with pytest.raises(QueryError) as info:
        found(names, join)
    assert info.value.code == "invalid_query"
    assert "differ in type" in info.value.message
