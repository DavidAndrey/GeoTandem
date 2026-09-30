"""SpatiaLite implementation of the data-access layer (F-2.11)."""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Mapping
from typing import Any

from geoalchemy2 import Geometry
from geoalchemy2.shape import from_shape
from pyproj import Transformer
from shapely.geometry import MultiLineString, MultiPoint, MultiPolygon
from shapely.geometry.base import BaseGeometry
from sqlalchemy import (
    Boolean,
    Column,
    ColumnElement,
    Engine,
    Float,
    Integer,
    MetaData,
    Select,
    Table,
    Text,
    column,
    func,
    literal,
    select,
    text,
)
from sqlalchemy import table as sa_table
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.types import TypeEngine

from geotandem.data.interface import (
    OP_REQUIREMENTS,
    AttributeSpec,
    AttributeType,
    Limits,
    NewLayer,
    Op,
    QueryTimeout,
)
from geotandem.db.orm import Layer, LayerAttribute

TABLE_PREFIX = "lyr_"
GEOM = "geom"
FID = "fid"

_SQL_TYPES: Mapping[AttributeType, type[TypeEngine[Any]]] = {
    "integer": Integer,
    "real": Float,
    "text": Text,
    "boolean": Boolean,
}

_SPATIAL_INDEX = sa_table(
    "SpatialIndex",
    column("rowid"),
    column("f_table_name"),
    column("f_geometry_column"),
    column("search_frame"),
)

_MULTI = {"Point": MultiPoint, "LineString": MultiLineString, "Polygon": MultiPolygon}


class SpatiaLiteDialect:
    functions: Mapping[str, str] = {
        "intersects": "ST_Intersects",
        "within": "ST_Within",
        "contains": "ST_Contains",
        "distance": "ST_Distance",
        "buffer": "ST_Buffer",
        "transform": "ST_Transform",
        "as_geojson": "AsGeoJSON",
        "from_geojson": "GeomFromGeoJSON",
        "envelope": "BuildMbr",
        "index": "ST_Expand",
    }

    # SpatiaLite predicates return 1/0/-1; compare explicitly.
    def intersects(self, a: Any, b: Any) -> ColumnElement[bool]:
        return func.ST_Intersects(a, b) == 1

    def within(self, a: Any, b: Any) -> ColumnElement[bool]:
        return func.ST_Within(a, b) == 1

    def contains(self, a: Any, b: Any) -> ColumnElement[bool]:
        return func.ST_Contains(a, b) == 1

    def distance(self, a: Any, b: Any) -> ColumnElement[float]:
        return func.ST_Distance(a, b)

    def dwithin(self, a: Any, b: Any, meters: float) -> ColumnElement[bool]:
        # SpatiaLite has no ST_DWithin; the planar distance is exact in the
        # metric internal CRS, and index_candidates() supplies the prefilter.
        return func.ST_Distance(a, b) <= meters

    def buffer(self, geom: Any, meters: float) -> ColumnElement[Any]:
        return func.ST_Buffer(geom, meters)

    def transform(self, geom: Any, srid: int) -> ColumnElement[Any]:
        return func.ST_Transform(geom, srid)

    def as_geojson(self, geom: Any) -> ColumnElement[str]:
        return func.AsGeoJSON(geom, 7)

    def from_geojson(self, geojson: str, srid: int) -> ColumnElement[Any]:
        return func.SetSRID(func.GeomFromGeoJSON(literal(geojson)), srid)

    def envelope(
        self, min_x: float, min_y: float, max_x: float, max_y: float, srid: int
    ) -> ColumnElement[Any]:
        return func.BuildMbr(min_x, min_y, max_x, max_y, srid)

    def index_candidates(
        self, table: Table, search: Any, expand_m: float = 0
    ) -> ColumnElement[bool] | None:
        # SpatiaLite never uses the R-tree implicitly; query the SpatialIndex
        # virtual table. ``fid`` is the rowid alias.
        frame = func.ST_Expand(search, expand_m) if expand_m else search
        candidates = select(_SPATIAL_INDEX.c.rowid).where(
            _SPATIAL_INDEX.c.f_table_name == table.name,
            _SPATIAL_INDEX.c.f_geometry_column == GEOM,
            _SPATIAL_INDEX.c.search_frame == frame,
        )
        return table.c[FID].in_(candidates)


