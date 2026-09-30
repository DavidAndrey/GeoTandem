"""Query-object schema v0 — the single contract between UI, model and engine.

Evaluation order is fixed and independent of field order in the document:

1. ``source``          — the layer the result features come from
2. ``attribute_join``  — left join of a table layer by key; its fields become
                         addressable like source attributes
3. ``where``           — filter on source (and joined) attributes and geometry
4. ``buffer``          — replace each source geometry by its buffer
5. ``spatial_relation``— keep only features related to some feature of
                         another layer (semi-join, no duplicates)
6. ``aggregate``       — summarise the remaining features per feature of an
                         area layer; the result features become those areas
7. ``select`` / ``order_by`` / ``limit``

``symbology`` and ``output`` are render hints: validated, never executed.
Geometries in queries are GeoJSON in WGS84 (EPSG:4326); distances are metres.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from geotandem_query.version import SCHEMA_VERSION

Identifier = Annotated[
    str,
    Field(
        pattern=r"^[a-z_][a-z0-9_]{0,62}$",
        description="Lower-case layer or attribute name.",
    ),
]
Scalar = str | int | float | bool
HexColor = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]
Distance = Annotated[float, Field(gt=0, description="Distance in metres.")]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- Conditions ---------------------------------------------------------------


class Compare(_Model):
    """Attribute comparison with a constant (F-4.2)."""

    op: Literal["compare"]
    attr: Identifier
    cmp: Literal["eq", "ne", "lt", "le", "gt", "ge"]
    value: Scalar


class Between(_Model):
    """Inclusive value range (F-4.2)."""

    op: Literal["between"]
    attr: Identifier
    min: int | float
    max: int | float

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if self.min > self.max:
            raise ValueError("'min' must not be greater than 'max'")
        return self


class InList(_Model):
    """Value in list (F-4.2)."""

    op: Literal["in"]
    attr: Identifier
    values: Annotated[list[Scalar], Field(min_length=1)]


class TextMatch(_Model):
    """Text search in a string attribute (F-4.2)."""

    op: Literal["text_match"]
    attr: Identifier
    text: Annotated[str, Field(min_length=1)]
    mode: Literal["contains", "starts_with", "ends_with", "equals"] = "contains"
    case_sensitive: bool = False


class IsNull(_Model):
    """Attribute has no value. Combine with ``not`` for 'has a value'."""

    op: Literal["is_null"]
    attr: Identifier


class BBox(_Model):
    """Source geometry intersects a WGS84 bounding box, e.g. the map view (F-4.3)."""

    op: Literal["bbox"]
    bbox: tuple[float, float, float, float] = Field(
        description="[min_lon, min_lat, max_lon, max_lat] in WGS84."
    )

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        min_x, min_y, max_x, max_y = self.bbox
        if min_x > max_x or min_y > max_y:
            raise ValueError("bbox must be [min_lon, min_lat, max_lon, max_lat]")
        return self


class GeoJSONGeometry(_Model):
    """GeoJSON geometry in WGS84. Coordinates are checked when compiled."""

    type: Literal["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]
    coordinates: list[Any]


class GeometryFilter(_Model):
    """Source geometry relates to a drawn geometry (F-4.3)."""

    op: Literal["geometry"]
    geometry: GeoJSONGeometry
    predicate: Literal["intersects", "within", "contains"] = "intersects"


class NearFeature(_Model):
    """Source geometry lies within a distance of one reference feature (F-4.3)."""

    op: Literal["near_feature"]
    layer: Identifier
    fid: int
    distance_m: Annotated[float, Field(ge=0, description="Distance in metres.")] = 0


class And(_Model):
    op: Literal["and"]
    args: Annotated[list[Condition], Field(min_length=1)]


class Or(_Model):
    op: Literal["or"]
    args: Annotated[list[Condition], Field(min_length=1)]


class Not(_Model):
    op: Literal["not"]
    arg: Condition


Condition = Annotated[
    Compare
    | Between
    | InList
    | TextMatch
    | IsNull
    | BBox
    | GeometryFilter
    | NearFeature
    | And
    | Or
    | Not,
    Field(discriminator="op"),
]


# --- Operations ---------------------------------------------------------------


class AttributeJoin(_Model):
    """Left join of a layer by key (F-4.6).

    Joined fields are addressable by their name, or by ``prefix + name`` when a
    prefix is given; clashes with source attributes are rejected.
    """

    layer: Identifier
    left_key: Identifier = Field(description="Attribute of the source layer.")
    right_key: Identifier = Field(description="Attribute of the joined layer.")
    fields: Annotated[list[Identifier], Field(min_length=1)]
    prefix: Annotated[str, Field(pattern=r"^[a-z_][a-z0-9_]{0,30}$")] | None = None


class Buffer(_Model):
    """Replace each source geometry by its buffer (F-4.5)."""

    distance_m: Distance


class SpatialRelation(_Model):
    """Keep source features related to at least one feature of ``layer`` (F-4.4).

    The predicate reads ``source <predicate> layer``: ``within`` keeps source
    features lying inside a feature of ``layer``.
    """

    layer: Identifier
    predicate: Literal["intersects", "within", "contains", "dwithin"]
    distance_m: Distance | None = None
    where: Condition | None = Field(
        default=None, description="Filter on the attributes of ``layer``."
    )

    @model_validator(mode="after")
    def _distance(self) -> Self:
        if (self.predicate == "dwithin") != (self.distance_m is not None):
            raise ValueError("'distance_m' is required for 'dwithin' and only allowed there")
        return self


class Metric(_Model):
    fn: Literal["count", "sum", "avg", "min", "max"]
    attr: Identifier | None = Field(
        default=None, description="Source attribute; not used by 'count'."
    )
    as_: Identifier = Field(alias="as", description="Name of the result attribute.")

    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)

    @model_validator(mode="after")
    def _attr(self) -> Self:
        if self.fn == "count" and self.attr is not None:
            raise ValueError("'count' takes no 'attr'")
        if self.fn != "count" and self.attr is None:
            raise ValueError(f"'{self.fn}' requires 'attr'")
        return self


class Aggregate(_Model):
    """Summarise source features per feature of an area layer (F-4.7).

    Every area feature appears in the result, with ``count`` 0 and other
    metrics null where no source feature relates to it.
    """

    by_layer: Identifier
    predicate: Literal["within", "intersects"] = Field(
        default="within", description="Relation 'source <predicate> area'."
    )
    area_fields: list[Identifier] = Field(
        default_factory=list, description="Attributes of ``by_layer`` kept in the result."
    )
    metrics: Annotated[list[Metric], Field(min_length=1)]


class OrderBy(_Model):
    attr: Identifier
    dir: Literal["asc", "desc"] = "asc"


# --- Symbology (render hint, F-4.8) --------------------------------------------


class SingleSymbol(_Model):
    kind: Literal["single"]
    color: HexColor = "#3366cc"


class Categorized(_Model):
    kind: Literal["categorized"]
    attr: Identifier
    colors: dict[str, HexColor] = Field(
        default_factory=dict, description="Optional fixed colour per category value."
    )


class Classified(_Model):
    kind: Literal["classified"]
    attr: Identifier
    method: Literal["quantile", "equal_interval"]
    classes: Annotated[int, Field(ge=2, le=9)] = 5


class GraduatedSize(_Model):
    kind: Literal["graduated_size"]
    attr: Identifier
    min_size: Annotated[float, Field(gt=0)] = 4
    max_size: Annotated[float, Field(gt=0)] = 24


Symbology = Annotated[
    SingleSymbol | Categorized | Classified | GraduatedSize, Field(discriminator="kind")
]


# --- Query object -------------------------------------------------------------


class QueryObject(_Model):
    """Declarative, backend-neutral description of one analysis."""

    model_config = ConfigDict(extra="forbid", title="GeoTandem query object")

    schema_version: Literal["0"] = SCHEMA_VERSION
    source: Identifier
    attribute_join: AttributeJoin | None = None
    where: Condition | None = None
    buffer: Buffer | None = None
    spatial_relation: SpatialRelation | None = None
    aggregate: Aggregate | None = None
    select: list[Identifier] | None = Field(
        default=None, description="Result attributes; all when omitted."
    )
    order_by: list[OrderBy] = Field(default_factory=list)
    limit: Annotated[int, Field(ge=1)] | None = None
    symbology: Symbology | None = None
    output: Literal["map", "table"] = "map"


And.model_rebuild()
Or.model_rebuild()
Not.model_rebuild()
SpatialRelation.model_rebuild()
QueryObject.model_rebuild()
