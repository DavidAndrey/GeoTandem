"""Can the controls of Modus A show a query object without loss? (D3, plan WP64)

``to_query`` is ``resultQuery`` of ``frontend/src/analysis/query.ts`` for a
catalog result layer, rewritten in Python; ``to_analysis`` is its inverse. A
query is **representable** exactly when ``to_analysis`` finds an analysis and
``to_query`` of that analysis has the query's canonical form: the controls show
what the model wrote, and applying it sends the same query back. A model may
mean the same with another shape (``and`` of one argument); that is refused
rather than rewritten, so the query on the record is the one the user sees.

The analysis is the query part of the frontend's state (``QueryPart`` of
``analysis/model.ts``: result layer, condition tree, restriction) plus the
result layer's symbology. Node ids are left out; the frontend gives its own.
``to_analysis`` serves the model path, so it finds only what the editor's
draft of a proposal can take (``model/panel/draft.ts``): a condition tree,
never a restriction ("Nur in" is the map's, not the model's; ``result.py``
leaves ``bbox`` and ``geometry`` out of the answer format), never a
symbology (a layer's display, not part of the draft), and never ``not`` of a
``not`` (the editor writes it only as a negated group around one negated row,
which the draft does not rebuild). Where
several analyses give the same query, ``to_analysis`` picks one:

- the root is an ``and`` group, never negated; an ``and`` at the top gives its
  arguments as the root's children, anything else is the root's only child;
- ``not`` of a ``within`` relation is the operator ``outside``, ``not`` of a
  distance relation ``far``; otherwise ``not`` sets the node's flag;
- ``and`` of a ``ge`` and a ``le`` compare on one date attribute, both ISO
  dates in order, is one date range row (``between``).

The controls know the layers, so ``to_analysis`` takes them (``Catalog``: kind
and field types per layer; ``validate`` passes the model's world): the result
is a vector layer; a row names a field of its layer with an operator the
editor offers for the field's type (``operators_for``, a port of
``operatorsFor`` in ``editor/describe.ts``), a number range on a number field
and a date range on a date field; a relation or reference names another
vector layer, never the result layer itself; a relation's filter is one
attribute row of the related layer, without a NICHT toggle.

``schema/model-cases/represent.json`` holds the shared cases; the TypeScript
inverse (WP80) must agree with them.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from geotandem.catalog import ModelProfile
from geotandem_query import (
    And,
    Between,
    Compare,
    Condition,
    GeoJSONGeometry,
    InList,
    IsNull,
    NearFeature,
    Not,
    Or,
    QueryObject,
    RelatedByDistance,
    RelatedTopological,
    TextMatch,
    canonical_json,
)
from geotandem_query.models import Symbology

Scalar = str | int | float | bool

AttributeOperator = Literal[
    "eq",
    "ne",
    "lt",
    "le",
    "gt",
    "ge",
    "between",
    "contains",
    "starts_with",
    "ends_with",
    "is_empty",
    "in",
]
SpatialOperator = Literal["in", "outside", "intersects", "contains", "near", "far"]
FieldType = Literal["integer", "real", "text", "boolean", "date"]

_COMPARE: Final = ("eq", "ne", "lt", "le", "gt", "ge")
_TEXT: Final = ("contains", "starts_with", "ends_with")
_TOPOLOGICAL: Final[dict[str, SpatialOperator]] = {
    "within": "in",
    "intersects": "intersects",
    "contains": "contains",
}
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

ALLOWED_FIELDS: Final = ("schema_version", "source", "where", "output")
"""Top-level fields a proposal may set (the controls also write ``symbology``,
which the draft does not take); every other one must be unset."""


def operators_for(field_type: str | None) -> tuple[AttributeOperator, ...]:
    """The operators the editor offers for a field type (``operatorsFor``, design B2)."""
    match field_type:
        case "date":
            return ("eq", "ne", "lt", "le", "gt", "ge", "between", "is_empty")
        case "integer" | "real":
            return ("eq", "ne", "lt", "le", "gt", "ge", "between", "in", "is_empty")
        case "boolean":
            return ("eq", "is_empty")
    return ("eq", "ne", "contains", "starts_with", "ends_with", "in", "is_empty")


class LayerShape(BaseModel):
    """What the controls know of a layer: its kind and its fields' types."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["vector", "table"]
    attributes: dict[str, FieldType]


