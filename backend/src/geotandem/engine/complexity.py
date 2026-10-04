"""Upper bounds on what one query object may ask for (security review #5).

The time limit (F-9.6) stops a query between steps of the database engine,
not inside one step, nor while the query is checked before it runs. These
bounds keep every such step small: a drawn geometry of a million vertices,
a list of a hundred thousand values (beyond SQLite's limit of variables, so
far a 500), or conditions nested hundreds deep. They sit far above anything
the interface builds, so only a query written to strain the server meets them.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from geotandem.engine.errors import QueryError
from geotandem_query import models as m

MAX_CONDITIONS = 200
"""Condition nodes in the whole query, nested and in relations and columns included."""
MAX_DEPTH = 20
"""Nesting of ``and``, ``or``, ``not`` and relations' ``where``."""
MAX_LIST_VALUES = 1_000
"""Values of one ``in`` condition."""
MAX_VALUES = 5_000
"""Values of all conditions together: SQLite takes at most 32 766 variables."""
MAX_VERTICES = 10_000
"""Vertices of all drawn geometries together."""
MAX_TEXT = 500
"""Characters of a ``text_match`` text."""
MAX_DISTANCE_M = 1_000_000.0
"""Buffers and distances: 1000 km, beyond any extent this application serves."""
MAX_COLUMNS = 10
"""Computed columns: each is a subquery per result feature."""
MAX_ITEMS = 100
"""Names in ``select``, ``order_by``, join ``fields``, ``area_fields`` and ``metrics``."""


class QueryTooComplex(QueryError):
    code = "query_too_complex"


@dataclass
class _Tally:
    conditions: int = 0
    values: int = 0
    vertices: int = 0


def check(query: m.QueryObject) -> None:
    """Raise ``QueryTooComplex`` naming the first bound the query exceeds."""
    tally = _Tally()
    for where in _conditions_of(query):
        _walk(where, 1, tally)
    _at_most("conditions", tally.conditions, MAX_CONDITIONS)
    _at_most("values in all conditions", tally.values, MAX_VALUES)
    _at_most("vertices of drawn geometries", tally.vertices, MAX_VERTICES)
    _at_most("computed columns", len(query.columns), MAX_COLUMNS)
    for name, items in _lists_of(query):
        _at_most(f"entries in '{name}'", len(items), MAX_ITEMS)
    if query.buffer is not None:
        _distance(query.buffer.distance_m)
    if isinstance(query.spatial_relation, m.DistanceRelation):
        _distance(query.spatial_relation.distance_m)


def _conditions_of(query: m.QueryObject) -> Iterator[m.Condition]:
    if query.where is not None:
        yield query.where
    if query.spatial_relation is not None and query.spatial_relation.where is not None:
        yield query.spatial_relation.where
    for column in query.columns:
        if column.where is not None:
            yield column.where


def _lists_of(query: m.QueryObject) -> Iterator[tuple[str, list[Any]]]:
    yield "order_by", query.order_by
    if query.select is not None:
        yield "select", query.select
    if query.attribute_join is not None:
        yield "fields", query.attribute_join.fields
    if query.aggregate is not None:
        yield "area_fields", query.aggregate.area_fields
        yield "metrics", query.aggregate.metrics


def _walk(c: m.Condition, depth: int, tally: _Tally) -> None:
    _at_most("nesting depth", depth, MAX_DEPTH)
    tally.conditions += 1
    if tally.conditions > MAX_CONDITIONS:  # stop early, before walking the rest
        _at_most("conditions", tally.conditions, MAX_CONDITIONS)
    match c:
        case m.And() | m.Or():
            for arg in c.args:
                _walk(arg, depth + 1, tally)
        case m.Not():
            _walk(c.arg, depth + 1, tally)
        case m.InList():
            _at_most("values in one list", len(c.values), MAX_LIST_VALUES)
            tally.values += len(c.values)
        case m.Compare():
            tally.values += 1
        case m.Between():
            tally.values += 2
        case m.TextMatch():
            _at_most("text length", len(c.text), MAX_TEXT)
            tally.values += 1
        case m.GeometryFilter():
            tally.vertices += _vertices(c.geometry.coordinates)
            _at_most("vertices of drawn geometries", tally.vertices, MAX_VERTICES)
        case m.NearFeature():
            _distance(c.distance_m)
        case m.RelatedByDistance():
            _distance(c.distance_m)
            if c.where is not None:
                _walk(c.where, depth + 1, tally)
        case m.RelatedTopological():
            if c.where is not None:
                _walk(c.where, depth + 1, tally)


def _vertices(coordinates: Any) -> int:
    """Positions in GeoJSON coordinates of any nesting: a position is a list of numbers.

    A loop, not recursion: the nesting comes from outside and may be deep.
    """
    count, stack = 0, [coordinates]
    while stack:
        item = stack.pop()
        if not isinstance(item, list) or not item:
            continue
        if all(isinstance(v, int | float) for v in item):
            count += 1
        else:
            stack.extend(item)
    return count


def _distance(meters: float) -> None:
    if meters > MAX_DISTANCE_M:
        raise QueryTooComplex(
            f"Distances are limited to {MAX_DISTANCE_M / 1000:g} km.",
            limit="distance_m",
            max=MAX_DISTANCE_M,
            found=meters,
        )


def _at_most(what: str, found: int, maximum: int) -> None:
    if found > maximum:
        raise QueryTooComplex(
            f"The query is too large: {what} {found}, at most {maximum}.",
            limit=what,
            max=maximum,
            found=found,
        )
