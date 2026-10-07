"""Levels of model support (plan E2.0): rules, classification, fallback, seed."""

from typing import Any, get_args

import pytest
from pydantic import ValidationError

from geotandem.config import Settings
from geotandem.db.bootstrap import bootstrap
from geotandem.levels import (
    CellMode,
    Level,
    LevelError,
    OpClass,
    classify,
    load_levels,
    resolve_level,
    strictest,
    validate_levels,
)
from geotandem.levels.classify import COLUMN_CLASS, CONDITION_CLASS, FIELD_CLASS
from geotandem_query import Column, QueryObject

ALL = list(OpClass)


def level(
    name: str,
    mode: CellMode = CellMode.APPROVE,
    *,
    id: int | None = None,
    selectable: bool = True,
    default: bool = False,
    **cells: CellMode,
) -> Level:
    matrix = {c: CellMode(cells.get(c.value, mode)) for c in OpClass}
    return Level(id=id, name=name, selectable=selectable, is_default=default, matrix=matrix)


# --- The set -------------------------------------------------------------------


def test_a_valid_set_passes() -> None:
    validate_levels([level("Assistenz", CellMode.OFF), level("Prüfen", default=True)])


@pytest.mark.parametrize("count", [0, 5])
def test_one_to_four_levels(count: int) -> None:
    levels = [level(f"Stufe {i}", default=i == 0) for i in range(count)]
    with pytest.raises(LevelError) as caught:
        validate_levels(levels)
    assert caught.value.code == "level_count"
    assert caught.value.details == {"min": 1, "max": 4, "count": count}


@pytest.mark.parametrize("defaults", [0, 2])
def test_exactly_one_default(defaults: int) -> None:
    levels = [level("A", default=defaults > 0), level("B", default=defaults > 1)]
    with pytest.raises(LevelError) as caught:
        validate_levels(levels)
    assert caught.value.code == "default_level_count"


def test_the_default_is_selectable() -> None:
    """Which also means the last selectable level cannot go (H7)."""
    with pytest.raises(LevelError) as caught:
        validate_levels([level("A", default=True, selectable=False), level("B")])
    assert caught.value.code == "default_not_selectable"
    assert caught.value.details == {"name": "A"}


def test_names_are_unique_ignoring_case() -> None:
    with pytest.raises(LevelError) as caught:
        validate_levels([level("Prüfen", default=True), level("prüfen ")])
    assert caught.value.code == "level_name_taken"


def test_a_level_has_a_cell_for_every_class() -> None:
    cells = {c: CellMode.AUTO for c in OpClass if c is not OpClass.DISPLAY}
    with pytest.raises(ValidationError, match="display"):
        Level(name="Lücke", matrix=cells)


def test_name_and_prompt_are_bounded() -> None:
    with pytest.raises(ValidationError):
        level("   ")
    with pytest.raises(ValidationError):
        Level(name="Lang", system_prompt="x" * 8001, matrix=level("x").matrix)


def test_all_off_is_an_explain_only_level() -> None:
    validate_levels([level("Nur erklären", CellMode.OFF, default=True)])


# --- Strictest cell (H4) -------------------------------------------------------


def test_the_strictest_cell_governs() -> None:
    mixed = level("Gemischt", CellMode.AUTO, spatial=CellMode.APPROVE, derive=CellMode.OFF)
    assert strictest(mixed, [OpClass.QUERY]) == CellMode.AUTO
    assert strictest(mixed, [OpClass.QUERY, OpClass.SPATIAL]) == CellMode.APPROVE
    assert strictest(mixed, [OpClass.SPATIAL, OpClass.DERIVE]) == CellMode.OFF
    with pytest.raises(ValueError):
        strictest(mixed, [])


# --- Choice and fallback (H6, H7) ----------------------------------------------


SHIPPED = [
    level("Assistenz", CellMode.OFF, id=1),
    level("Prüfen", id=2, default=True),
    level("Automatisch", CellMode.AUTO, id=3, selectable=False),
]


def test_the_choice_counts_while_it_is_open() -> None:
    assert resolve_level(SHIPPED, admin=False, chosen_id=1).name == "Assistenz"


