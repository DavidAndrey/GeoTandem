"""A model's query checked before anyone sees it as a proposal (D1, D3, plan WP64).

Checked against the **model's world**: the account's view (``view_for``)
narrowed to its layer profile, the layers and attributes released for the
model (S3). A layer that does not exist, one hidden from the account and one
not released for the model are the same ``unknown_layer`` with the same
details; an attribute not released for the model is ``unknown_attribute``. So
a prompt can neither probe for what it must not know nor use it.

In order, each step ending in a ``Refusal``:

1. the query-object schema: an extra field, such as a write-shaped
   ``delete``, is refused, never ignored (F-9.5) ⇒ ``model_query_invalid``
   with ``details.errors``; then a shape that means the same is written
   plain (``shapes.plain``: ``and`` of one, ``not`` of ``not``) and a code's
   label written for the code becomes the code (``labels.as_codes``), and the
   query goes on as rewritten;
2. the engine's validation in the model's world; its codes pass through
   (``RefusalCode`` names every validation code of the engine);
3. representability in the controls ⇒ ``not_representable`` (D3);
4. the condition limit of the model path, counted on the analysis of step 3
   (``count_conditions``) ⇒ ``limit_exceeded``.

The analysis a follow-up starts from (P6) must pass the same check before it
goes into a prompt: WP81 calls ``check_query`` on it, so a hand-made analysis
cannot carry what the model's own query could not.

Nothing here runs the query: no row is read.
"""

from dataclasses import dataclass
from typing import Any, Final

from pydantic import ValidationError
from sqlalchemy import Column, MetaData, Table

from geotandem.catalog import ModelProfile
from geotandem.data import DataBackend
from geotandem.data.view import LayerView
from geotandem.engine import QueryError, validate_query
from geotandem.engine.compile import FID, GEOM
from geotandem.levels import OpClass, classify
from geotandem.model.labels import as_codes
from geotandem.model.represent import NotRepresentable, catalog_of, count_conditions, to_analysis
from geotandem.model.schemas import MAX_CONDITIONS, MAX_LISTED, Refusal
from geotandem.model.shapes import plain
from geotandem.tools import ToolContext
from geotandem_query import QueryObject


@dataclass(frozen=True)
class Validated:
    query: QueryObject
    classes: frozenset[OpClass]
    """``classify`` of the query: the input of the level's decision (H4, D1)."""


class ModelWorld(LayerView):
    """The account's view as the model may know it: only the profile's layers,
    and of each only the attributes released for the model (plus ``fid``)."""

    def __init__(self, view: DataBackend, profile: ModelProfile) -> None:
        super().__init__(view, [layer.name for layer in profile.layers])
        self._released = {
            layer.name: {a.name for a in layer.attributes} | {FID, GEOM} for layer in profile.layers
        }
        self._tables: dict[str, Table] = {}

    def layer_table(self, name: str) -> Table:
        table = super().layer_table(name)
        if name not in self._tables:
            kept = [c for c in table.columns if c.name in self._released[name]]
            self._tables[name] = Table(
                table.name,
                MetaData(),
                *(Column(c.name, c.type, key=c.key, primary_key=c.primary_key) for c in kept),
            )
        return self._tables[name]


def refusal_of(exc: QueryError) -> Refusal:
    """The engine's error as a refusal: its code passes through (``RefusalCode``)."""
    return Refusal.model_validate(
        {"code": exc.code, "message": exc.message, "details": exc.details}
    )


def schema_errors(exc: ValidationError) -> list[dict[str, Any]]:
    """Where and why a document missed its schema, without its input."""
    return [
        {"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]}
        for e in exc.errors(include_url=False, include_input=False, include_context=False)
    ]


def check_query(
    query: QueryObject,
    context: ToolContext,
    profile: ModelProfile,
    *,
    shown: QueryObject | None = None,
) -> Validated | Refusal:
    """Steps 2 to 4 for a schema-valid query: a model's, or a follow-up's analysis (P6).
    ``shown`` is the part the controls show, when it is not the whole query (a
    chain's buffer: what it buffers); the engine checks the whole query once."""
    world = ModelWorld(context.backend, profile)
    try:
        validate_query(query, world, context.limits, context.unsupported)
    except QueryError as exc:
        return refusal_of(exc)
    try:
        part = to_analysis(shown or query, catalog_of(profile))
    except NotRepresentable as exc:
        return Refusal(code="not_representable", message=str(exc), details={"part": exc.part})
    value = count_conditions(part)
    if value > MAX_CONDITIONS:
        return Refusal(
            code="limit_exceeded",
            message=f"The query has {value} conditions; at most {MAX_CONDITIONS} are allowed.",
            details={"limit": "conditions", "value": value, "max": MAX_CONDITIONS},
        )
    return Validated(query=query, classes=classify(query))


def validate_model_query(
    raw: dict[str, Any], context: ToolContext, profile: ModelProfile
) -> Validated | Refusal:
    """The query of a ``query`` answer, checked in the world of ``profile``, the
    layer profile the model was given for the account ``context`` serves."""
    try:
        query = QueryObject.model_validate(raw)
    except ValidationError as exc:
        return invalid(schema_errors(exc))
    except RecursionError:
        return invalid([NESTED])
    return check_query(as_codes(plain(query), profile), context, profile)


NESTED: Final = {"loc": [], "msg": "Nested too deeply", "type": "recursion_loop"}


def invalid(
    errors: list[dict[str, Any]],
    message: str = "The model's query does not match the query-object schema.",
    **details: Any,
) -> Refusal:
    """``model_query_invalid``: the first ``MAX_LISTED`` errors and how many there were."""
    return Refusal(
        code="model_query_invalid",
        message=message,
        details={**details, "errors": errors[:MAX_LISTED], "error_count": len(errors)},
    )
