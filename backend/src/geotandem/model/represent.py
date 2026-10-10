"""Can the controls of Modus A show a query object without loss? (D3, plan WP64)

``to_query`` is ``resultQuery`` of ``frontend/src/analysis/query.ts`` for a
catalog result layer, rewritten in Python; ``to_analysis`` is its inverse. A
query is **representable** exactly when ``to_analysis`` finds an analysis and
``to_query`` of that analysis has the query's canonical form: the controls show
what the model wrote, and applying it sends the same query back. A model may
mean the same with another shape (``and`` of one argument, a ``bbox`` that is
not the last argument); that is refused rather than rewritten, so the query on
the record is the one the user sees.

The analysis is the query part of the frontend's state (``QueryPart`` of
``analysis/model.ts``: result layer, condition tree, restriction) plus the
result layer's symbology. Node ids are left out; the frontend gives its own.
Where several analyses give the same query, ``to_analysis`` picks one:

- the root is an ``and`` group, never negated; an ``and`` at the top gives its
  arguments as the root's children, anything else is the root's only child;
- the restriction ("Nur in") is the last of exactly two ``and`` arguments at
  the top, or the whole ``where``;
- ``not`` of a ``within`` relation is the operator ``outside``, ``not`` of a
  distance relation ``far``; otherwise ``not`` sets the node's flag, and a
  node already negated is wrapped in a negated group of one;
- ``and`` of a ``ge`` and a ``le`` compare on one attribute, both ISO dates in
  order, is one date range row (``between``).

``schema/model-cases/represent.json`` holds the shared cases; the TypeScript
inverse (WP80) must agree with them.
"""

import re
from typing import Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from geotandem_query import (
    And,
    BBox,
    Between,
    Compare,
    Condition,
    GeoJSONGeometry,
    GeometryFilter,
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

_COMPARE: Final = ("eq", "ne", "lt", "le", "gt", "ge")
_TEXT: Final = ("contains", "starts_with", "ends_with")
_TOPOLOGICAL: Final[dict[str, SpatialOperator]] = {
    "within": "in",
    "intersects": "intersects",
    "contains": "contains",
}
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

ALLOWED_FIELDS: Final = frozenset({"schema_version", "source", "where", "symbology", "output"})
"""Top-level fields the controls write; every other one must be unset."""


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


def to_analysis(query: QueryObject) -> QueryPart:
    """The analysis the controls show for ``query``; ``NotRepresentable`` when
    they cannot show it without loss (D3)."""
    for name in QueryObject.model_fields:
        if name not in ALLOWED_FIELDS and getattr(query, name) not in (None, []):
            raise NotRepresentable(name)
    if query.output != "map":
        raise NotRepresentable("output")
    tree, restriction = _split(query.where)
    part = QueryPart(
        result=query.source, tree=tree, restriction=restriction, symbology=query.symbology
    )
    if canonical_json(to_query(part)) != canonical_json(query):
        # A safety net: the inverse above is meant to fail first, naming the part.
        raise NotRepresentable("where")
    return part


def representable(query: QueryObject) -> bool:
    try:
        to_analysis(query)
    except NotRepresentable:
        return False
    return True


def _split(where: Condition | None) -> tuple[Group, ViewRestriction | ShapeRestriction | None]:
    if where is None:
        return Group(), None
    alone = _restriction(where)
    if alone is not None:
        return Group(), alone
    if isinstance(where, And) and len(where.args) == 2:
        last = _restriction(where.args[1])
        if last is not None:
            return _root(where.args[0]), last
    return _root(where), None


def _restriction(condition: Condition) -> ViewRestriction | ShapeRestriction | None:
    if isinstance(condition, BBox):
        return ViewRestriction(bbox=condition.bbox)
    if isinstance(condition, GeometryFilter) and condition.predicate == "intersects":
        return ShapeRestriction(geometry=condition.geometry)
    return None


def _root(condition: Condition) -> Group:
    if isinstance(condition, And) and len(condition.args) >= 2 and _dates(condition) is None:
        return Group(children=[_node(arg) for arg in condition.args])
    return Group(children=[_node(condition)])


def _dates(condition: And) -> AttributeRow | None:
    """``ge`` and ``le`` on one attribute, ISO dates in order: a date range row."""
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
    if low.value > high.value:
        return None
    return AttributeRow(attr=low.attr, operator="between", min=low.value, max=high.value)


def _node(condition: Condition) -> Group | Row:
    match condition:
        case And() | Or():
            if len(condition.args) < 2:
                raise NotRepresentable(condition.op)
            if isinstance(condition, And) and (dates := _dates(condition)) is not None:
                return dates
            return Group(op=condition.op, children=[_node(arg) for arg in condition.args])
        case Not():
            return _negated(_node(condition.arg))
        case Compare():
            if condition.value == "":
                raise NotRepresentable(condition.op)
            return AttributeRow(attr=condition.attr, operator=condition.cmp, value=condition.value)
        case Between():
            return AttributeRow(
                attr=condition.attr, operator="between", min=condition.min, max=condition.max
            )
        case InList():
            return AttributeRow(attr=condition.attr, operator="in", values=list(condition.values))
        case TextMatch():
            if condition.mode not in _TEXT or condition.case_sensitive:
                raise NotRepresentable(condition.op)
            return AttributeRow(attr=condition.attr, operator=condition.mode, value=condition.text)
        case IsNull():
            return AttributeRow(attr=condition.attr, operator="is_empty")
        case NearFeature():
            return ReferenceRow(
                layer=condition.layer, fid=condition.fid, distance_m=condition.distance_m
            )
        case RelatedTopological():
            return SpatialRow(
                operator=_TOPOLOGICAL[condition.predicate],
                layer=condition.layer,
                filter=_filter(condition.where),
            )
        case RelatedByDistance():
            return SpatialRow(
                operator="near",
                layer=condition.layer,
                distance_m=condition.distance_m,
                filter=_filter(condition.where),
            )
    # bbox and geometry: only as the restriction, never inside the tree.
    raise NotRepresentable(condition.op)


def _negated(node: Group | Row) -> Group | Row:
    if node.negated:
        return Group(negated=True, children=[node])
    if isinstance(node, SpatialRow) and node.operator in ("in", "near"):
        return node.model_copy(update={"operator": "outside" if node.operator == "in" else "far"})
    return node.model_copy(update={"negated": True})


def _filter(where: Condition | None) -> AttributeRow | None:
    """A relation's filter is one attribute row ("+ Filter")."""
    if where is None:
        return None
    node = _node(where)
    if not isinstance(node, AttributeRow):
        raise NotRepresentable("related")
    return node
