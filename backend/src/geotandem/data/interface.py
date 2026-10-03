"""Backend-neutral interface of the data-access layer (F-10.1, F-2.11).

The execution engine builds SQLAlchemy Core expressions against the tables
this layer hands out, and uses the ``SpatialDialect`` for every spatial
function. Nothing outside ``geotandem.data`` may emit backend-specific SQL.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal, Protocol

from shapely.geometry.base import BaseGeometry
from sqlalchemy import ColumnElement, Engine, FromClause, Select, Table

AttributeType = Literal["integer", "real", "text", "boolean", "date"]
LayerKind = Literal["vector", "table"]
TextMode = Literal["contains", "starts_with", "ends_with", "equals"]


class Op(StrEnum):
    """Registered operations; each needs certain logical dialect functions (F-2.14)."""

    ATTRIBUTE_FILTER = "attribute_filter"
    BBOX_FILTER = "bbox_filter"
    GEOMETRY_FILTER = "geometry_filter"
    NEAR_FEATURE = "near_feature"
    ATTRIBUTE_JOIN = "attribute_join"
    BUFFER = "buffer"
    SPATIAL_RELATION = "spatial_relation"
    AGGREGATE = "aggregate"


# Logical spatial functions each operation relies on. A dialect maps each to
# the backend's SQL function; the startup check verifies they exist.
OP_REQUIREMENTS: Mapping[Op, frozenset[str]] = {
    Op.ATTRIBUTE_FILTER: frozenset(),
    Op.ATTRIBUTE_JOIN: frozenset(),
    Op.BBOX_FILTER: frozenset({"intersects", "envelope", "transform"}),
    Op.GEOMETRY_FILTER: frozenset({"intersects", "within", "contains", "from_geojson"}),
    Op.NEAR_FEATURE: frozenset({"distance"}),
    Op.BUFFER: frozenset({"buffer"}),
    Op.SPATIAL_RELATION: frozenset({"intersects", "within", "contains", "distance"}),
    Op.AGGREGATE: frozenset({"within", "intersects"}),
}


@dataclass(frozen=True)
class AttributeSpec:
    name: str
    data_type: AttributeType
    label: str = ""
    description: str = ""
    unit: str | None = None
    value_domain: dict[str, Any] | None = None
    for_model: bool = True
    references: str | None = None
    """``layer.attribute`` this attribute is a key to (F-2.9)."""


@dataclass(frozen=True)
class NewLayer:
    """A layer to be stored. Geometries must already be in the internal CRS."""

    name: str
    title: str
    kind: LayerKind
    attributes: Sequence[AttributeSpec]
    rows: Iterable[tuple[BaseGeometry | None, Mapping[str, Any]]]
    description: str = ""
    source: str = ""
    dataset_version: str | None = None
    geometry_type: str | None = None
    """Declared geometry type; derived from the rows if ``None`` (vector layers only)."""
    for_model: bool = True


@dataclass(frozen=True)
class Limits:
    """Server-side limits (F-9.6)."""

    max_features: int
    timeout_s: float


class LayerExists(Exception):
    """``create_layer`` found the name taken, e.g. by an import committed meanwhile."""

    def __init__(self, name: str) -> None:
        super().__init__(f"A layer '{name}' already exists.")
        self.name = name


class QueryTimeout(Exception):
    """The query ran longer than ``Limits.timeout_s``."""


class SpatialDialect(Protocol):
    """Narrow per-backend adapter for spatial SQL (tech-stack 3.3)."""

    functions: Mapping[str, str]
    """Logical function name → SQL function name on this backend."""

    def intersects(self, a: Any, b: Any) -> ColumnElement[bool]: ...
    def within(self, a: Any, b: Any) -> ColumnElement[bool]: ...
    def contains(self, a: Any, b: Any) -> ColumnElement[bool]: ...
    def dwithin(self, a: Any, b: Any, meters: float) -> ColumnElement[bool]: ...
    def distance(self, a: Any, b: Any) -> ColumnElement[float]: ...
    def buffer(self, geom: Any, meters: float) -> ColumnElement[Any]: ...
    def transform(self, geom: Any, srid: int) -> ColumnElement[Any]: ...
    def as_geojson(self, geom: Any) -> ColumnElement[str]: ...
    def from_geojson(self, geojson: str, srid: int) -> ColumnElement[Any]: ...
    def envelope(
        self, min_x: float, min_y: float, max_x: float, max_y: float, srid: int
    ) -> ColumnElement[Any]: ...

    def text_match(
        self, column: Any, text: str, mode: TextMode, case_sensitive: bool
    ) -> ColumnElement[bool]:
        """Text search with identical semantics on every backend (F-2.14)."""
        ...

    def text_order(self, expr: Any) -> ColumnElement[Any]:
        """``expr`` compared and sorted by the text rules (data/text.py, F-2.14)."""
        ...

    def index_candidates(
        self, table: FromClause, search: Any, expand_m: float = 0
    ) -> ColumnElement[bool] | None:
        """Optional spatial-index prefilter on ``table`` (or an alias of it).

        Returns ``None`` where the backend's planner uses the index by itself.
        """
        ...


class DataBackend(Protocol):
    name: str
    engine: Engine
    dialect: SpatialDialect
    internal_srid: int

    def layer_table(self, name: str) -> Table:
        """Core table of a registered layer. Raises ``KeyError`` if unknown."""
        ...

    def layer_names(self) -> list[str]: ...

    def create_layer(self, layer: NewLayer) -> int:
        """Create table, spatial index and registry entry; return the feature count.

        Raises ``LayerExists`` if the name is taken, also when another create
        committed it after the caller last looked.
        """
        ...

    def replace_layer(self, name: str, layer: NewLayer) -> int:
        """Replace the content of an existing layer in one transaction (F-2.7).

        Keeps the registry entry (id, title, description, ``for_model``,
        visibility) and the curated metadata of attributes whose name is
        unchanged; takes geometry, rows, source and ``dataset_version`` from
        ``layer``. ``layer.name`` is ignored. Returns the feature count.
        """
        ...

    def drop_layer(self, name: str) -> None: ...

    def duplicate_layer(self, name: str, new_name: str, title: str) -> int:
        """Copy rows, geometry and attribute metadata of ``name`` (design D2).

        The copy is a layer of its own: same content, its own name and title.
        Raises ``LayerExists`` if ``new_name`` is taken. Returns the feature count.
        """
        ...

    def execute(self, stmt: Select[Any], limits: Limits) -> list[dict[str, Any]]:
        """Run a read-only statement under the given limits."""
        ...

    def missing_functions(self) -> dict[Op, list[str]]:
        """Operations this backend cannot perform, with the missing SQL functions (F-2.14)."""
        ...


@dataclass
class Capabilities:
    backend: str
    missing: dict[Op, list[str]] = field(default_factory=dict)

    @property
    def supported(self) -> list[Op]:
        return [op for op in Op if op not in self.missing]
