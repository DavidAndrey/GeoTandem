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
   reference to no earlier step ⇒ ``model_query_invalid`` with ``errors``
   (a spatial step may name a whole layer instead, ``tools.Target``: its
   features, no condition, checked in 4 as any layer of a query);
3. a step that cannot extend the query object (``tools.chain``), or relates
   anything but points to a buffer by ``within`` or ``outside`` ⇒
   ``not_representable`` with the argument as ``part``; ``within`` or
   ``outside`` of points or lines, ``contains`` on them, whose result the
   geometry types decide whatever the data ⇒ ``part: geometry`` (F13);
4. the step's query object in the model's world, as a direct query is
   (``validate.check_query``: the engine's validation, what the controls can
   show, the condition limit); a buffer is validated whole by the engine once,
   and shown as what it buffers;
5. a chain that ends in a buffer ⇒ ``not_representable``, ``part: buffer``
   (D3): a buffer that feeds a spatial step becomes its distance, but as a
   result the controls cannot show it;
6. a step no later step reads whose conditions the result lacks ⇒
   ``not_representable``, ``part: unused`` (F15): the result is the last
   step's, so the plan does not answer what its steps say.

A step's classes (H4) are its tool's (H2) and those of the conditions it
writes itself; the conditions it takes over from an earlier step are counted
there. The chain is governed by all its steps' classes (``chain_classes``),
never by ``classify`` of the last query: the composition turns a buffer into a
distance and would hide ``derive``. Nothing here runs a query.
"""

import json
from collections.abc import Collection, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from pydantic import BaseModel, ValidationError

from geotandem.catalog import ModelProfile
from geotandem.levels import CellMode, Level, OpClass, classify, strictest
from geotandem.model.chain.tools import CHAIN, ChainTool
from geotandem.model.direct import governance
from geotandem.model.labels import as_codes
from geotandem.model.schemas import MAX_STEPS, Governance, PlannedStep, Refusal
from geotandem.model.shapes import plain
from geotandem.model.validate import NESTED, check_query, invalid, schema_errors
from geotandem.tools import ToolContext
from geotandem.tools.chain import NotComposable
from geotandem_query import And, Condition, QueryObject

POINTS = ("Point",)
"""Geometry types for which lying in a buffer is lying within its distance: a
multipoint lies in a buffer when all its points do, within its distance when
one does."""

NO_AREAS: Final = ("Point", "MultiPoint", "LineString", "MultiLineString")
"""Geometry types no feature lies in and that contain no feature but their own
kind: ``within`` or ``outside`` of them, and ``contains`` on them, is empty or
everything whatever the data (plan-chain-eval, F13). A layer of another or of
no known type is not checked."""


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


def step_cell(level: Level, step: CheckedStep) -> CellMode:
    """The cell that governs one step: the strictest of its classes (H4)."""
    return strictest(level, [c for c in OpClass if c in step.classes])


def one_approval(cells: Iterable[CellMode]) -> bool:
    """Whether the steps ahead, with these cells, are approved as a whole (P4,
    design M8.1): none of them runs without approval (*Prüfen*), so one
    approval covers the rest of the chain. Otherwise (*Teilautonom*) the run
    halts before each step whose cell is ``approve``, and an approval clears
    that step only; ``auto`` steps never wait (*Automatisch*: never)."""
    return all(cell is not CellMode.AUTO for cell in cells)


def check_plan(
    steps: Sequence[PlannedStep],
    context: ToolContext,
    profile: ModelProfile,
    *,
    done: Sequence[CheckedStep] = (),
    positions: Sequence[int] | None = None,
    spent: int | None = None,
) -> list[CheckedStep] | Refusal:
    """``steps`` after the completed ``done`` (a re-plan, P4), checked in the
    world of ``profile``, the layer profile the model was given for the
    account whose read-only view ``context`` holds.

    ``positions`` are the steps' own, ascending, after every one of ``done``:
    by default they continue after the last of ``done``. A step names an
    earlier one by its position; one that is not there (removed from the plan,
    or failed before a re-plan) is no earlier step. ``spent``: the steps that
    count against the limit already, by default ``done``; a re-plan counts the
    failed ones too (P4)."""
    start = done[-1].position + 1 if done else 1
    places = list(positions) if positions is not None else [start + i for i in range(len(steps))]
    if len(places) != len(steps) or places != sorted(set(places)) or (places and places[0] < start):
        raise ValueError("positions: one per step, ascending, after the completed steps")
    used = len(done) if spent is None else spent
    total = used + len(steps)
    if total > MAX_STEPS:
        return Refusal(
            code="step_limit",
            message=f"The chain has {total} steps; at most {MAX_STEPS} are allowed.",
            details={"value": total, "max": MAX_STEPS, "step": places[max(MAX_STEPS - used, 0)]},
        )
    checked = list(done)
    for step, position in zip(steps, places, strict=True):
        found = _check_step(step, position, checked, context, profile)
        if isinstance(found, Refusal):
            return found
        checked.append(found)
    if checked and checked[-1].query.buffer is not None:
        last = checked[-1].position
        message = f"Step {last}: a chain does not end in a buffer; the controls cannot show it."
        return _not_composable("buffer", message, last)
    new = checked[len(done) :]
    if (lost := _lost(new)) is not None:
        message = f"Step {lost}: no later step reads it, and the result lacks what it adds."
        return _not_composable("unused", message, lost)
    return new


def _canonical(node: Any) -> str:
    return json.dumps(node, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _lost(steps: Sequence[CheckedStep]) -> int | None:
    """The first of ``steps`` but the last that no later one reads and whose
    conditions, or buffer distance, the last step's query lacks: the result is
    the last step's alone, so what that step adds is lost (plan-chain-eval,
    F15). A step the result repeats (a filter the next step writes again on
    its layer) loses nothing and passes."""
    if len(steps) < 2:
        return None
    read = {position for s in steps for position in reads(s.step).values()}
    result = _canonical(steps[-1].query.model_dump(mode="json", by_alias=True))
    for step in steps[:-1]:
        if step.position in read:
            continue
        parts = [*_parts(step.query.where)]
        kept = all(_canonical(p.model_dump(mode="json", by_alias=True)) in result for p in parts)
        if step.query.buffer is not None:
            kept = kept and f'"distance_m":{_canonical(step.query.buffer.distance_m)}' in result
        if not kept:
            return step.position
    return None


def _parts(condition: Condition | None) -> Iterator[Condition]:
    """``condition`` as the parts of its top-level ``and``."""
    if isinstance(condition, And):
        for arg in condition.args:
            yield from _parts(arg)
    elif condition is not None:
        yield condition


# --- the user's edit of a plan (design M8.3, decision 17) ------------------------------

VALUE_KEYS: Final = frozenset({"value", "values", "min", "max", "text", "distance_m"})
"""Where a step's arguments, conditions included, hold a value the user may
change (the frontend's plan editor offers the same): everything else, every
key, operator, layer, attribute and step reference, stays as planned."""


def values_only(before: Any, after: Any, key: str = "") -> bool:
    """``after`` differs from ``before`` in values only (``VALUE_KEYS``)."""
    if key in VALUE_KEYS:
        return True
    if isinstance(before, dict):
        return (
            isinstance(after, dict)
            and before.keys() == after.keys()
            and all(values_only(before[k], after[k], k) for k in before)
        )
    if isinstance(before, list):
        return (
            isinstance(after, list)
            and len(before) == len(after)
            and all(values_only(b, a, key) for b, a in zip(before, after, strict=True))
        )
    return type(before) is type(after) and before == after


def reads(step: PlannedStep) -> dict[str, int]:
    """The earlier steps ``step`` names, by the argument that names each."""
    chain = CHAIN.get(step.tool)
    if chain is None:
        return {}
    fields = chain.arguments.model_fields
    named = ((fields[name].alias or name) for name in chain.references)
    return {
        key: value
        for key in named
        if isinstance(value := step.arguments.get(key), int) and not isinstance(value, bool)
    }


@dataclass(frozen=True)
class Placed:
    """A step of a plan at its position."""

    position: int
    step: PlannedStep


def edit_plan(
    plan: Sequence[Placed], change: Mapping[int, dict[str, Any]], remove: Collection[int]
) -> list[Placed] | Refusal:
    """``plan`` (the steps not removed yet) with the values of ``change`` set and
    the steps of ``remove`` left out; never a step more (design decision 17).
    Refused as ``invalid_query``, naming the step (``details.step``): a position
    that is no step of the plan, a step both changed and removed, a change of
    anything but a value, a removed step a remaining one names, nothing left.
    The caller checks what remains whole (``check_plan``)."""
    at = {placed.position: placed for placed in plan}
    for position in (*change, *remove):
        if position not in at:
            return _edit_refused(f"There is no step {position} in the plan.", step=position)
    for position, arguments in change.items():
        if position in remove:
            return _edit_refused(f"Step {position} is changed and removed.", step=position)
        if not values_only(at[position].step.arguments, arguments):
            message = f"Step {position}: only values may change, every name stays."
            return _edit_refused(message, step=position)
    kept = [
        Placed(p.position, p.step.model_copy(update={"arguments": change[p.position]}))
        if p.position in change
        else p
        for p in plan
        if p.position not in remove
    ]
    if not kept:
        return _edit_refused("A plan keeps one step at least.")
    for placed in kept:
        for key, position in reads(placed.step).items():
            if position in remove:
                message = (
                    f"Step {placed.position} reads the result of step {position} ('{key}'), "
                    "which is removed."
                )
                return _edit_refused(message, step=placed.position, reads=position, part=key)
    return kept


def _edit_refused(message: str, **details: Any) -> Refusal:
    return Refusal(code="invalid_query", message=message, details=details)


def _refused(refusal: Refusal, position: int) -> Refusal:
    return refusal.model_copy(update={"details": {**refusal.details, "step": position}})


def _invalid(errors: list[dict[str, Any]], position: int) -> Refusal:
    message = f"Step {position} does not match the schema of a chain step."
    return invalid(errors, message, step=position)


def _not_composable(part: str, message: str, position: int) -> Refusal:
    return Refusal(
        code="not_representable", message=message, details={"step": position, "part": part}
    )


def _geometry(
    tool: str,
    query: QueryObject,
    resolved: Mapping[str, Any],
    profile: ModelProfile,
    position: int,
) -> Refusal | None:
    """A spatial step whose geometry types decide its result whatever the data:
    ``within`` or ``outside`` of a buffer for anything but points (``in``), of
    points or lines (``geometry``, F13); ``contains`` on points or lines."""
    kinds = {layer.name: layer.geometry_type for layer in profile.layers}
    if tool in ("within", "outside") and resolved["in_"].buffer is not None:
        if kinds.get(query.source) not in POINTS:
            reason = "lying in a buffer is lying within its distance for points only"
            message = f"Step {position}: 'in': {reason}"
            return _not_composable("in", message, position)
    elif tool in ("within", "outside") and kinds.get(resolved["in_"].source) in NO_AREAS:
        message = f"Step {position}: 'in' holds no areas; nothing lies in a point or a line"
        return _not_composable("geometry", message, position)
    if tool == "contains" and kinds.get(query.source) in NO_AREAS:
        message = f"Step {position}: 'of' holds no areas; only an area contains features"
        return _not_composable("geometry", message, position)
    return None


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
    by_position = {s.position: s for s in earlier}
    for name in chain.references:
        ref = resolved[name]
        if ref is None:
            continue
        if isinstance(ref, str):  # a whole layer (``tools.Target``, F11): checked below
            resolved[name] = QueryObject(source=ref)
            continue
        if ref >= position or ref not in by_position:
            loc = ["arguments", fields[name].alias or name]
            error = {"loc": loc, "msg": "Names no earlier step", "type": "step_reference"}
            return _invalid([error], position)
        resolved[name] = by_position[ref].query
    try:
        query: QueryObject = chain.tool.call(context, resolved)
    except NotComposable as exc:
        return _not_composable(exc.part, f"Step {position}: {exc}", position)
    if (refused := _geometry(chain.name, query, resolved, profile, position)) is not None:
        return refused
    query = as_codes(plain(query), profile)
    shown = query.model_copy(update={"buffer": None}) if query.buffer is not None else None
    found = check_query(query, context, profile, shown=shown)
    if isinstance(found, Refusal):
        return _refused(found, position)
    return CheckedStep(position, step, query, step_classes(chain, arguments))