Catalog = Mapping[str, LayerShape]


def catalog_of(profile: ModelProfile) -> dict[str, LayerShape]:
    """The layers of a layer profile as the controls know them."""
    return {
        layer.name: LayerShape.model_validate(
            {"kind": layer.kind, "attributes": {a.name: a.type for a in layer.attributes}}
        )
        for layer in profile.layers
    }


class _Node(BaseModel):
    model_config = ConfigDict(
        extra="forbid", populate_by_name=True, serialize_by_alias=True, frozen=True
    )

    negated: bool = Field(default=False, alias="not")


class AttributeRow(_Node):
    kind: Literal["attribute"] = "attribute"
    attr: str
    operator: AttributeOperator
    value: Scalar | None = None
    min: float | str | None = None
    max: float | str | None = None
    values: list[Scalar] = []


class SpatialRow(_Node):
    kind: Literal["spatial"] = "spatial"
    operator: SpatialOperator
    layer: str
    distance_m: float | None = None
    filter: AttributeRow | None = None


class ReferenceRow(_Node):
    kind: Literal["reference"] = "reference"
    layer: str
    fid: int | None
    label: str = ""
    distance_m: float = 0


class Group(_Node):
    kind: Literal["group"] = "group"
    op: Literal["and", "or"] = "and"
    children: list["Node"] = []


Row = AttributeRow | SpatialRow | ReferenceRow
Node = Annotated[Group | AttributeRow | SpatialRow | ReferenceRow, Field(discriminator="kind")]
Group.model_rebuild()


