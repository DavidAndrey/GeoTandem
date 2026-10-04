"""Translate a query object into one SQLAlchemy Core statement (E1.2).

Follows the evaluation order documented in ``geotandem_query.models``. All
spatial and text functions go through the backend's ``SpatialDialect``; no
SQL is written here, so the same compiler serves every backend (F-10.1).
"""

from __future__ import annotations

import json
import operator
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import shapely
from shapely.geometry import shape
from sqlalchemy import (
    ColumnElement,
    FromClause,
    Select,
    and_,
    exists,
    func,
    literal,
    not_,
    or_,
    select,
)

from geotandem.data import DataBackend, Op
from geotandem.engine import complexity
from geotandem.engine.errors import (
    AttributeNotNumeric,
    AttributeNotText,
    InvalidQueryGeometry,
    KeyTypeMismatch,
    NameClash,
    UnknownAttribute,
    UnknownLayer,
    UnsupportedOperation,
    WrongValueType,
)
from geotandem_query import models as m

FID = "fid"
GEOM = "geom"
GEOJSON = "__geojson"
WGS84 = 4326

_ORDERING = frozenset({"lt", "le", "gt", "ge"})

_COMPARE: dict[str, Callable[[Any, Any], ColumnElement[bool]]] = {
    "eq": operator.eq,
    "ne": operator.ne,
    "lt": operator.lt,
    "le": operator.le,
    "gt": operator.gt,
    "ge": operator.ge,
}


@dataclass
class Scope:
    """What a layer offers at one point of the pipeline: attributes and geometry."""

    layer: str
    table: FromClause
    columns: dict[str, ColumnElement[Any]]
    geom: ColumnElement[Any] | None

    def attr(self, name: str) -> ColumnElement[Any]:
        try:
            return self.columns[name]
        except KeyError:
            available = sorted(self.columns)
            raise UnknownAttribute(
                f"Layer '{self.layer}' has no attribute '{name}'. "
                f"Available: {', '.join(available)}.",
                layer=self.layer,
                attribute=name,
                available=available,
            ) from None

    def require_geom(self, operation: str) -> ColumnElement[Any]:
        if self.geom is None:
            raise UnsupportedOperation(
                f"'{operation}' needs geometry, but '{self.layer}' is a table layer.",
                layer=self.layer,
                operation=operation,
            )
        return self.geom


@dataclass
class Compiled:
    stmt: Select[Any]
    layers: list[str] = field(default_factory=list)
    ops: set[Op] = field(default_factory=set)


