"""Tool-chain steps (E2.5, plan WP74): tools of the form
``(QueryObject, arguments) → QueryObject``.

Each wraps an operation the user reaches by hand in Modus A (F-5.8): a
filter is the condition editor, a buffer the derived layer of design B4, and
the spatial steps are the spatial rows "liegt in", "ausserhalb", "enthält",
"schneidet" and "≤ Distanz". A step **builds or extends a query object**: nothing runs,
nothing is stored, no layer is made. So every chain stays expressible as one
query object (F-5.7): the result of the last step is the query the user
adopts, and every intermediate result is a query object too, which the
application counts (``engine.count_query``), never a table.

The inputs are generic in the type that stands for an earlier result: here,
in the registry, a ``QueryObject``; in a planned step the model writes the
position of an earlier step instead (``geotandem.model.chain.plan``), which
the application resolves to that step's query object before the tool runs.

How a relation to an earlier step becomes one condition (schema v1
``related``): the step related to must be **plain**, one layer with attribute
conditions only, so its conditions become the relation's filter on that
layer. When it is a buffer, lying in it means lying within its distance
(``dwithin``): exact for points and for ``intersects``; ``model.chain.plan``
refuses ``within`` and ``outside`` of a buffer for anything but points
(multipoints, lines, areas), where the two differ. A filter on a buffer takes
attribute conditions only: a relation in it would see the geometry before
buffering. Anything else cannot be one query object and raises
``NotComposable``, naming the argument.
"""

from typing import Annotated, Any, Final, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from geotandem.levels import OpClass, classify
from geotandem.tools.registry import Tool, ToolContext
from geotandem_query import (
    And,
    Buffer,
    Condition,
    Not,
    QueryObject,
    RelatedByDistance,
    RelatedTopological,
)

Layer = Annotated[
    str,
    Field(pattern=r"^[a-z_][a-z0-9_]{0,62}$", description="Name of a layer of the profile."),
]
Distance = Annotated[float, Field(gt=0, description="Distance in metres.")]


class NotComposable(Exception):
    """The step cannot extend the query object; ``part`` names the argument."""

    def __init__(self, part: str, reason: str) -> None:
        super().__init__(f"'{part}': {reason}")
        self.part = part
        self.reason = reason


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)


class _OnLayerOrStep[T](_Input):
    """A step on a layer of the profile, or on the result of an earlier step."""

    layer: Layer | None = None
    of: T | None = None

    @model_validator(mode="after")
    def _one_base(self) -> Self:
        if (self.layer is None) == (self.of is None):
            raise ValueError("give either 'layer' or 'of'")
        return self


class FilterInput[T](_OnLayerOrStep[T]):
    where: Condition = Field(description="Condition, as in a query object's 'where'.")


class BufferInput[T](_OnLayerOrStep[T]):
    distance_m: Distance
    where: Condition | None = Field(
        default=None, description="Only the features that meet it are buffered."
    )


class WithinInput[T](_Input):
    of: T
    in_: T = Field(alias="in")


class OutsideInput[T](_Input):
    of: T
    in_: T = Field(alias="in")


class ContainsInput[T](_Input):
    of: T
    has: T


class IntersectsInput[T](_Input):
    of: T
    with_: T = Field(alias="with")


class NearInput[T](_Input):
    of: T
    to: T
    distance_m: Distance


# --- composing -------------------------------------------------------------------


def _flat(condition: Condition | None) -> list[Condition]:
    if isinstance(condition, And):
        return [part for arg in condition.args for part in _flat(arg)]
    return [] if condition is None else [condition]


def conjoin(first: Condition | None, then: Condition | None) -> Condition | None:
    """Both, as one flat ``and`` (the shape the condition editor writes); never
    an ``and`` of one argument."""
    parts = _flat(first) + _flat(then)
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else And(op="and", args=parts)


def _relates(where: Condition | None) -> bool:
    """``where`` relates to another layer somewhere (``classify``: a spatial part)."""
    return where is not None and OpClass.SPATIAL in classify(QueryObject(source="x", where=where))


_EXTRAS: Final = (
    "attribute_join",
    "spatial_relation",
    "aggregate",
    "columns",
    "select",
    "order_by",
    "limit",
    "symbology",
)
"""Fields no step writes: a step result is a layer, its conditions and a buffer."""


def _bare(query: QueryObject, part: str) -> QueryObject:
    """``query`` builds on a layer and its conditions only, as every step does."""
    for name in _EXTRAS:
        if getattr(query, name) not in (None, []):
            raise NotComposable(part, f"a step result has no '{name}'")
    if query.output != "map":
        raise NotComposable(part, "a step result is shown on the map")
    return query


def _result(query: QueryObject, part: str) -> QueryObject:
    """A step whose features are kept or dropped: not a buffer, whose relations
    would see the geometry before buffering."""
    if _bare(query, part).buffer is not None:
        raise NotComposable(part, "a buffer is related to, not filtered by a relation")
    return query


def _plain(query: QueryObject, part: str) -> QueryObject:
    """A step related to: one layer, attribute conditions only."""
    if _relates(_bare(query, part).where):
        raise NotComposable(part, "a step related to has attribute conditions only")
    return query


