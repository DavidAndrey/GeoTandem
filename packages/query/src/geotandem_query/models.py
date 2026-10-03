"""Query-object schema — the single contract between UI, model and engine.

Evaluation order is fixed and independent of field order in the document:

1. ``source``          — the layer the result features come from
2. ``attribute_join``  — left join of a table layer by key; its fields become
                         addressable like source attributes
3. ``where``           — filter on source (and joined) attributes and geometry,
                         and on relations to other layers (``related``, v1)
4. ``buffer``          — replace each source geometry by its buffer
5. ``spatial_relation``— keep only features related to some feature of
                         another layer (semi-join, no duplicates); unlike
                         ``related`` it sees the buffered geometry
6. ``aggregate``       — summarise the remaining features per feature of an
                         area layer; the result features become those areas
7. ``columns``         — computed attributes of each result feature, from its
                         result geometry (after ``buffer``; the area after
                         ``aggregate``) and another layer (v2)
8. ``select`` / ``order_by`` / ``limit`` — computed columns included

``symbology`` and ``output`` are render hints: validated, never executed.
Geometries in queries are GeoJSON in WGS84 (EPSG:4326); distances are metres.

Version history: v0 (E1.2); v1 (E1.5) adds the condition ``related``; v2
(E1.6) adds computed ``columns``. Each is a superset of the one before: an
older document is read as v2 with the same meaning and result.

The JSON schema is the whole intrinsic contract: no rule couples fields
behind its back. Where one field depends on another, the model is split into
variants told apart by a constant (``predicate``, ``fn``); where an order
matters (``between``, ``bbox``), it is normalised, not enforced. What the
schema cannot know — whether a layer or attribute exists, its type, who may
see it — is checked against the data core (``/api/query/validate``).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Discriminator, Field, Tag, model_validator

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
    """Inclusive value range (F-4.2). The bounds may come in either order."""

    op: Literal["between"]
    attr: Identifier
    min: int | float
    max: int | float

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        # Normalise, never reject: "between 10 and 5" means 5 to 10. The schema
        # then is the whole contract, and both orders hash alike (canonical form).
        if self.min > self.max:
            self.min, self.max = self.max, self.min
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
        description="Two opposite corners [lon, lat, lon, lat] in WGS84; stored as "
        "[min_lon, min_lat, max_lon, max_lat]."
    )

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        # Normalise, never reject (see Between).
        x1, y1, x2, y2 = self.bbox
        self.bbox = (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))
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


class TopologicalRelation(_Model):
    """Relation without distance: ``source <predicate> layer``."""

    layer: Identifier
    predicate: Literal["intersects", "within", "contains"]
    where: Condition | None = Field(
        default=None, description="Filter on the attributes of ``layer``."
    )


class DistanceRelation(_Model):
    """Source within ``distance_m`` of a feature of ``layer``."""

    layer: Identifier
    predicate: Literal["dwithin"]
    distance_m: Distance
    where: Condition | None = Field(
        default=None, description="Filter on the attributes of ``layer``."
    )


class RelatedTopological(TopologicalRelation):
    op: Literal["related"]


class RelatedByDistance(DistanceRelation):
    op: Literal["related"]


Related = RelatedTopological | RelatedByDistance
"""Source feature relates to at least one feature of ``layer`` (F-4.4), as a condition.

Since v1. Unlike the top-level ``spatial_relation`` it combines with ``and``,
``or`` and ``not``: "outside" is ``not`` + ``within``, "farther than" is
``not`` + ``dwithin``. It sees the source geometry before any ``buffer``.
Two variants: only ``dwithin`` carries a distance.
"""


class And(_Model):
    op: Literal["and"]
    args: Annotated[list[Condition], Field(min_length=1)]


class Or(_Model):
    op: Literal["or"]
    args: Annotated[list[Condition], Field(min_length=1)]


class Not(_Model):
    op: Literal["not"]
    arg: Condition


def _condition_tag(value: Any) -> str | None:
    """``op``, and for ``related`` also ``predicate``: picks exactly one variant.

    A callable discriminator because pydantic cannot nest the ``predicate``
    union inside this recursive ``op`` union.
    """

    def get(key: str) -> Any:
        return value.get(key) if isinstance(value, dict) else getattr(value, key, None)

    op = get("op")
    if op == "related":
        return "related_dwithin" if get("predicate") == "dwithin" else "related"
    return op if isinstance(op, str) else None


Condition = Annotated[
    Annotated[Compare, Tag("compare")]
    | Annotated[Between, Tag("between")]
    | Annotated[InList, Tag("in")]
    | Annotated[TextMatch, Tag("text_match")]
    | Annotated[IsNull, Tag("is_null")]
    | Annotated[BBox, Tag("bbox")]
    | Annotated[GeometryFilter, Tag("geometry")]
    | Annotated[NearFeature, Tag("near_feature")]
    | Annotated[RelatedTopological, Tag("related")]
    | Annotated[RelatedByDistance, Tag("related_dwithin")]
    | Annotated[And, Tag("and")]
    | Annotated[Or, Tag("or")]
    | Annotated[Not, Tag("not")],
    Discriminator(_condition_tag),
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


SpatialRelation = Annotated[
    TopologicalRelation | DistanceRelation, Field(discriminator="predicate")
]
"""Keep source features related to at least one feature of ``layer`` (F-4.4).

