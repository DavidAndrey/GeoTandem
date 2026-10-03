"""Dates as an attribute type (plan E1.8, WP40, G3, G4).

Recognised at import, stored as dates (ISO text in SQLite, a native date in
PostGIS), and queried with ISO text in the query object — no schema change.
"""

from datetime import date, datetime
from pathlib import Path
from typing import Any

import pytest

from geotandem.catalog import get_layer
from geotandem.data import DataBackend, Limits
from geotandem.engine import QueryError, run_query
from geotandem.importing.run import ImportDecisions, run_import
from geotandem.importing.values import as_date, infer
from geotandem_query import QueryObject

LIMITS = Limits(max_features=1000, timeout_s=5)


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        (["2024-03-01", "2023-12-31", ""], ("date", [date(2024, 3, 1), date(2023, 12, 31), None])),
        (["1.3.2024", "31.12.2023"], ("date", [date(2024, 3, 1), date(2023, 12, 31)])),
        (
            [datetime(2025, 1, 1), date(2024, 2, 29)],
            ("date", [date(2025, 1, 1), date(2024, 2, 29)]),
        ),
    ],
)
def test_dates_are_recognised(values: list[Any], expected: tuple[str, list[Any]]) -> None:
    data_type, converted, times = infer(values)
    assert (data_type, converted) == expected
    assert times is False


@pytest.mark.parametrize(
    "values",
    [
        ["31.02.2024"],  # no such day
        ["2024-03-01", "bald"],
        ["03/01/2024"],  # ambiguous: month or day first
    ],
)
def test_what_is_not_surely_a_date_stays_text(values: list[Any]) -> None:
    assert infer(values)[0] == "text"


def test_a_time_of_day_stays_text_with_a_note() -> None:
    """G4: times would need time zones; they stay text and the import says so."""
    data_type, converted, times = infer([datetime(2025, 1, 1, 8, 30)])
    assert data_type == "text"
    assert converted == ["2025-01-01T08:30:00"]
    assert times is True
    assert as_date(datetime(2025, 1, 1, 0, 0)) == date(2025, 1, 1)


@pytest.fixture
def dated(backend: DataBackend, tmp_path: Path) -> DataBackend:
    path = tmp_path / "kontrollen.csv"
    path.write_text(
        "nr;stichtag;e;n\n"
        "1;01.03.2024;2600000;1200000\n"
        "2;15.11.2023;2600100;1200000\n"
        "3;;2600200;1200000\n"
        "4;29.02.2024;2600300;1200000\n",
        encoding="utf-8",
    )
    decisions = ImportDecisions.model_validate(
        {"geo": {"mode": "xy", "x": "e", "y": "n", "crs": 2056}, "layer_name": "kontrollen"}
    )
    run = run_import(path, path.name, decisions, backend)
    assert run.status == "ok", run
    return backend


def nrs(backend: DataBackend, query: dict[str, Any]) -> list[int]:
    result = run_query(
        QueryObject.model_validate({"source": "kontrollen", **query}), backend, LIMITS
    )
    return [f.properties["nr"] for f in result.features]


def test_an_imported_date_column_is_a_date(dated: DataBackend) -> None:
    info = get_layer(dated.engine, "kontrollen")
    assert info is not None
    assert {a.name: a.data_type for a in info.attributes}["stichtag"] == "date"
    result = run_query(QueryObject(source="kontrollen"), dated, LIMITS)
    assert [f.properties["stichtag"] for f in result.features] == [
        date(2024, 3, 1),
        date(2023, 11, 15),
        None,
        date(2024, 2, 29),
    ]


@pytest.mark.parametrize(
    ("where", "expected"),
    [
        ({"op": "compare", "attr": "stichtag", "cmp": "eq", "value": "2024-03-01"}, [1]),
        ({"op": "compare", "attr": "stichtag", "cmp": "lt", "value": "2024-01-01"}, [2]),
        ({"op": "compare", "attr": "stichtag", "cmp": "ge", "value": "2024-02-29"}, [1, 4]),
        (
            {
                "op": "and",
                "args": [
                    {"op": "compare", "attr": "stichtag", "cmp": "ge", "value": "2023-12-01"},
                    {"op": "compare", "attr": "stichtag", "cmp": "le", "value": "2024-02-29"},
                ],
            },
            [4],
        ),
        ({"op": "in", "attr": "stichtag", "values": ["2023-11-15", "2024-02-29"]}, [2, 4]),
        ({"op": "is_null", "attr": "stichtag"}, [3]),
    ],
)
def test_dates_are_queried_with_iso_text(
    dated: DataBackend, where: dict[str, Any], expected: list[int]
) -> None:
    assert nrs(dated, {"where": where}) == expected


def test_dates_sort_as_dates(dated: DataBackend) -> None:
    query = {"order_by": [{"attr": "stichtag", "dir": "asc"}]}
    assert nrs(dated, query) == [2, 4, 1, 3]  # empty last


@pytest.mark.parametrize("value", ["01.03.2024", "2024-3-1", 20240301, "2024-02-30"])
def test_anything_but_an_iso_date_is_refused(dated: DataBackend, value: Any) -> None:
    where = {"op": "compare", "attr": "stichtag", "cmp": "eq", "value": value}
    with pytest.raises(QueryError) as info:
        nrs(dated, {"where": where})
    assert info.value.code == "invalid_query"
    assert "ISO text" in info.value.message