class Compiler:
    def __init__(self, backend: DataBackend, unsupported: Iterable[Op] = ()) -> None:
        self.backend = backend
        self.dialect = backend.dialect
        self.srid = backend.internal_srid
        self.unsupported = frozenset(unsupported)
        self.layers: list[str] = []
        self.ops: set[Op] = set()
        self._aliases = 0

    # --- building blocks -------------------------------------------------------

    def use(self, op: Op) -> None:
        if op in self.unsupported:
            raise UnsupportedOperation(
                f"The {self.backend.name} backend cannot perform '{op}'.",
                operation=str(op),
                backend=self.backend.name,
            )
        self.ops.add(op)

    def scope(self, layer: str) -> Scope:
        try:
            table = self.backend.layer_table(layer)
        except KeyError:
            available = self.backend.layer_names()
            raise UnknownLayer(
                f"Unknown layer '{layer}'. Available: {', '.join(available)}.",
                layer=layer,
                available=available,
            ) from None
        if layer not in self.layers:
            self.layers.append(layer)
        self._aliases += 1
        alias = table.alias(f"t{self._aliases}")
        columns: dict[str, ColumnElement[Any]] = {c.name: c for c in alias.c if c.name != GEOM}
        return Scope(layer, alias, columns, alias.c.get(GEOM))

    def indexed(
        self, scope: Scope, search: Any, cond: ColumnElement[bool], expand_m: float = 0
    ) -> ColumnElement[bool]:
        """Add the backend's spatial-index prefilter on ``scope`` to ``cond``."""
        prefilter = self.dialect.index_candidates(scope.table, search, expand_m)
        return cond if prefilter is None else and_(prefilter, cond)

    def geojson(self, geom: ColumnElement[Any]) -> ColumnElement[Any]:
        d = self.dialect
        return d.as_geojson(d.transform(geom, WGS84)).label(GEOJSON)

    def input_geometry(self, geometry: m.GeoJSONGeometry) -> ColumnElement[Any]:
        data = geometry.model_dump()
        try:
            geom = shape(data)
        except (ValueError, TypeError, IndexError, shapely.errors.GEOSException) as exc:
            raise InvalidQueryGeometry(f"Malformed GeoJSON geometry: {exc}") from None
        if not geom.is_valid:
            reason = shapely.is_valid_reason(geom)
            raise InvalidQueryGeometry(f"Invalid geometry: {reason}", reason=reason)
        d = self.dialect
        return d.transform(d.from_geojson(json.dumps(data), WGS84), self.srid)

    # --- conditions ------------------------------------------------------------

    def condition(self, c: m.Condition, scope: Scope) -> ColumnElement[bool]:
        d = self.dialect
        match c:
            case m.And():
                return and_(*(self.condition(a, scope) for a in c.args))
            case m.Or():
                return or_(*(self.condition(a, scope) for a in c.args))
            case m.Not():
                return not_(self.condition(c.arg, scope))
            case m.Compare():
                self.use(Op.ATTRIBUTE_FILTER)
                col = scope.attr(c.attr)
                [value] = _check_values(scope, c.attr, col, [c.value])
                if c.cmp in _ORDERING and _python_type(col) is str:
                    # "before / after" in text follows the text rules, not bytes (F-2.14).
                    return _COMPARE[c.cmp](d.text_order(col), value)
                return _COMPARE[c.cmp](col, value)
            case m.Between():
                self.use(Op.ATTRIBUTE_FILTER)
                col = scope.attr(c.attr)
                _check_values(scope, c.attr, col, [c.min, c.max])
                return col.between(c.min, c.max)
            case m.InList():
                self.use(Op.ATTRIBUTE_FILTER)
                col = scope.attr(c.attr)
                return col.in_(_check_values(scope, c.attr, col, c.values))
            case m.TextMatch():
                self.use(Op.ATTRIBUTE_FILTER)
                col = scope.attr(c.attr)
                if _python_type(col) is not str:
                    raise AttributeNotText(
                        f"'text_match' needs a text attribute; '{c.attr}' is not.",
                        attribute=c.attr,
                    )
                return d.text_match(col, c.text, c.mode, c.case_sensitive)
            case m.IsNull():
                return scope.attr(c.attr).is_(None)
            case m.BBox():
                self.use(Op.BBOX_FILTER)
                geom = scope.require_geom("bbox")
                frame = d.transform(d.envelope(*c.bbox, WGS84), self.srid)
                return self.indexed(scope, frame, d.intersects(geom, frame))
            case m.GeometryFilter():
                self.use(Op.GEOMETRY_FILTER)
                geom = scope.require_geom("geometry")
                drawn = self.input_geometry(c.geometry)
                predicate = {"intersects": d.intersects, "within": d.within, "contains": d.contains}
                return self.indexed(scope, drawn, predicate[c.predicate](geom, drawn))
            case m.NearFeature():
                self.use(Op.NEAR_FEATURE)
                geom = scope.require_geom("near_feature")
                ref = self.scope(c.layer)
                ref_geom = ref.require_geom("near_feature")
                return exists(
                    select(literal(1)).where(
                        ref.columns[FID] == c.fid, d.distance(geom, ref_geom) <= c.distance_m
                    )
                )
            case m.RelatedTopological() | m.RelatedByDistance():
                # The same semi-join as the top-level relation, so NOT and OR apply
                # to it like to any other condition (schema v1).
                return self.spatial_relation(c, scope.require_geom("related"))
        raise AssertionError(f"unhandled condition {c!r}")  # pragma: no cover

    # --- operations ------------------------------------------------------------

    def attribute_join(self, join: m.AttributeJoin, src: Scope) -> None:
        """Expose joined fields as correlated scalar subqueries.

        A subquery per field (first match by ``fid``) can never multiply source
        features, whatever the key cardinality.
        """
        self.use(Op.ATTRIBUTE_JOIN)
        right = self.scope(join.layer)
        left_key, right_key = src.attr(join.left_key), right.attr(join.right_key)
        kinds = (_kind(left_key), _kind(right_key))
        if None not in kinds and kinds[0] != kinds[1]:
            # SQLite would match text "101" with the number 101, PostgreSQL would not:
            # refused on every backend (F-2.14).
            raise KeyTypeMismatch(
                f"Join keys differ in type: '{join.left_key}' is {kinds[0]}, "
                f"'{join.right_key}' of '{join.layer}' is {kinds[1]}.",
                left_key=join.left_key,
                right_key=join.right_key,
            )
        for name in join.fields:
            target = (join.prefix or "") + name
            if target in src.columns:
                raise NameClash(
                    f"Joined attribute '{target}' clashes with an attribute of "
                    f"'{src.layer}'; set 'prefix'.",
                    attribute=target,
                )
            src.columns[target] = (
                select(right.attr(name))
                .where(right_key == left_key)
                .order_by(right.columns[FID])
                .limit(1)
                .scalar_subquery()
            )

    def spatial_relation(
        self, rel: m.TopologicalRelation | m.DistanceRelation, geom: Any
    ) -> ColumnElement[bool]:
        self.use(Op.SPATIAL_RELATION)
        d = self.dialect
        other = self.scope(rel.layer)
        other_geom = other.require_geom("spatial_relation")
        distance = 0.0
        if isinstance(rel, m.DistanceRelation):
            distance = rel.distance_m
            cond = d.dwithin(geom, other_geom, distance)
        elif rel.predicate == "intersects":
            cond = d.intersects(geom, other_geom)
        elif rel.predicate == "within":
            cond = d.within(geom, other_geom)
        else:
            cond = d.contains(geom, other_geom)
        conds = [self.indexed(other, geom, cond, distance)]
        if rel.where is not None:
            conds.append(self.condition(rel.where, other))
        return exists(select(literal(1)).where(*conds))

    def computed_columns(
        self, columns: list[m.Column], geom: Any, namespace: dict[str, ColumnElement[Any]]
    ) -> None:
        """Add each computed column (v2) as a correlated scalar subquery on ``geom``."""
        d = self.dialect
        for column in columns:
            if column.name in namespace:
                raise NameClash(
                    f"Computed column '{column.name}' clashes with another result attribute.",
                    attribute=column.name,
                )
            self.use(Op.SPATIAL_RELATION)
            other = self.scope(column.layer)
            other_geom = other.require_geom(column.fn)
            conds = [] if column.where is None else [self.condition(column.where, other)]
            if isinstance(column, m.DistanceColumn):
                # Unbounded nearest search: no index prefilter applies.
                expr = select(func.min(d.distance(geom, other_geom))).where(*conds)
            else:
                relate = d.within if column.predicate == "within" else d.intersects
                expr = (
                    select(other.attr(column.attr))
                    .where(self.indexed(other, geom, relate(geom, other_geom)), *conds)
                    .order_by(other.columns[FID])
                    .limit(1)
                )
            namespace[column.name] = expr.scalar_subquery()

    # --- query -----------------------------------------------------------------

    def compile(self, q: m.QueryObject, max_features: int) -> Compiled:
        src = self.scope(q.source)
        if q.attribute_join is not None:
            self.attribute_join(q.attribute_join, src)
        filters = [] if q.where is None else [self.condition(q.where, src)]
        geom = src.geom
        if q.buffer is not None:
            self.use(Op.BUFFER)
            geom = self.dialect.buffer(src.require_geom("buffer"), q.buffer.distance_m)
        if q.spatial_relation is not None:
            if geom is None:
                src.require_geom("spatial_relation")
            filters.append(self.spatial_relation(q.spatial_relation, geom))

        if q.aggregate is not None:
            if geom is None:
                src.require_geom("aggregate")
            return self.aggregate(q, q.aggregate, src, geom, filters, max_features)

        namespace = src.columns
        if q.columns:
            if geom is None:
                src.require_geom("columns")
            self.computed_columns(q.columns, geom, namespace)
        columns = _output_columns(q.select, namespace)
        if geom is not None:
            columns.append(self.geojson(geom))
        stmt = select(*columns).select_from(src.table).where(*filters)
        return self._finish(stmt, q, namespace, max_features)

    def aggregate(
        self,
        q: m.QueryObject,
        agg: m.Aggregate,
        src: Scope,
        geom: Any,
        filters: list[ColumnElement[bool]],
        max_features: int,
    ) -> Compiled:
        self.use(Op.AGGREGATE)
        inputs = sorted({m_.attr for m_ in agg.metrics if isinstance(m_, m.ValueMetric)})
        for name in inputs:
            _check_numeric(src, name, src.attr(name))
        features = (
            select(
                src.columns[FID].label(FID),
                geom.label(GEOM),
                *(src.attr(name).label(name) for name in inputs),
            )
            .select_from(src.table)
            .where(*filters)
            .subquery("features")
        )
        area = self.scope(agg.by_layer)
        area_geom = area.require_geom("aggregate")
        relate = self.dialect.within if agg.predicate == "within" else self.dialect.intersects

        namespace: dict[str, ColumnElement[Any]] = {FID: area.columns[FID]}
        for name in agg.area_fields:
            namespace[name] = area.attr(name)
        for metric in agg.metrics:
            if metric.as_ in namespace:
                raise NameClash(
                    f"Metric name '{metric.as_}' clashes with another result attribute.",
                    attribute=metric.as_,
                )
            if isinstance(metric, m.CountMetric):
                namespace[metric.as_] = func.count(features.c[FID])
            else:
                namespace[metric.as_] = getattr(func, metric.fn)(features.c[metric.attr])

        self.computed_columns(q.columns, area_geom, namespace)
        columns = [*_output_columns(q.select, namespace), self.geojson(area_geom)]
        stmt = (
            select(*columns)
            .select_from(area.table.outerjoin(features, relate(features.c[GEOM], area_geom)))
            .group_by(area.columns[FID])
        )
        return self._finish(stmt, q, namespace, max_features)

    def _finish(
        self,
        stmt: Select[Any],
        q: m.QueryObject,
        namespace: dict[str, ColumnElement[Any]],
        max_features: int,
    ) -> Compiled:
        for order in q.order_by:
            if order.attr not in namespace:
                available = sorted(namespace)
                raise UnknownAttribute(
                    f"Cannot order by '{order.attr}'. Available: {', '.join(available)}.",
                    attribute=order.attr,
                    available=available,
                )
            expr = namespace[order.attr]
            if _python_type(expr) is str:
                # Text sorts by the text rules ("Ägerten" with A), on every backend (F-2.14).
                expr = self.dialect.text_order(expr)
            # Explicit NULL placement: backends differ in their default.
            stmt = stmt.order_by(
                expr.desc().nulls_last() if order.dir == "desc" else expr.asc().nulls_last()
            )
        # fid as final tie-breaker: identical query, identical order (F-8.9).
        stmt = stmt.order_by(namespace[FID])
        # One row beyond the limit reveals an oversized result (F-9.6).
        fetch = max_features + 1 if q.limit is None else min(q.limit, max_features + 1)
        return Compiled(stmt.limit(fetch), self.layers, self.ops)


