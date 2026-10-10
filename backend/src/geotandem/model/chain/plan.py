"""A planned step list, checked and composed into query objects (P4, plan WP74).

Each step names a chain tool (``chain.tools.CHAIN``) and its arguments, an
earlier step by its position. ``check_plan`` resolves every reference to that
step's query object and lets the tool build the step's own: so each step has
one query object, the last step's is the chain's result (F-5.7), and nothing
is materialised. In order, each failure a ``Refusal`` naming the step
(``details.step``, 1 for the first):

1. the step limit, counting the completed steps of a re-plan too (P4) ⇒
   ``step_limit``;
2. a tool the chain does not have, arguments that do not fit its schema, a
   reference to no earlier step ⇒ ``model_query_invalid`` with ``errors``;
3. a step that cannot extend the query object (``tools.chain``), or relates
   lines or areas to a buffer by ``within`` or ``outside`` ⇒
   ``not_representable`` with the argument as ``part``;
4. the step's query object in the model's world, as a direct query is
   (``validate.check_query``: the engine's validation, what the controls can
   show, the condition limit); a buffer by the same check of what it buffers
   and the engine's validation of the buffer.

A step's classes (H4) are its tool's (H2) and those of the conditions it
writes itself; the conditions it takes over from an earlier step are counted
there. Nothing here runs a query.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError

from geotandem.catalog import ModelProfile
from geotandem.engine import QueryError, validate_query
from geotandem.levels import OpClass, classify
from geotandem.model.chain.tools import CHAIN, ChainTool
from geotandem.model.schemas import MAX_LISTED, MAX_STEPS, PlannedStep, Refusal
from geotandem.model.validate import ModelWorld, Validated, check_query
from geotandem.tools import ToolContext
from geotandem.tools.chain import NotComposable
from geotandem_query import QueryObject

POINTS = ("Point", "MultiPoint")
"""Geometry types for which lying in a buffer is lying within its distance."""


@dataclass(frozen=True)
class CheckedStep:
    position: int
    """1 for the first step of the chain, re-planned steps continue the count."""
    step: PlannedStep
    query: QueryObject
    """The step's result as one query object: counted, never stored as a table."""
    classes: frozenset[OpClass]


def step_limit(value: int) -> Refusal:
    return Refusal(
        code="step_limit",
        message=f"The chain has {value} steps; at most {MAX_STEPS} are allowed.",
        details={"value": value, "max": MAX_STEPS},
    )


def step_classes(chain: ChainTool, arguments: BaseModel) -> frozenset[OpClass]:
    """The tool's class and those of the conditions the step writes (H4)."""
    where = getattr(arguments, "where", None)
    if where is None:
        return frozenset({chain.tool.op_class})
    written = QueryObject(source=getattr(arguments, "layer", None) or "step", where=where)
    return frozenset({chain.tool.op_class}) | classify(written)


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
        return step_limit(total)
    checked = list(done)
    for step in steps:
        found = _check_step(step, len(checked) + 1, checked, context, profile)
        if isinstance(found, Refusal):
            return found
        checked.append(found)
    return checked[len(done) :]


def _refused(refusal: Refusal, position: int) -> Refusal:
    return refusal.model_copy(update={"details": {**refusal.details, "step": position}})


def _invalid(errors: list[dict[str, Any]], position: int) -> Refusal:
    return Refusal(
        code="model_query_invalid",
        message=f"Step {position} does not match the schema of a chain step.",
        details={"step": position, "errors": errors[:MAX_LISTED], "error_count": len(errors)},
    )


def _engine(exc: QueryError, position: int) -> Refusal:
    refusal = Refusal.model_validate(
        {"code": exc.code, "message": exc.message, "details": exc.details}
    )
    return _refused(refusal, position)


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
        errors = exc.errors(include_url=False, include_input=False, include_context=False)
        return _invalid(
            [{"loc": ["arguments", *e["loc"]], "msg": e["msg"], "type": e["type"]} for e in errors],
            position,
        )
    except RecursionError:
        error = {"loc": ["arguments"], "msg": "Nested too deeply", "type": "recursion_loop"}
        return _invalid([error], position)
    resolved: dict[str, Any] = {
        name: getattr(arguments, name) for name in type(arguments).model_fields
    }
    for name in chain.references:
        ref = resolved[name]
        if ref is None:
            continue
        if ref >= position:
            alias = type(arguments).model_fields[name].alias or name
            error = {
                "loc": ["arguments", alias],
                "msg": "Names no earlier step",
                "type": "step_reference",
            }
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
            return _not_composable("in", f"Step {position}: 'in': {reason}", position)
    found = _check_query(query, context, profile, position)
    if isinstance(found, Refusal):
        return found
    return CheckedStep(position, step, query, step_classes(chain, arguments))


def _not_composable(part: str, message: str, position: int) -> Refusal:
    return Refusal(
        code="not_representable", message=message, details={"step": position, "part": part}
    )


def _check_query(
    query: QueryObject, context: ToolContext, profile: ModelProfile, position: int
) -> Validated | Refusal:
    """As a direct query is checked; a buffer by what it buffers, and its distance."""
    shown = query.model_copy(update={"buffer": None})
    found = check_query(shown, context, profile)
    if isinstance(found, Refusal):
        return _refused(found, position)
    if query.buffer is not None:
        world = ModelWorld(context.backend, profile)
        try:
            validate_query(query, world, context.limits, context.unsupported)
        except QueryError as exc:
            return _engine(exc, position)
    return found
