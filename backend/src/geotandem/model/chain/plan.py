"""A planned step list, checked and composed into query objects (P4, plan WP74).

Each step names a chain tool (``chain.tools.CHAIN``) and its arguments, an
earlier step by its position. ``check_plan`` resolves every reference to that
step's query object and lets the tool build the step's own: so each step has
one query object, the last step's is the chain's result (F-5.7), and nothing
is materialised. In order, each failure a ``Refusal`` naming the step
(``details.step``, 1 for the first):

1. the step limit, counting the completed steps of a re-plan too (P4) ⇒
   ``step_limit``, naming the first step beyond it;
2. a tool the chain does not have, arguments that do not fit its schema, a
   reference to no earlier step ⇒ ``model_query_invalid`` with ``errors``;
3. a step that cannot extend the query object (``tools.chain``), or relates
   anything but points to a buffer by ``within`` or ``outside`` ⇒
   ``not_representable`` with the argument as ``part``;
4. the step's query object in the model's world, as a direct query is
   (``validate.check_query``: the engine's validation, what the controls can
   show, the condition limit); a buffer is validated whole by the engine once,
   and shown as what it buffers;
5. a chain that ends in a buffer ⇒ ``not_representable``, ``part: buffer``
   (D3): a buffer that feeds a spatial step becomes its distance, but as a
   result the controls cannot show it.

A step's classes (H4) are its tool's (H2) and those of the conditions it
writes itself; the conditions it takes over from an earlier step are counted
there. The chain is governed by all its steps' classes (``chain_classes``),
never by ``classify`` of the last query: the composition turns a buffer into a
distance and would hide ``derive``. Nothing here runs a query.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError

from geotandem.catalog import ModelProfile
from geotandem.levels import Level, OpClass, classify
from geotandem.model.chain.tools import CHAIN, ChainTool
from geotandem.model.direct import governance
from geotandem.model.schemas import MAX_STEPS, Governance, PlannedStep, Refusal
from geotandem.model.validate import NESTED, check_query, invalid, schema_errors
from geotandem.tools import ToolContext
from geotandem.tools.chain import NotComposable
from geotandem_query import QueryObject

POINTS = ("Point",)
"""Geometry types for which lying in a buffer is lying within its distance: a
multipoint lies in a buffer when all its points do, within its distance when
one does."""


@dataclass(frozen=True)
class CheckedStep:
    position: int
    """1 for the first step of the chain, re-planned steps continue the count."""
    step: PlannedStep
    query: QueryObject
    """The step's result as one query object: counted, never stored as a table."""
    classes: frozenset[OpClass]


def step_classes(chain: ChainTool, arguments: BaseModel) -> frozenset[OpClass]:
    """The tool's class and those of the conditions the step writes (H4)."""
    where = getattr(arguments, "where", None)
    if where is None:
        return frozenset({chain.tool.op_class})
    written = QueryObject(source=getattr(arguments, "layer", None) or "step", where=where)
    return frozenset({chain.tool.op_class}) | classify(written)


def chain_classes(steps: Iterable[CheckedStep]) -> frozenset[OpClass]:
    """Every class the chain touches: the union of its steps' (H4)."""
    return frozenset().union(*(step.classes for step in steps))


def chain_governance(level: Level, steps: Iterable[CheckedStep]) -> Governance:
    """What ``level`` decides for the whole chain, a re-plan or its adoption (D1)."""
    return governance(level, chain_classes(steps))


def check_plan(
    steps: Sequence[PlannedStep],
    context: ToolContext,
    profile: ModelProfile,
    *,
    done: Sequence[CheckedStep] = (),
) -> list[CheckedStep] | Refusal:
    """``steps`` after the completed ``done`` (a re-plan, P4), checked in the
    world of ``profile``, the layer profile the model was given for the
    account whose read-only view ``context`` holds."""
    total = len(done) + len(steps)
    if total > MAX_STEPS:
        return Refusal(
            code="step_limit",
            message=f"The chain has {total} steps; at most {MAX_STEPS} are allowed.",
            details={"value": total, "max": MAX_STEPS, "step": MAX_STEPS + 1},
        )
    checked = list(done)
    for step in steps:
        found = _check_step(step, len(checked) + 1, checked, context, profile)
        if isinstance(found, Refusal):
            return found
        checked.append(found)
    if checked and checked[-1].query.buffer is not None:
        last = checked[-1].position
        message = f"Step {last}: a chain does not end in a buffer; the controls cannot show it."
        return _not_composable("buffer", message, last)
    return checked[len(done) :]


def _refused(refusal: Refusal, position: int) -> Refusal:
    return refusal.model_copy(update={"details": {**refusal.details, "step": position}})


def _invalid(errors: list[dict[str, Any]], position: int) -> Refusal:
    message = f"Step {position} does not match the schema of a chain step."
    return invalid(errors, message, step=position)


def _not_composable(part: str, message: str, position: int) -> Refusal:
    return Refusal(
        code="not_representable", message=message, details={"step": position, "part": part}
    )


def _check_step(
    step: PlannedStep,
    position: int,
    earlier: Sequence[CheckedStep],
    context: ToolContext,
    profile: ModelProfile,
) -> CheckedStep | Refusal:
    chain = CHAIN.get(step.tool)
    if chain is None:
        error = {"loc": ["tool"], "msg": "Not a tool of the chain", "type": "unknown_tool"}
        return _invalid([error], position)
    try:
        arguments = chain.arguments.model_validate(step.arguments)
    except ValidationError as exc:
        errors = [{**e, "loc": ["arguments", *e["loc"]]} for e in schema_errors(exc)]
        return _invalid(errors, position)
    except RecursionError:
        return _invalid([{**NESTED, "loc": ["arguments"]}], position)
    fields = type(arguments).model_fields
    resolved: dict[str, Any] = {name: getattr(arguments, name) for name in fields}
    for name in chain.references:
        ref = resolved[name]
        if ref is None:
            continue
        if ref >= position:
            loc = ["arguments", fields[name].alias or name]
            error = {"loc": loc, "msg": "Names no earlier step", "type": "step_reference"}
            return _invalid([error], position)
        resolved[name] = earlier[ref - 1].query
    try:
        query: QueryObject = chain.tool.call(context, resolved)
    except NotComposable as exc:
        return _not_composable(exc.part, f"Step {position}: {exc}", position)
    if chain.name in ("within", "outside") and resolved["in_"].buffer is not None:
        kinds = {layer.name: layer.geometry_type for layer in profile.layers}
        if kinds.get(query.source) not in POINTS:
            reason = "lying in a buffer is lying within its distance for points only"
            message = f"Step {position}: 'in': {reason}"
            return _not_composable("in", message, position)
    shown = query.model_copy(update={"buffer": None}) if query.buffer is not None else None
    found = check_query(query, context, profile, shown=shown)
    if isinstance(found, Refusal):
        return _refused(found, position)
    return CheckedStep(position, step, query, step_classes(chain, arguments))
