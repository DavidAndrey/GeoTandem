"""What the model learns of a step (D9, D10): ``model_view`` is the only way.

A step's result reaches the model as a ``ModelView`` and as nothing else:
``ok`` or ``error`` with the engine's or the application's code, ``empty`` or
not, and the hit count. Never a row, a geometry, an extent, an attribute value
or an error's text, which may quote any of them. ``ModelView`` has no field
that could hold one; this function is the one place that fills it, and
``tests/test_model_chain.py`` fails when another place does, or when an
engine result reaches a module that talks to the model by another way.

``part`` names what an error is about, but only a layer or attribute **name
the model itself wrote** in the step's arguments: a name taken from a name's
place there (``layer``, ``attr``), never from a value's (``value``,
``values``, ``text``). An attribute value can look like a name
(``kantonsstrasse_b``); an error detail that holds one, or anything else the
model did not write, is dropped. So is a name from a condition the step took
over from an earlier one (``of``, ``in``): an error inside an inherited
condition reaches the model with its code and ``part`` ``None``.

A plan the checks refused before any step ran (``check_plan``) reaches the
model the same way, for the step the refusal names (plan-chain-eval, F7): its
code, and as ``part`` a name the model wrote as above or, failing one, the
word of the tool's schema the refusal is about (``to``, ``where``,
``buffer``: ``SCHEMA_PARTS``). A schema word holds no data; the refusal's
message and its error texts never reach the model.

The data release of the connection (C6) changes nothing here (D10): nothing
of the data is offered that it could release. It begins to count with the
first tool that returns row content (plan 9).
"""

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from pydantic import TypeAdapter, ValidationError

from geotandem.engine import QueryError
from geotandem.model.schemas import ModelView, Name, PlannedStep, Refusal

StepOutcome = int | QueryError | Refusal
"""What became of a step (``run.run_step``): its count, or the engine's error;
or the checks' refusal of the plan it is in, before anything ran."""

NAME_KEYS: Final = frozenset({"layer", "attr"})
"""Where a chain step's arguments, conditions included, hold a layer or attribute name."""

PART_KEYS: Final = ("attribute", "layer")
"""Where an error's details name what it is about, the most precise first."""

SCHEMA_PARTS: Final = frozenset(
    {"layer", "of", "in", "with", "to", "where", "distance_m", "buffer", "related", "source"}
)
"""Words of the tools' schemas and of the query object a refusal may be about:
the arguments of the chain's tools, and the parts ``not_representable`` names."""

_NAME: Final = TypeAdapter[str](Name)


@dataclass(frozen=True)
class StepResult:
    """A step's outcome with the arguments the model wrote for it."""

    arguments: Mapping[str, Any]
    outcome: StepOutcome


def names_in(arguments: Mapping[str, Any]) -> frozenset[str]:
    """The layer and attribute names the model wrote in ``arguments``."""

    def walk(node: Any) -> Iterator[str]:
        if isinstance(node, Mapping):
            for key, value in node.items():
                if key in NAME_KEYS and isinstance(value, str):
                    yield value
                yield from walk(value)
        elif isinstance(node, list):
            for value in node:
                yield from walk(value)

    return frozenset(walk(arguments))


def _part(details: Mapping[str, Any], arguments: Mapping[str, Any]) -> str | None:
    written = names_in(arguments)
    for key in PART_KEYS:
        candidate = details.get(key)
        if isinstance(candidate, str) and candidate in written and _is_name(candidate):
            return candidate
    return None


def _is_name(text: str) -> bool:
    try:
        _NAME.validate_python(text)
    except ValidationError:
        return False
    return True


def _schema_part(details: Mapping[str, Any]) -> str | None:
    """The schema word a refusal is about: its ``part``, or the argument its
    first schema error is in (``loc`` ``["arguments", "to"]``)."""
    part = details.get("part")
    if isinstance(part, str) and part in SCHEMA_PARTS:
        return part
    errors = details.get("errors")
    loc = errors[0].get("loc") if isinstance(errors, list) and errors else None
    if isinstance(loc, list) and len(loc) > 1 and loc[0] == "arguments" and loc[1] in SCHEMA_PARTS:
        return str(loc[1])
    return None


def model_view(result: StepResult) -> ModelView:
    """The only function that turns an engine result or error, or a refusal of
    the checks, into what the model sees (D9, D10)."""
    outcome = result.outcome
    if isinstance(outcome, Refusal):
        details = outcome.details
        part = _part(details, result.arguments) or _schema_part(details)
        return ModelView.model_validate({"outcome": "error", "code": outcome.code, "part": part})
    if isinstance(outcome, QueryError):
        return ModelView.model_validate(
            {
                "outcome": "error",
                "code": outcome.code,
                "part": _part(outcome.details, result.arguments),
            }
        )
    if isinstance(outcome, bool):
        raise TypeError("a count is a number")
    return ModelView(outcome="ok", empty=outcome == 0, count=outcome)


def refused_step(refusal: Refusal, steps: Sequence[PlannedStep]) -> tuple[int, str, ModelView]:
    """The step of a first plan (positions from 1) that ``refusal`` names, as
    the model sees it: its position, its tool and ``model_view`` of the
    refusal over the arguments the model wrote for it (F7). A refusal that
    names no step of the plan is shown at the plan's last step."""
    position = refusal.details.get("step")
    if not isinstance(position, int) or isinstance(position, bool):
        position = len(steps)
    position = min(max(position, 1), len(steps))
    step = steps[position - 1]
    return position, step.tool, model_view(StepResult(step.arguments, refusal))


def restored(stored: Mapping[str, Any] | None) -> ModelView | None:
    """A view ``model_view`` made, as the record keeps it (WP75), read back for
    the user's view of the step and for a later re-plan. Validated again: a
    stored view that would not pass ``ModelView`` (no free text, a name for
    ``part``) is refused, not handed on."""
    return None if stored is None else ModelView.model_validate(stored)
