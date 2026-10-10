"""A model's query checked before anyone sees it as a proposal (D1, D3, plan WP64).

In order, each step ending in a ``Refusal``:

1. the query-object schema: an extra field, such as a write-shaped
   ``delete``, is refused, never ignored (F-9.5) ⇒ ``model_query_invalid``
   with ``details.errors``;
2. the engine's validation under the account's view: a layer that does not
   exist and one hidden from the account are the same ``unknown_layer``, with
   the same details, so a prompt cannot probe for hidden layers. The engine's
   codes pass through; one the refusal codes do not name is ``invalid_query``
   with the engine's code in ``details.cause``;
3. the condition limit of the model path ⇒ ``limit_exceeded``;
4. representability in the controls ⇒ ``not_representable`` (D3).

Nothing here runs the query: no row is read.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Final, get_args

from pydantic import ValidationError

from geotandem.engine import QueryError, validate_query
from geotandem.levels import OpClass, classify
from geotandem.model.represent import NotRepresentable, to_analysis
from geotandem.model.schemas import MAX_CONDITIONS, Refusal, RefusalCode
from geotandem.tools import ToolContext
from geotandem_query import And, Condition, Not, Or, QueryObject

REFUSAL_CODES: Final = frozenset(get_args(RefusalCode))


@dataclass(frozen=True)
class Validated:
    query: QueryObject
    classes: frozenset[OpClass]
    """``classify`` of the query: the input of the level's decision (H4, D1)."""


def leaf_conditions(query: QueryObject) -> int:
    """Leaf conditions of ``query`` (design M3.2): ``and``, ``or`` and ``not`` do
    not count; a relation counts once with its filter, as one row of the controls."""
    roots: list[Condition | None] = [query.where]
    if query.spatial_relation is not None:
        roots.append(query.spatial_relation.where)
    roots.extend(column.where for column in query.columns)
    return sum(1 for root in roots for _ in _leaves(root))


def _leaves(condition: Condition | None) -> Iterator[Condition]:
    if condition is None:
        return
    if isinstance(condition, And | Or):
        for arg in condition.args:
            yield from _leaves(arg)
    elif isinstance(condition, Not):
        yield from _leaves(condition.arg)
    else:
        yield condition


def condition_limit(query: QueryObject) -> Refusal | None:
    """``limit_exceeded`` when ``query`` has more leaf conditions than ``MAX_CONDITIONS``."""
    value = leaf_conditions(query)
    if value <= MAX_CONDITIONS:
        return None
    return Refusal(
        code="limit_exceeded",
        message=f"The query has {value} conditions; at most {MAX_CONDITIONS} are allowed.",
        details={"limit": "conditions", "value": value, "max": MAX_CONDITIONS},
    )


def validate_model_query(raw: dict[str, Any], context: ToolContext) -> Validated | Refusal:
    """The query of a ``query`` answer, checked for the account ``context`` serves."""
    try:
        query = QueryObject.model_validate(raw)
    except ValidationError as exc:
        return Refusal(
            code="model_query_invalid",
            message="The model's query does not match the query-object schema.",
            details={"errors": _errors(exc)},
        )
    try:
        validate_query(query, context.backend, context.limits, context.unsupported)
    except QueryError as exc:
        return _engine_refusal(exc)
    if (limit := condition_limit(query)) is not None:
        return limit
    try:
        to_analysis(query)
    except NotRepresentable as exc:
        return Refusal(code="not_representable", message=str(exc), details={"part": exc.part})
    return Validated(query=query, classes=classify(query))


def _errors(exc: ValidationError) -> list[dict[str, Any]]:
    return [
        {"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]}
        for e in exc.errors(include_url=False, include_input=False, include_context=False)
    ]


def _engine_refusal(exc: QueryError) -> Refusal:
    if exc.code in REFUSAL_CODES:
        return Refusal.model_validate(
            {"code": exc.code, "message": exc.message, "details": exc.details}
        )
    return Refusal(
        code="invalid_query", message=exc.message, details={**exc.details, "cause": exc.code}
    )
