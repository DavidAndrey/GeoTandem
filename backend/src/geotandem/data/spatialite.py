"""SpatiaLite implementation of the data-access layer (F-2.11)."""

from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Mapping, Sequence
from typing import Any

from geoalchemy2 import Geometry
from geoalchemy2.shape import from_shape
from pyproj import Transformer
from shapely import wkb
from shapely.geometry import MultiLineString, MultiPoint, MultiPolygon
from shapely.geometry.base import BaseGeometry
from sqlalchemy import (
    Alias,
    Boolean,
    Column,
    ColumnElement,
    Connection,
    Date,
    Engine,
    Float,
    FromClause,
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

from geotandem.data import text as text_rules
from geotandem.data.interface import (
    OP_REQUIREMENTS,
    AttributeSpec,
    AttributeType,
    LayerExists,
    Limits,
    NewLayer,
    Op,
    QueryTimeout,
    SpatialDialect,
    TextMode,
)
from geotandem.db.orm import Layer, LayerAttribute
from geotandem.db.spatialite import READ_ONLY
from geotandem.geo import common_geometry_type

TABLE_PREFIX = "lyr_"
GEOM = "geom"
FID = "fid"

_SQL_TYPES: Mapping[AttributeType, type[TypeEngine[Any]]] = {
    "integer": Integer,
    "real": Float,
    "text": Text,
    "boolean": Boolean,
    # ISO text in SQLite, a native date in PostGIS: the same order and equality (F-2.14).
    "date": Date,
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
        # Explicit, not SpatiaLite's default: the same shape on every backend (F-2.14).
        return func.ST_Buffer(geom, meters, text_rules.BUFFER_QUADRANT_SEGMENTS)

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

    def text_match(
        self, column: Any, text: str, mode: TextMode, case_sensitive: bool
    ) -> ColumnElement[bool]:
        # SQLite's LIKE ignores ASCII case, so case-sensitive matching uses GLOB.
        # Case-insensitive matching folds both sides with the same Unicode rule
        # (data/text.py), not SQLite's ASCII-only lower() (F-2.14).
        fold: Any = getattr(func, text_rules.LOWER)
        if mode == "equals":
            if case_sensitive:
                return column == text  # type: ignore[no-any-return]
            return fold(column) == text_rules.lower(text)  # type: ignore[no-any-return]
        if case_sensitive:
            escaped = "".join(f"[{ch}]" if ch in "*?[" else ch for ch in text)
            pattern = {
                "contains": f"*{escaped}*",
                "starts_with": f"{escaped}*",
                "ends_with": f"*{escaped}",
            }[mode]
            return column.op("GLOB")(pattern)  # type: ignore[no-any-return]
        lowered = fold(column)
        needle = text_rules.lower(text) or ""
        if mode == "contains":
            return lowered.contains(needle, autoescape=True)  # type: ignore[no-any-return]
        if mode == "starts_with":
            return lowered.startswith(needle, autoescape=True)  # type: ignore[no-any-return]
        return lowered.endswith(needle, autoescape=True)  # type: ignore[no-any-return]

    def text_order(self, expr: Any) -> ColumnElement[Any]:
        return expr.collate(text_rules.COLLATION)  # type: ignore[no-any-return]

    def index_candidates(
        self, table: FromClause, search: Any, expand_m: float = 0
    ) -> ColumnElement[bool] | None:
        # SpatiaLite never uses the R-tree implicitly; query the SpatialIndex
        # virtual table. ``fid`` is the rowid alias.
        base = table.element if isinstance(table, Alias) else table
        frame = func.ST_Expand(search, expand_m) if expand_m else search
        candidates = select(_SPATIAL_INDEX.c.rowid).where(
            _SPATIAL_INDEX.c.f_table_name == getattr(base, "name", None),
            _SPATIAL_INDEX.c.f_geometry_column == GEOM,
            _SPATIAL_INDEX.c.search_frame == frame,
        )
        return table.c[FID].in_(candidates)


class SpatiaLiteBackend:
    name = "spatialite"

    def __init__(self, engine: Engine, internal_srid: int) -> None:
        self.engine = engine
        self.internal_srid = internal_srid
        self.dialect: SpatialDialect = SpatiaLiteDialect()
        # Table definitions of registered layers, shared by all request threads.
        # Only ``layer_table`` adds to it and ``_forget`` removes, both under the
        # lock; a layer being created or replaced is defined on its own MetaData
        # until committed, so a failed or concurrent write never touches it.
        self._metadata = MetaData()
        self._lock = threading.Lock()

    # --- layers ----------------------------------------------------------------

    def layer_names(self) -> list[str]:
        with Session(self.engine) as session:
            return list(session.scalars(select(Layer.name).order_by(Layer.name)))

    def layer_table(self, name: str) -> Table:
        with self._lock:
            cached = self._metadata.tables.get(TABLE_PREFIX + name)
            if cached is not None:
                return cached
            with Session(self.engine) as session:
                layer = session.scalar(select(Layer).where(Layer.name == name))
                if layer is None:
                    raise KeyError(name)
                specs = [
                    AttributeSpec(name=a.name, data_type=a.data_type)  # type: ignore[arg-type]
                    for a in layer.attributes
                ]
                return self._table(name, specs, layer.geometry_type, self._metadata)

    def _table(
        self,
        name: str,
        attrs: list[AttributeSpec],
        geometry_type: str | None,
        metadata: MetaData,
    ) -> Table:
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
        return Table(TABLE_PREFIX + name, metadata, *columns)

    def create_layer(self, layer: NewLayer) -> int:
        rows, geometry_type = _prepare(layer)
        table = self._table(layer.name, list(layer.attributes), geometry_type, MetaData())
        with Session(self.engine) as session, session.begin():
            # BEGIN IMMEDIATE (db.spatialite): no other writer between check and create.
            if session.scalar(select(Layer.id).where(Layer.name == layer.name)) is not None:
                raise LayerExists(layer.name)
            conn = session.connection()
            table.create(conn)
            self._insert(conn, table, layer, rows, geometry_type)
            session.add(
                Layer(
                    name=layer.name,
                    title=layer.title,
                    description=layer.description,
                    kind=layer.kind,
                    for_model=layer.for_model,
                    attributes=[_attribute(a, i) for i, a in enumerate(layer.attributes)],
                    **self._content(layer, rows, geometry_type),
                )
            )
        return len(rows)

    def duplicate_layer(self, name: str, new_name: str, title: str) -> int:
        source = self.layer_table(name)
        with Session(self.engine) as session:
            entry = session.scalar(select(Layer).where(Layer.name == name))
            if entry is None:
                raise KeyError(name)
            specs = [
                AttributeSpec(
                    name=a.name,
                    data_type=a.data_type,  # type: ignore[arg-type]
                    label=a.label,
                    description=a.description,
                    unit=a.unit,
                    value_domain=a.value_domain,
                    for_model=a.for_model,
                    references=a.references,
                )
                for a in entry.attributes
            ]
            meta = (entry.kind, entry.description, entry.geometry_type, entry.dataset_version)
            for_model = entry.for_model
            geom = source.c.get(GEOM)
            columns: list[ColumnElement[Any]] = [source.c[s.name] for s in specs]
            if geom is not None:
                columns.append(func.ST_AsBinary(geom).label(GEOM))
            stored = session.execute(select(*columns).order_by(source.c[FID])).mappings().all()
        kind, description, geometry_type, version = meta
        rows = [
            (
                wkb.loads(bytes(r[GEOM])) if geom is not None and r[GEOM] is not None else None,
                {s.name: r[s.name] for s in specs},
            )
            for r in stored
        ]
        return self.create_layer(
            NewLayer(
                name=new_name,
                title=title,
                kind=kind,  # type: ignore[arg-type]
                attributes=specs,
                rows=rows,
                description=description,
                source=f"Kopie von {name}",
                dataset_version=version,
                geometry_type=geometry_type,
                for_model=for_model,
            )
        )

    def replace_layer(self, name: str, layer: NewLayer) -> int:
        old = self.layer_table(name)
        rows, geometry_type = _prepare(layer)
        table = self._table(name, list(layer.attributes), geometry_type, MetaData())
        with Session(self.engine) as session, session.begin():
            conn = session.connection()
            old.drop(conn)
            table.create(conn)
            self._insert(conn, table, layer, rows, geometry_type)
            entry = session.scalar(select(Layer).where(Layer.name == name))
            assert entry is not None
            entry.kind = layer.kind
            for key, value in self._content(layer, rows, geometry_type).items():
                setattr(entry, key, value)
            _merge_attributes(session, entry, layer.attributes)
        # Committed: the next access reads the new columns from the registry.
        self._forget(name)
        return len(rows)

    def _insert(
        self,
        conn: Connection,
        table: Table,
        layer: NewLayer,
        rows: list[tuple[BaseGeometry | None, Mapping[str, Any]]],
        geometry_type: str | None,
    ) -> None:
        if not rows:
            return
        conn.execute(
            table.insert(),
            [
                {
                    **{a.name: attrs.get(a.name) for a in layer.attributes},
                    # Every row carries the same keys, as executemany requires.
                    **(
                        {GEOM: None if geom is None else from_shape(geom, srid=self.internal_srid)}
                        if geometry_type
                        else {}
                    ),
                }
                for geom, attrs in rows
            ],
        )

    def _content(
        self,
        layer: NewLayer,
        rows: list[tuple[BaseGeometry | None, Mapping[str, Any]]],
        geometry_type: str | None,
    ) -> dict[str, Any]:
        """Registry fields that follow the data, as opposed to curated ones."""
        return {
            "geometry_type": geometry_type,
            "srid": self.internal_srid if geometry_type else None,
            "feature_count": len(rows),
            "bbox_wgs84": self._bbox_wgs84(rows) if geometry_type else None,
            "source": layer.source,
            "dataset_version": layer.dataset_version,
        }

    def _forget(self, name: str) -> None:
        """Drop a cached table definition so the next access reloads it from the registry."""
        with self._lock:
            table = self._metadata.tables.get(TABLE_PREFIX + name)
            if table is not None:
                self._metadata.remove(table)

    def drop_layer(self, name: str) -> None:
        table = self.layer_table(name)
        with Session(self.engine) as session, session.begin():
            table.drop(session.connection())
            layer = session.scalar(select(Layer).where(Layer.name == name))
            session.delete(layer)
        self._forget(name)

    def _bbox_wgs84(
        self, rows: list[tuple[BaseGeometry | None, Mapping[str, Any]]]
    ) -> list[float] | None:
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
        with self.engine.connect().execution_options(**{READ_ONLY: True}) as conn:
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


def _prepare(
    layer: NewLayer,
) -> tuple[list[tuple[BaseGeometry | None, Mapping[str, Any]]], str | None]:
    """Materialise the rows and settle the geometry type (promoting to Multi* if needed)."""
    names = {a.name for a in layer.attributes}
    if {FID, GEOM} & names:
        raise ValueError(f"attribute names '{FID}' and '{GEOM}' are reserved")
    rows = list(layer.rows)
    if layer.kind != "vector":
        return rows, None
    geometry_type = layer.geometry_type or common_geometry_type(g for g, _ in rows)
    if geometry_type.startswith("Multi"):
        rows = [(_to_multi(g), attrs) for g, attrs in rows]
    if geometry_type != "Geometry":
        wrong = {g.geom_type for g, _ in rows if g is not None} - {geometry_type}
        if wrong:
            raise ValueError(
                f"layer '{layer.name}' is declared {geometry_type} but contains "
                + ", ".join(sorted(wrong))
            )
    return rows, geometry_type


def _attribute(spec: AttributeSpec, position: int) -> LayerAttribute:
    return LayerAttribute(
        name=spec.name,
        position=position,
        data_type=spec.data_type,
        label=spec.label,
        description=spec.description,
        unit=spec.unit,
        value_domain=spec.value_domain,
        for_model=spec.for_model,
        references=spec.references,
    )


def _merge_attributes(session: Session, entry: Layer, specs: Sequence[AttributeSpec]) -> None:
    """Keep curated metadata of attributes that survive a replace; add and drop the rest.

    Existing rows are updated in place: deleting and re-inserting the same
    ``(layer_id, name)`` in one flush would trip the unique constraint.
    """
    existing = {a.name: a for a in entry.attributes}
    wanted = {s.name for s in specs}
    for name, attribute in existing.items():
        if name not in wanted:
            entry.attributes.remove(attribute)
    session.flush()
    for position, spec in enumerate(specs):
        kept = existing.get(spec.name)
        if kept is None:
            entry.attributes.append(_attribute(spec, position))
        else:
            kept.position = position
            kept.data_type = spec.data_type


def _to_multi(geom: BaseGeometry | None) -> BaseGeometry | None:
    if geom is None or geom.geom_type.startswith("Multi"):
        return geom
    return _MULTI[geom.geom_type]([geom])