The predicate reads ``source <predicate> layer``: ``within`` keeps source
features lying inside a feature of ``layer``. Applied after ``buffer``; for
relations combined with other conditions use ``related`` in ``where``.
"""


class _Metric(_Model):
    as_: Identifier = Field(alias="as", description="Name of the result attribute.")

    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)


class CountMetric(_Metric):
    """Number of source features per area."""

    fn: Literal["count"]


class ValueMetric(_Metric):
    """Sum, mean, minimum or maximum of a numeric source attribute per area."""

    fn: Literal["sum", "avg", "min", "max"]
    attr: Identifier = Field(description="Source attribute.")


Metric = Annotated[CountMetric | ValueMetric, Field(discriminator="fn")]


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


# --- Computed columns (v2, F-8.2) ------------------------------------------------


class DistanceColumn(_Model):
    """Distance in metres to the nearest feature of ``layer``; null if none qualifies."""

    fn: Literal["distance_to"]
    name: Identifier = Field(description="Name of the result attribute.")
    layer: Identifier
    where: Condition | None = Field(
        default=None, description="Filter on the attributes of ``layer``."
    )


class ValueColumn(_Model):
    """Attribute ``attr`` of the feature of ``layer`` the result feature relates to.

    Reads ``result <predicate> layer``. When several features qualify, the one
    with the lowest ``fid`` gives the value; null when none does.
    """

    fn: Literal["value_of"]
    name: Identifier = Field(description="Name of the result attribute.")
    layer: Identifier
    attr: Identifier = Field(description="Attribute of ``layer``.")
    predicate: Literal["within", "intersects"] = "within"
    where: Condition | None = Field(
        default=None, description="Filter on the attributes of ``layer``."
    )


Column = Annotated[DistanceColumn | ValueColumn, Field(discriminator="fn")]
"""A computed attribute of each result feature (since v2): why it is a hit.

Its name must not clash with another result attribute (checked against the
data, like joined fields). It can be selected and ordered by.
"""


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

    schema_version: Literal["2"] = SCHEMA_VERSION
    source: Identifier
    attribute_join: AttributeJoin | None = None
    where: Condition | None = None
    buffer: Buffer | None = None
    spatial_relation: SpatialRelation | None = None
    aggregate: Aggregate | None = None
    columns: list[Column] = Field(default_factory=list)
    select: list[Identifier] | None = Field(
        default=None, description="Result attributes; all when omitted."
    )
    order_by: list[OrderBy] = Field(default_factory=list)
    limit: Annotated[int, Field(ge=1)] | None = None
    symbology: Symbology | None = None
    output: Literal["map", "table"] = "map"

    @model_validator(mode="before")
    @classmethod
    def _upgrade(cls, data: Any) -> Any:
        """Read a v0 or v1 document as v2: each version only adds, so the version is all."""
        if isinstance(data, dict) and data.get("schema_version") in ("0", "1"):
            return {**data, "schema_version": SCHEMA_VERSION}
        return data


And.model_rebuild()
Or.model_rebuild()
Not.model_rebuild()
TopologicalRelation.model_rebuild()
DistanceRelation.model_rebuild()
RelatedTopological.model_rebuild()
RelatedByDistance.model_rebuild()
DistanceColumn.model_rebuild()
ValueColumn.model_rebuild()
QueryObject.model_rebuild()