class SpatiaLiteBackend:
    name = "spatialite"

    def __init__(self, engine: Engine, internal_srid: int) -> None:
        self.engine = engine
        self.internal_srid = internal_srid
        self.dialect = SpatiaLiteDialect()
        self._metadata = MetaData()

    # --- layers ----------------------------------------------------------------

    def layer_names(self) -> list[str]:
        with Session(self.engine) as session:
            return list(session.scalars(select(Layer.name).order_by(Layer.name)))

    def layer_table(self, name: str) -> Table:
        table_name = TABLE_PREFIX + name
        if table_name in self._metadata.tables:
            return self._metadata.tables[table_name]
        with Session(self.engine) as session:
            layer = session.scalar(select(Layer).where(Layer.name == name))
            if layer is None:
                raise KeyError(name)
            specs = [
                AttributeSpec(name=a.name, data_type=a.data_type)  # type: ignore[arg-type]
                for a in layer.attributes
            ]
            return self._table(name, specs, layer.geometry_type)

    def _table(self, name: str, attrs: list[AttributeSpec], geometry_type: str | None) -> Table:
        columns: list[Column[Any]] = [Column(FID, Integer, primary_key=True)]
        columns += [Column(a.name, _SQL_TYPES[a.data_type]) for a in attrs]
        if geometry_type is not None:
            columns.append(
                Column(
                    GEOM,
                    Geometry(
                        geometry_type=geometry_type.upper(),
                        srid=self.internal_srid,
                        spatial_index=True,
                    ),
                )
            )
        return Table(TABLE_PREFIX + name, self._metadata, *columns)

    def create_layer(self, layer: NewLayer) -> int:
        rows = list(layer.rows)
        geometry_type = _geometry_type(rows) if layer.kind == "vector" else None
        if geometry_type and geometry_type.startswith("Multi"):
            rows = [(_to_multi(g), attrs) for g, attrs in rows]
        names = {a.name for a in layer.attributes}
        if {FID, GEOM} & names:
            raise ValueError(f"attribute names '{FID}' and '{GEOM}' are reserved")

        table = self._table(layer.name, list(layer.attributes), geometry_type)
        with Session(self.engine) as session, session.begin():
            conn = session.connection()
            table.create(conn)
            if rows:
                conn.execute(
                    table.insert(),
                    [
                        {
                            **{a.name: attrs.get(a.name) for a in layer.attributes},
                            **(
                                {GEOM: from_shape(geom, srid=self.internal_srid)}
                                if geometry_type
                                else {}
                            ),
                        }
                        for geom, attrs in rows
                    ],
                )
            session.add(
                Layer(
                    name=layer.name,
                    title=layer.title,
                    description=layer.description,
                    kind=layer.kind,
                    geometry_type=geometry_type,
                    srid=self.internal_srid if geometry_type else None,
                    feature_count=len(rows),
                    bbox_wgs84=self._bbox_wgs84(rows) if geometry_type else None,
                    source=layer.source,
                    dataset_version=layer.dataset_version,
                    attributes=[
                        LayerAttribute(
                            name=a.name,
                            position=i,
                            data_type=a.data_type,
                            label=a.label,
                            description=a.description,
                            unit=a.unit,
                            value_domain=a.value_domain,
                        )
                        for i, a in enumerate(layer.attributes)
                    ],
                )
            )
        return len(rows)

    def drop_layer(self, name: str) -> None:
        table = self.layer_table(name)
        with Session(self.engine) as session, session.begin():
            table.drop(session.connection())
            layer = session.scalar(select(Layer).where(Layer.name == name))
            session.delete(layer)
        self._metadata.remove(table)

    def _bbox_wgs84(self, rows: list[tuple[BaseGeometry | None, Any]]) -> list[float] | None:
        bounds = [g.bounds for g, _ in rows if g is not None and not g.is_empty]
        if not bounds:
            return None
        to_wgs84 = Transformer.from_crs(self.internal_srid, 4326, always_xy=True)
        box = to_wgs84.transform_bounds(
            min(b[0] for b in bounds),
            min(b[1] for b in bounds),
            max(b[2] for b in bounds),
            max(b[3] for b in bounds),
        )
        return [round(v, 7) for v in box]

    # --- execution -------------------------------------------------------------

    def execute(self, stmt: Select[Any], limits: Limits) -> list[dict[str, Any]]:
        deadline = time.monotonic() + limits.timeout_s
        with self.engine.connect() as conn:
            raw = conn.connection.driver_connection
            assert isinstance(raw, sqlite3.Connection)
            # Read-only at the connection level: no analysis may write (F-9.5).
            raw.execute("PRAGMA query_only = ON")
            raw.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            try:
                return [dict(row) for row in conn.execute(stmt).mappings()]
            except OperationalError as exc:
                if "interrupted" in str(exc.orig):
                    raise QueryTimeout(f"query exceeded {limits.timeout_s:g} s") from exc
                raise
            finally:
                raw.set_progress_handler(None, 0)
                raw.execute("PRAGMA query_only = OFF")

    # --- capabilities (F-2.14) -------------------------------------------------

    def missing_functions(self) -> dict[Op, list[str]]:
        with self.engine.connect() as conn:
            available = {
                r[0].lower() for r in conn.execute(text("SELECT name FROM pragma_function_list"))
            }
        missing: dict[Op, list[str]] = {}
        for op, logical in OP_REQUIREMENTS.items():
            absent = sorted(
                self.dialect.functions[f]
                for f in logical
                if self.dialect.functions[f].lower() not in available
            )
            if absent:
                missing[op] = absent
        return missing


def _geometry_type(rows: list[tuple[BaseGeometry | None, Any]]) -> str:
    kinds: set[str] = {str(g.geom_type) for g, _ in rows if g is not None}
    if not kinds:
        return "Geometry"
    if len(kinds) == 1:
        return kinds.pop()
    base = {k.removeprefix("Multi") for k in kinds}
    if len(base) == 1:
        return "Multi" + base.pop()
    return "Geometry"


def _to_multi(geom: BaseGeometry | None) -> BaseGeometry | None:
    if geom is None or geom.geom_type.startswith("Multi"):
        return geom
    return _MULTI[geom.geom_type]([geom])