@pytest.mark.parametrize("chosen_id", [None, 99, 3])
def test_no_choice_a_gone_level_or_a_closed_one_fall_back_to_the_default(
    chosen_id: int | None,
) -> None:
    assert resolve_level(SHIPPED, admin=False, chosen_id=chosen_id).name == "Prüfen"


def test_administrators_may_use_every_level() -> None:
    assert resolve_level(SHIPPED, admin=True, chosen_id=3).name == "Automatisch"


# --- Classification (H4, table 2.4) --------------------------------------------


def test_every_schema_part_has_a_class() -> None:
    """A schema version adding an operation fails here until it is classified."""
    assert set(FIELD_CLASS) == set(QueryObject.model_fields)

    ops: set[str] = set()
    for definition in QueryObject.model_json_schema()["$defs"].values():
        op = definition.get("properties", {}).get("op")
        if op is not None:
            ops.update([op["const"]] if "const" in op else op["enum"])
    assert set(CONDITION_CLASS) == ops

    fns = {get_args(m.model_fields["fn"].annotation)[0] for m in get_args(get_args(Column)[0])}
    assert set(COLUMN_CLASS) == fns


def q(**parts: Any) -> QueryObject:
    return QueryObject.model_validate({"source": "schulen", **parts})


GEMEINDE = {"op": "compare", "attr": "name", "cmp": "eq", "value": "Bern"}
RELATED = {"op": "related", "layer": "gemeinden", "predicate": "within"}


@pytest.mark.parametrize(
    ("parts", "classes"),
    [
        ({}, {"query"}),
        ({"where": GEMEINDE, "limit": 5, "output": "table"}, {"query"}),
        ({"where": {"op": "bbox", "bbox": [7, 46, 8, 47]}}, {"query"}),
        ({"where": {"op": "not", "arg": RELATED}}, {"query", "spatial"}),
        ({"where": {"op": "near_feature", "layer": "strassen", "fid": 1}}, {"query", "spatial"}),
        ({"spatial_relation": {"layer": "gemeinden", "predicate": "within"}}, {"query", "spatial"}),
        ({"buffer": {"distance_m": 100}}, {"query", "derive"}),
        (
            {"aggregate": {"by_layer": "gemeinden", "metrics": [{"fn": "count", "as": "n"}]}},
            {"query", "derive"},
        ),
        (
            {
                "attribute_join": {
                    "layer": "gemeindedaten",
                    "left_key": "bfs",
                    "right_key": "bfs",
                    "fields": ["einwohner"],
                }
            },
            {"query", "derive"},
        ),
        (
            {"columns": [{"fn": "distance_to", "name": "d", "layer": "strassen"}]},
            {"query", "spatial"},
        ),
        ({"symbology": {"kind": "single"}}, {"query", "display"}),
    ],
)
def test_classify(parts: dict[str, Any], classes: set[str]) -> None:
    assert classify(q(**parts)) == {OpClass(c) for c in classes}


def test_conditions_on_other_layers_are_classified_too() -> None:
    near = {"op": "near_feature", "layer": "strassen", "fid": 1}
    nested = {"op": "related", "layer": "gemeinden", "predicate": "within", "where": near}
    assert OpClass.SPATIAL in classify(q(where={"op": "and", "args": [GEMEINDE, nested]}))
    column = {"fn": "value_of", "name": "g", "layer": "gemeinden", "attr": "name", "where": near}
    assert classify(q(columns=[column])) == {OpClass.QUERY, OpClass.SPATIAL}


# --- Seed (H8) -----------------------------------------------------------------


def test_the_shipped_levels(settings: Settings) -> None:
    levels = load_levels(bootstrap(settings))
    validate_levels(levels)
    assert [(lv.name, lv.selectable, lv.is_default) for lv in levels] == [
        ("Assistenz", True, False),
        ("Prüfen", True, True),
        ("Automatisch", False, False),
    ]
    assert [set(lv.matrix.values()) for lv in levels] == [
        {CellMode.OFF},
        {CellMode.APPROVE},
        {CellMode.AUTO},
    ]
    assert all(lv.description and lv.system_prompt.startswith("Du bist") for lv in levels)
    assert set(levels[0].matrix) == set(ALL)
