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

The data release of the connection (C6) changes nothing here (D10): nothing
of the data is offered that it could release. It begins to count with the
first tool that returns row content (plan 9).
"""

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Any, Final

from pydantic import TypeAdapter, ValidationError

from geotandem.engine import QueryError
from geotandem.model.schemas import ModelView, Name

StepOutcome = int | QueryError
"""What became of a step (``run.run_step``): its count, or the engine's error."""

NAME_KEYS: Final = frozenset({"layer", "attr"})
"""Where a chain step's arguments, conditions included, hold a layer or attribute name."""

PART_KEYS: Final = ("attribute", "layer")
"""Where an error's details name what it is about, the most precise first."""

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


def model_view(result: StepResult) -> ModelView:
    """The only function that turns an engine result or error into what the
    model sees (D9, D10)."""
    outcome = result.outcome
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


def restored(stored: Mapping[str, Any] | None) -> ModelView | None:
    """A view ``model_view`` made, as the record keeps it (WP75), read back for
    the user's view of the step and for a later re-plan. Validated again: a
    stored view that would not pass ``ModelView`` (no free text, a name for
    ``part``) is refused, not handed on."""
    return None if stored is None else ModelView.model_validate(stored)
