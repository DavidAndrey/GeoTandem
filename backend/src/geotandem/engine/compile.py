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
from geotandem.engine.errors import (
    QueryError,
    UnknownAttribute,
    UnknownLayer,
    UnsupportedOperation,
)
from geotandem_query import models as m

FID = "fid"
GEOM = "geom"
GEOJSON = "__geojson"
WGS84 = 4326

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
            raise QueryError(f"Malformed GeoJSON geometry: {exc}") from None
        if not geom.is_valid:
            raise QueryError(f"Invalid geometry: {shapely.is_valid_reason(geom)}")
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
                _check_values(scope, c.attr, col, [c.value])
                return _COMPARE[c.cmp](col, c.value)
            case m.Between():
                self.use(Op.ATTRIBUTE_FILTER)
                col = scope.attr(c.attr)
                _check_values(scope, c.attr, col, [c.min, c.max])
                return col.between(c.min, c.max)
            case m.InList():
                self.use(Op.ATTRIBUTE_FILTER)
                col = scope.attr(c.attr)
                _check_values(scope, c.attr, col, c.values)
                return col.in_(c.values)
            case m.TextMatch():
                self.use(Op.ATTRIBUTE_FILTER)
                col = scope.attr(c.attr)
                if _python_type(col) is not str:
                    raise QueryError(
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
        for name in join.fields:
            target = (join.prefix or "") + name
            if target in src.columns:
                raise QueryError(
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

    def spatial_relation(self, rel: m.SpatialRelation, geom: Any) -> ColumnElement[bool]:
        self.use(Op.SPATIAL_RELATION)
        d = self.dialect
        other = self.scope(rel.layer)
        other_geom = other.require_geom("spatial_relation")
        match rel.predicate:
            case "intersects":
                cond = d.intersects(geom, other_geom)
            case "within":
                cond = d.within(geom, other_geom)
            case "contains":
                cond = d.contains(geom, other_geom)
            case "dwithin":
                assert rel.distance_m is not None
                cond = d.dwithin(geom, other_geom, rel.distance_m)
        conds = [self.indexed(other, geom, cond, rel.distance_m or 0)]
        if rel.where is not None:
            conds.append(self.condition(rel.where, other))
        return exists(select(literal(1)).where(*conds))

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
        inputs = sorted({metric.attr for metric in agg.metrics if metric.attr})
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
                raise QueryError(
                    f"Metric name '{metric.as_}' clashes with another result attribute.",
                    attribute=metric.as_,
                )
            if metric.fn == "count":
                namespace[metric.as_] = func.count(features.c[FID])
            else:
                assert metric.attr is not None
                namespace[metric.as_] = getattr(func, metric.fn)(features.c[metric.attr])

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


def _check_numeric(scope: Scope, name: str, col: ColumnElement[Any]) -> None:
    if _python_type(col) not in (int, float):
        raise QueryError(
            f"Metric attribute '{name}' of '{scope.layer}' is not numeric.", attribute=name
        )


def _check_values(scope: Scope, name: str, col: ColumnElement[Any], values: list[Any]) -> None:
    expected = _python_type(col)
    if expected is None:
        return
    for value in values:
        numeric = isinstance(value, int | float) and not isinstance(value, bool)
        ok = numeric if expected in (int, float) else isinstance(value, expected)
        if not ok:
            raise QueryError(
                f"Attribute '{name}' of '{scope.layer}' holds {expected.__name__} values; "
                f"got {value!r}.",
                attribute=name,
                expected=expected.__name__,
            )


def compile_query(
    q: m.QueryObject, backend: DataBackend, max_features: int, unsupported: Iterable[Op] = ()
) -> Compiled:
    return Compiler(backend, unsupported).compile(q, max_features)
