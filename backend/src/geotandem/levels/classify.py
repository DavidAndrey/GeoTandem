"""Operation classes of a query object (plan E2.0, H4, table 2.4).

Every part of the schema has a class; ``tests/test_levels.py`` walks the
schema and fails on a part missing here, so no schema version can add an
unclassified operation.
"""

from collections.abc import Iterator

from geotandem.levels.model import OpClass
from geotandem_query import (
    And,
    Condition,
    Not,
    Or,
    QueryObject,
    RelatedByDistance,
    RelatedTopological,
)

FIELD_CLASS: dict[str, OpClass] = {
    "schema_version": OpClass.QUERY,
    "source": OpClass.QUERY,
    "attribute_join": OpClass.DERIVE,
    "where": OpClass.QUERY,
    "buffer": OpClass.DERIVE,
    "spatial_relation": OpClass.SPATIAL,
    "aggregate": OpClass.DERIVE,
    "columns": OpClass.SPATIAL,
    "select": OpClass.QUERY,
    "order_by": OpClass.QUERY,
    "limit": OpClass.QUERY,
    "symbology": OpClass.DISPLAY,
    "output": OpClass.QUERY,
}
"""Top-level fields; a field counts when set to something other than nothing."""

CONDITION_CLASS: dict[str, OpClass] = {
    "compare": OpClass.QUERY,
    "between": OpClass.QUERY,
    "in": OpClass.QUERY,
    "text_match": OpClass.QUERY,
    "is_null": OpClass.QUERY,
    "and": OpClass.QUERY,
    "or": OpClass.QUERY,
    "not": OpClass.QUERY,
    "bbox": OpClass.QUERY,
    "geometry": OpClass.QUERY,
    "near_feature": OpClass.SPATIAL,
    "related": OpClass.SPATIAL,
}
"""Conditions by ``op``, wherever they sit: in ``where`` or filtering another layer."""

COLUMN_CLASS: dict[str, OpClass] = {
    "distance_to": OpClass.SPATIAL,
    "value_of": OpClass.SPATIAL,
}
"""Computed columns by ``fn``."""


def _conditions(condition: Condition | None) -> Iterator[Condition]:
    if condition is None:
        return
    yield condition
    if isinstance(condition, And | Or):
        for arg in condition.args:
            yield from _conditions(arg)
    elif isinstance(condition, Not):
        yield from _conditions(condition.arg)
    elif isinstance(condition, RelatedTopological | RelatedByDistance):
        yield from _conditions(condition.where)


def classify(query: QueryObject) -> frozenset[OpClass]:
    """Every class the query touches; the strictest cell among them governs (H4)."""
    classes = {
        op_class
        for field, op_class in FIELD_CLASS.items()
        if getattr(query, field) not in (None, [])
    }
    nested = [query.where]
    if query.spatial_relation is not None:
        nested.append(query.spatial_relation.where)
    for column in query.columns:
        classes.add(COLUMN_CLASS[column.fn])
        nested.append(column.where)
    for root in nested:
        classes.update(CONDITION_CLASS[c.op] for c in _conditions(root))
    return frozenset(classes)