class ViewRestriction(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["view"] = "view"
    bbox: tuple[float, float, float, float]


class ShapeRestriction(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["shape"] = "shape"
    geometry: GeoJSONGeometry


Restriction = Annotated[ViewRestriction | ShapeRestriction, Field(discriminator="kind")]


class QueryPart(BaseModel):
    """What the controls hold of one query (``QueryPart`` of the frontend, plus
    the result layer's symbology)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    result: str
    """Catalog layer name of the result layer."""
    tree: Group = Group()
    restriction: Restriction | None = None
    symbology: Symbology | None = None


class NotRepresentable(Exception):
    """``part`` names the first field or condition ``op`` the controls cannot show."""

    def __init__(self, part: str) -> None:
        super().__init__(f"The controls cannot show '{part}' of this query.")
        self.part = part


def count_conditions(part: QueryPart) -> int:
    """Conditions as the controls count them (design M3.2, ``MAX_CONDITIONS``):
    one per row of the tree (an attribute row, a date range row, a relation with
    its filter, a reference row) and one for a restriction; groups, ``and``,
    ``or`` and ``not`` count nothing."""

    def rows(node: Group | Row) -> int:
        return sum(map(rows, node.children)) if isinstance(node, Group) else 1

    return rows(part.tree) + (part.restriction is not None)


# --- analysis → query (resultQuery of query.ts) ----------------------------------

Json = dict[str, Any]


def _negate(condition: Json | None, negated: bool) -> Json | None:
    return {"op": "not", "arg": condition} if condition is not None and negated else condition


def _and(*conditions: Json | None) -> Json | None:
    present = [c for c in conditions if c is not None]
    if not present:
        return None
    return present[0] if len(present) == 1 else {"op": "and", "args": present}


def _number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def attribute_condition(row: AttributeRow) -> Json | None:
    """``None`` while the row is incomplete, as in the frontend."""
    attr, operator = row.attr, row.operator
    if not attr:
        return None
    condition: Json | None = None
    if operator in _COMPARE:
        if row.value is not None and row.value != "":
            condition = {"op": "compare", "attr": attr, "cmp": operator, "value": row.value}
    elif operator == "between":
        if isinstance(row.min, str) and isinstance(row.max, str):
            low, high = sorted((row.min, row.max))
            if low and high:
                condition = _and(
                    {"op": "compare", "attr": attr, "cmp": "ge", "value": low},
                    {"op": "compare", "attr": attr, "cmp": "le", "value": high},
                )
        elif _number(row.min) and _number(row.max):
            condition = {"op": "between", "attr": attr, "min": row.min, "max": row.max}
    elif operator in _TEXT:
        if isinstance(row.value, str) and row.value:
            condition = {
                "op": "text_match",
                "attr": attr,
                "text": row.value,
                "mode": operator,
                "case_sensitive": False,
            }
    elif operator == "is_empty":
        condition = {"op": "is_null", "attr": attr}
    elif operator == "in" and row.values:
        condition = {"op": "in", "attr": attr, "values": list(row.values)}
    return _negate(condition, row.negated)


def _spatial_condition(row: SpatialRow) -> Json | None:
    if not row.layer:
        return None
    where = attribute_condition(row.filter) if row.filter else None
    extra = {"where": where} if where else {}
    distance = row.distance_m
    if row.operator in ("near", "far") and (distance is None or distance <= 0):
        return None

    def related(predicate: str) -> Json:
        return {"op": "related", "layer": row.layer, "predicate": predicate, **extra}

    near = {**related("dwithin"), "distance_m": distance or 0}
    condition = {
        "in": related("within"),
        "outside": {"op": "not", "arg": related("within")},
        "intersects": related("intersects"),
        "contains": related("contains"),
        "near": near,
        "far": {"op": "not", "arg": near},
    }[row.operator]
    return _negate(condition, row.negated)


def row_condition(row: Row) -> Json | None:
    if isinstance(row, AttributeRow):
        return attribute_condition(row)
    if isinstance(row, ReferenceRow):
        if not row.layer or row.fid is None:
            return None
        return _negate(
            {
                "op": "near_feature",
                "layer": row.layer,
                "fid": row.fid,
                "distance_m": row.distance_m,
            },
            row.negated,
        )
    return _spatial_condition(row)


def node_condition(node: Group | Row) -> Json | None:
    if not isinstance(node, Group):
        return row_condition(node)
    parts = [c for c in map(node_condition, node.children) if c is not None]
    if not parts:
        return None
    combined = parts[0] if len(parts) == 1 else {"op": node.op, "args": parts}
    return _negate(combined, node.negated)


def restriction_condition(restriction: ViewRestriction | ShapeRestriction | None) -> Json | None:
    if restriction is None:
        return None
    if isinstance(restriction, ViewRestriction):
        return {"op": "bbox", "bbox": list(restriction.bbox)}
    return {
        "op": "geometry",
        "geometry": restriction.geometry.model_dump(),
        "predicate": "intersects",
    }


def to_query(part: QueryPart) -> QueryObject:
    """The query object the controls send for ``part`` (``resultQuery``)."""
    query: Json = {"schema_version": "2", "source": part.result, "output": "map"}
    if part.symbology is not None:
        query["symbology"] = part.symbology.model_dump(by_alias=True)
    where = _and(node_condition(part.tree), restriction_condition(part.restriction))
    if where is not None:
        query["where"] = where
    return QueryObject.model_validate(query)


# --- query → analysis ----------------------------------------------------------------


def to_analysis(query: QueryObject, catalog: Catalog) -> QueryPart:
    """The analysis the controls show for ``query`` over the layers of
    ``catalog``; ``NotRepresentable`` when they cannot show it without loss (D3)."""
    for name in QueryObject.model_fields:
        if name not in ALLOWED_FIELDS and getattr(query, name) not in (None, []):
            raise NotRepresentable(name)
    if query.output != "map":
        raise NotRepresentable("output")
    source = catalog.get(query.source)
    if source is None or source.kind != "vector":
        raise NotRepresentable("source")  # a table layer is never the result (B11)
    inverse = _Inverse(catalog, query.source)
    tree = Group() if query.where is None else inverse.root(query.where)
    part = QueryPart(result=query.source, tree=tree)
    if canonical_json(to_query(part)) != canonical_json(query):
        # A safety net: the inverse above is meant to fail first, naming the part.
        raise NotRepresentable("where")
    return part


@dataclass(frozen=True)
class _Inverse:
    catalog: Catalog
    source: str

    def root(self, condition: Condition) -> Group:
        if (
            isinstance(condition, And)
            and len(condition.args) >= 2
            and self.dates(condition, self.source) is None
        ):
            return Group(children=[self.node(arg, self.source) for arg in condition.args])
        return Group(children=[self.node(condition, self.source)])

    def field_type(self, layer: str, attr: str, op: str) -> str:
        shape = self.catalog.get(layer)
        found = shape.attributes.get(attr) if shape else None
        if found is None:
            raise NotRepresentable(op)  # not a field the editor lists
        return found

    def dates(self, condition: And, layer: str) -> AttributeRow | None:
        """``ge`` and ``le`` on one date field, ISO dates in order: a date range row."""
        if len(condition.args) != 2:
            return None
        low, high = condition.args
        if not (isinstance(low, Compare) and isinstance(high, Compare)):
            return None
        if (low.cmp, high.cmp) != ("ge", "le") or low.attr != high.attr:
            return None
        if not (isinstance(low.value, str) and isinstance(high.value, str)):
            return None
        if not (_ISO_DATE.match(low.value) and _ISO_DATE.match(high.value)):
            return None
        if low.value > high.value or self.field_type(layer, low.attr, "compare") != "date":
            return None
        return AttributeRow(attr=low.attr, operator="between", min=low.value, max=high.value)

    def attribute(self, op: str, layer: str, row: AttributeRow) -> AttributeRow:
        """``row``, if the editor offers its operator for the field's type."""
        field_type = self.field_type(layer, row.attr, op)
        if row.operator not in operators_for(field_type):
            raise NotRepresentable(op)
        if row.operator == "between" and field_type not in ("integer", "real"):
            raise NotRepresentable(op)  # a date range comes as ge and le
        return row

    def other_layer(self, layer: str, op: str) -> str:
        """Relations and references name another vector layer (``LayerSelect``)."""
        shape = self.catalog.get(layer)
        if shape is None or shape.kind != "vector" or layer == self.source:
            raise NotRepresentable(op)
        return layer

    def node(self, condition: Condition, layer: str) -> Group | Row:
        match condition:
            case And() | Or():
                if len(condition.args) < 2:
                    raise NotRepresentable(condition.op)
                if isinstance(condition, And) and (dates := self.dates(condition, layer)):
                    return dates
                children = [self.node(arg, layer) for arg in condition.args]
                return Group(op=condition.op, children=children)
            case Not():
                if isinstance(condition.arg, Not):
                    raise NotRepresentable(condition.op)
                return _negated(self.node(condition.arg, layer))
            case Compare():
                if condition.value == "":
                    raise NotRepresentable(condition.op)
                row = AttributeRow(
                    attr=condition.attr, operator=condition.cmp, value=condition.value
                )
                return self.attribute(condition.op, layer, row)
            case Between():
                row = AttributeRow(
                    attr=condition.attr, operator="between", min=condition.min, max=condition.max
                )
                return self.attribute(condition.op, layer, row)
            case InList():
                row = AttributeRow(
                    attr=condition.attr, operator="in", values=list(condition.values)
                )
                return self.attribute(condition.op, layer, row)
            case TextMatch():
                if condition.mode not in _TEXT or condition.case_sensitive:
                    raise NotRepresentable(condition.op)
                row = AttributeRow(
                    attr=condition.attr, operator=condition.mode, value=condition.text
                )
                return self.attribute(condition.op, layer, row)
            case IsNull():
                row = AttributeRow(attr=condition.attr, operator="is_empty")
                return self.attribute(condition.op, layer, row)
            case NearFeature():
                return ReferenceRow(
                    layer=self.other_layer(condition.layer, condition.op),
                    fid=condition.fid,
                    distance_m=condition.distance_m,
                )
            case RelatedTopological():
                return SpatialRow(
                    operator=_TOPOLOGICAL[condition.predicate],
                    layer=self.other_layer(condition.layer, condition.op),
                    filter=self.filter(condition.where, condition.layer),
                )
            case RelatedByDistance():
                return SpatialRow(
                    operator="near",
                    layer=self.other_layer(condition.layer, condition.op),
                    distance_m=condition.distance_m,
                    filter=self.filter(condition.where, condition.layer),
                )
        # bbox and geometry: the map's restriction, never the model's.
        raise NotRepresentable(condition.op)

    def filter(self, where: Condition | None, layer: str) -> AttributeRow | None:
        """A relation's filter: one attribute row of the related layer ("+ Filter"),
        which has no NICHT toggle."""
        if where is None:
            return None
        node = self.node(where, layer)
        if not isinstance(node, AttributeRow) or node.negated:
            raise NotRepresentable("related")
        return node


def _negated(node: Group | Row) -> Group | Row:
    # Never negated already: ``not`` of a ``not`` is refused above.
    if isinstance(node, SpatialRow) and node.operator in ("in", "near"):
        return node.model_copy(update={"operator": "outside" if node.operator == "in" else "far"})
    return node.model_copy(update={"negated": True})