def _relation(target: QueryObject, predicate: str) -> Condition:
    """``source <predicate> target``; a buffered target counts by its distance."""
    if target.buffer is not None:
        return RelatedByDistance(
            op="related",
            layer=target.source,
            predicate="dwithin",
            distance_m=target.buffer.distance_m,
            where=target.where,
        )
    return RelatedTopological.model_validate(
        {"op": "related", "layer": target.source, "predicate": predicate, "where": target.where}
    )


def _narrowed(query: QueryObject, condition: Condition | None) -> QueryObject:
    return query.model_copy(update={"where": conjoin(query.where, condition)})


def _base(args: _OnLayerOrStep[QueryObject]) -> QueryObject:
    if args.of is not None:
        return _bare(args.of, "of")
    assert args.layer is not None  # one of the two (``_one_base``)
    return QueryObject(source=args.layer)


def _filter(_: ToolContext, args: FilterInput[QueryObject]) -> QueryObject:
    base = _base(args)
    if base.buffer is not None and _relates(args.where):
        # Its relations would see the geometry before buffering (``_result``).
        raise NotComposable("where", "a buffer is related to, not filtered by a relation")
    return _narrowed(base, args.where)


def _buffer(_: ToolContext, args: BufferInput[QueryObject]) -> QueryObject:
    base = _base(args)
    if base.buffer is not None:
        raise NotComposable("of", "a buffer is not buffered again")
    buffered = _narrowed(base, args.where)
    return buffered.model_copy(update={"buffer": Buffer(distance_m=args.distance_m)})


def _within(_: ToolContext, args: WithinInput[QueryObject]) -> QueryObject:
    target = _plain(args.in_, "in")
    return _narrowed(_result(args.of, "of"), _relation(target, "within"))


def _outside(_: ToolContext, args: OutsideInput[QueryObject]) -> QueryObject:
    target = _plain(args.in_, "in")
    return _narrowed(_result(args.of, "of"), Not(op="not", arg=_relation(target, "within")))


def _contains(_: ToolContext, args: ContainsInput[QueryObject]) -> QueryObject:
    target = _plain(args.has, "has")
    if target.buffer is not None:
        raise NotComposable("has", "an area contains features, not a buffer")
    return _narrowed(_result(args.of, "of"), _relation(target, "contains"))


def _intersects(_: ToolContext, args: IntersectsInput[QueryObject]) -> QueryObject:
    target = _plain(args.with_, "with")
    return _narrowed(_result(args.of, "of"), _relation(target, "intersects"))


def _near(_: ToolContext, args: NearInput[QueryObject]) -> QueryObject:
    target = _plain(args.to, "to")
    if target.buffer is not None:
        raise NotComposable("to", "near takes its own distance, not a buffer")
    relation = RelatedByDistance(
        op="related",
        layer=target.source,
        predicate="dwithin",
        distance_m=args.distance_m,
        where=target.where,
    )
    return _narrowed(_result(args.of, "of"), relation)


def chain_tools() -> list[Tool[Any, QueryObject]]:
    """The chain's tools, in the order the prompt lists them. Each one's class
    is its own operation's (H2); a step adds the classes of the conditions it
    writes (``model.chain.plan.step_classes``)."""

    def tool(
        name: str, op_class: OpClass, input_model: type[BaseModel], handler: Any, description: str
    ) -> Tool[Any, QueryObject]:
        return Tool(
            name=name,
            description=description,
            input_model=input_model,
            output_model=QueryObject,
            effect="state",
            op_class=op_class,
            handler=handler,
        )

    return [
        tool(
            "filter",
            OpClass.QUERY,
            FilterInput[QueryObject],
            _filter,
            "Keep the features of a layer, or of an earlier step's result, that meet 'where'.",
        ),
        tool(
            "buffer",
            OpClass.DERIVE,
            BufferInput[QueryObject],
            _buffer,
            "Buffer the features of a layer (those meeting 'where', if given), or of an earlier "
            "step's result, by 'distance_m'. Another step relates to it with within, outside "
            "or intersects; a chain does not end in a buffer.",
        ),
        tool(
            "within",
            OpClass.SPATIAL,
            WithinInput[QueryObject],
            _within,
            "Keep the features of 'of' that lie in a feature of 'in'. 'in' holds areas or a "
            "buffer: nothing lies in a point or a line. In a buffer: within its distance; for "
            "point (not multipoint) features only.",
        ),
        tool(
            "outside",
            OpClass.SPATIAL,
            OutsideInput[QueryObject],
            _outside,
            "Keep the features of 'of' that lie in no feature of 'in'. 'in' holds areas or a "
            "buffer. Of a buffer: farther than its distance; for point (not multipoint) "
            "features only.",
        ),
        tool(
            "contains",
            OpClass.SPATIAL,
            ContainsInput[QueryObject],
            _contains,
            "Keep the areas of 'of' that contain a feature of 'has' (the areas with such a "
            "feature in them). 'of' holds areas; 'has' is no buffer.",
        ),
        tool(
            "intersects",
            OpClass.SPATIAL,
            IntersectsInput[QueryObject],
            _intersects,
            "Keep the features of 'of' that intersect a feature of 'with' (a buffer: come "
            "within its distance).",
        ),
        tool(
            "near",
            OpClass.SPATIAL,
            NearInput[QueryObject],
            _near,
            "Keep the features of 'of' within 'distance_m' of a feature of 'to'.",
        ),
    ]