def _output_columns(
    select_: list[str] | None, namespace: dict[str, ColumnElement[Any]]
) -> list[ColumnElement[Any]]:
    names = list(namespace) if select_ is None else [FID, *(n for n in select_ if n != FID)]
    for name in names:
        if name not in namespace:
            available = sorted(namespace)
            raise UnknownAttribute(
                f"Cannot select '{name}'. Available: {', '.join(available)}.",
                attribute=name,
                available=available,
            )
    return [namespace[name].label(name) for name in names]


def _python_type(col: ColumnElement[Any]) -> type | None:
    try:
        return col.type.python_type
    except NotImplementedError:
        return None


def _kind(col: ColumnElement[Any]) -> str | None:
    """Number, text or boolean — the kinds that compare alike on every backend."""
    python = _python_type(col)
    if python is bool:
        return "boolean"
    if python in (int, float):
        return "number"
    if python is str:
        return "text"
    return None


def _check_numeric(scope: Scope, name: str, col: ColumnElement[Any]) -> None:
    if _python_type(col) not in (int, float):
        raise AttributeNotNumeric(
            f"Metric attribute '{name}' of '{scope.layer}' is not numeric.", attribute=name
        )


def _check_values(scope: Scope, name: str, col: ColumnElement[Any], values: list[Any]) -> list[Any]:
    """The values as the column holds them; a date is given as ISO text (plan E1.8, G3)."""
    expected = _python_type(col)
    if expected is None:
        return values
    checked = []
    for value in values:
        if expected is date:
            parsed = _iso_date(value)
            ok = parsed is not None
            checked.append(parsed)
        else:
            numeric = isinstance(value, int | float) and not isinstance(value, bool)
            ok = numeric if expected in (int, float) else isinstance(value, expected)
            checked.append(value)
        if not ok:
            hint = " as ISO text, e.g. '2024-03-01'" if expected is date else ""
            raise WrongValueType(
                f"Attribute '{name}' of '{scope.layer}' holds {expected.__name__} values{hint}; "
                f"got {value!r}.",
                attribute=name,
                expected=expected.__name__,
            )
    return checked


def _iso_date(value: Any) -> date | None:
    if not isinstance(value, str) or len(value) != 10:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def compile_query(
    q: m.QueryObject, backend: DataBackend, max_features: int, unsupported: Iterable[Op] = ()
) -> Compiled:
    """Every way a query runs or is checked comes through here, so do the bounds."""
    complexity.check(q)
    return Compiler(backend, unsupported).compile(q, max_features)
