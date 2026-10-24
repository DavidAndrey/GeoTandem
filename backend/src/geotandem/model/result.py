"""The model's reply read as a ``ModelAnswer`` (D7, plan WP64).

What the prompt demands and what is accepted are the same set of answers:
``answer_format`` cuts ``answer_schema()`` down to the kinds of one approach,
and for the direct approach the query object down to what the controls can
show (D3); ``parse_answer`` accepts exactly those kinds. A reply that is not
JSON, nests too deep, does not fit the schema or is of another approach's kind
is ``model_unreadable``, or ``model_truncated`` when the model stopped at its
length limit (``finish_reason`` "length"): an answer that reads is taken
whatever the finish reason. Its ``details.cause`` names error types and schema
locations only, never the model's text: the record shows it to the user and
the log keeps it (C15).
"""

import copy
import json
import re
from dataclasses import dataclass
from functools import cache
from typing import Any, Final

from pydantic import TypeAdapter, ValidationError

from geotandem.llm import Completion
from geotandem.model.errors import ActionError
from geotandem.model.represent import ALLOWED_FIELDS
from geotandem.model.schemas import (
    MAX_LISTED,
    Approach,
    CannotAnswer,
    Clarification,
    ModelAnswer,
    PlanAnswer,
    QueryAnswer,
    answer_schema,
)

KINDS: Final[dict[Approach, tuple[str, ...]]] = {
    "direct": ("query", "clarification", "cannot_answer"),
    "chain": ("plan", "clarification", "cannot_answer"),
}
"""The answers each approach accepts (D7, P4)."""

NOT_IN_CONTROLS: Final = ("BBox", "GeometryFilter")
"""Conditions only the map writes (view, drawn area): never the model's."""

_ANSWER = TypeAdapter[Any](ModelAnswer)

Answer = QueryAnswer | Clarification | CannotAnswer | PlanAnswer


@dataclass(frozen=True)
class Tokens:
    """What a model call cost as the endpoint reported it (bewertung.md 10);
    ``None`` where it reported nothing. The record keeps them, never a view."""

    prompt: int | None = None
    completion: int | None = None

    @classmethod
    def of(cls, completion: Completion) -> "Tokens":
        return cls(completion.prompt_tokens, completion.completion_tokens)


NO_TOKENS: Final = Tokens()
"""No call made, or none reported."""


def answer_format(approach: Approach) -> dict[str, Any]:
    """``answer_schema()`` with only the kinds of ``approach``: what the prompt
    shows and what the call sends as constrained output (D7). A copy."""
    return copy.deepcopy(_format(approach))


def format_text(approach: Approach) -> str:
    """``answer_format`` as compact JSON, as the prompt carries it."""
    return _format_text(approach)


@cache
def _format_text(approach: Approach) -> str:
    return json.dumps(_format(approach), separators=(",", ":"), ensure_ascii=False)


@cache
def _format(approach: Approach) -> dict[str, Any]:
    schema = answer_schema()
    defs: dict[str, Any] = schema["$defs"]
    by_kind = {
        defs[ref.split("/")[-1]]["properties"]["kind"]["const"]: ref
        for ref in (v["$ref"] for v in schema["oneOf"])
    }
    keep = [by_kind[kind] for kind in KINDS[approach]]
    schema["oneOf"] = [{"$ref": ref} for ref in keep]
    discriminator = schema.get("discriminator")
    if discriminator is not None:
        discriminator["mapping"] = {
            kind: ref for kind, ref in discriminator["mapping"].items() if ref in keep
        }
    if approach == "direct":
        _controls_only(defs)
    _tag_first(defs)
    schema["$defs"] = {name: defs[name] for name in sorted(_reachable(schema, defs))}
    drop_titles(schema)
    return schema


def _tag_first(defs: dict[str, Any]) -> None:
    """Each definition's tag (``op``, ``kind``) as its first property. Order
    means nothing to a validator, but constrained output (Ollama, llama.cpp)
    writes properties in schema order: ``related`` inherits ``layer`` before
    its ``op``, so a model that opens a condition with ``"op"``, as every
    other one starts, could never write it (evals/README.md)."""
    for definition in defs.values():
        properties = definition.get("properties")
        for tag in ("op", "kind"):
            if isinstance(properties, dict) and tag in properties:
                definition["properties"] = {tag: properties[tag]} | properties
                break


def _controls_only(defs: dict[str, Any]) -> None:
    """The query object as the controls write it (D3): their fields, ``output``
    always ``map``, and its conditions as ``conditions_as_controls`` cuts them."""
    query = defs["QueryObject"]
    query["properties"] = {k: v for k, v in query["properties"].items() if k in ALLOWED_FIELDS}
    query["properties"]["output"] = {"const": "map", "default": "map", "type": "string"}
    conditions_as_controls(defs)


def conditions_as_controls(defs: dict[str, Any], *schemas: Any) -> None:
    """The conditions in ``defs`` as the controls write them: no view or drawn
    area (``NOT_IN_CONTROLS``, also where ``schemas`` refer to them), text
    matches as the editor offers them. In place; the dropped definitions stay
    in ``defs`` until the caller keeps only what is reachable."""
    text = defs["TextMatch"]["properties"]
    text["mode"]["enum"] = ["contains", "starts_with", "ends_with"]
    text["case_sensitive"] = {"const": False, "default": False, "type": "boolean"}
    dropped = {f"#/$defs/{name}" for name in NOT_IN_CONTROLS}
    stack: list[Any] = [defs, *schemas]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if isinstance(node.get("oneOf"), list):
                node["oneOf"] = [v for v in node["oneOf"] if v.get("$ref") not in dropped]
            mapping = node.get("mapping")
            if isinstance(mapping, dict):
                node["mapping"] = {k: v for k, v in mapping.items() if v not in dropped}
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)


def drop_titles(schema: Any) -> None:
    """Titles repeat the property names: tokens without meaning."""
    if isinstance(schema, dict):
        title = schema.get("title")
        if isinstance(title, str):
            del schema["title"]
        for key, value in schema.items():
            if key != "properties":
                drop_titles(value)
            else:
                for prop in value.values():
                    drop_titles(prop)
    elif isinstance(schema, list):
        for value in schema:
            drop_titles(value)


def _reachable(schema: dict[str, Any], defs: dict[str, Any]) -> set[str]:
    """Names of the definitions the schema still refers to, transitively."""
    found: set[str] = set()
    stack: list[Any] = [{k: v for k, v in schema.items() if k != "$defs"}]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                name = ref.split("/")[-1]
                if name not in found:
                    found.add(name)
                    stack.append(defs[name])
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return found


@cache
def _schema_names() -> frozenset[str]:
    """Property names and constants of the answer schema: the only words of a
    location the cause may repeat."""
    names: set[str] = set()
    stack: list[Any] = [answer_schema()]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if isinstance(node.get("properties"), dict):
                names.update(node["properties"])
            if isinstance(node.get("const"), str):
                names.add(node["const"])
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return frozenset(names)


def unreadable(cause: str) -> ActionError:
    return ActionError(
        "model_unreadable",
        "The model's answer does not fit the answer schema.",
        http_status=502,
        cause=cause,
    )


def truncated(completion: Completion) -> ActionError:
    """An answer cut off at the length limit (testplan E-5): the context is
    full, or the model's own thinking used it up. Unreadable because cut, so
    the administrator learns what to change, not only that it failed."""
    return ActionError(
        "model_truncated",
        "The model stopped at its length limit before its answer was complete.",
        http_status=502,
        prompt_tokens=completion.prompt_tokens,
        completion_tokens=completion.completion_tokens,
    )


class AnswerError(ActionError):
    """An answer that does not read (``model_unreadable``, ``model_truncated``),
    with what its call cost: the record keeps the tokens of a failed call too
    (bewertung.md 10). ``tokens`` is no detail, so no error body shows it."""

    def __init__(self, error: ActionError, tokens: Tokens) -> None:
        super().__init__(error.code, error.message, http_status=error.status, **error.details)
        self.tokens = tokens


def parse_answer(completion: Completion, approach: Approach) -> Answer:
    """The completion as an answer of ``approach``; ``model_truncated`` when it
    does not read and the model stopped at its length limit, ``model_unreadable``
    otherwise, each as an ``AnswerError`` with the completion's tokens."""
    try:
        return _parse(completion, approach)
    except ActionError as exc:
        error = truncated(completion) if completion.finish_reason == "length" else exc
        raise AnswerError(error, Tokens.of(completion)) from None


_FENCE = re.compile(r"\A\s*```(?:json)?[ \t]*\n(.*)\n[ \t]*```\s*\Z", re.DOTALL)


def _unfenced(text: str) -> str:
    """``text`` without one Markdown code fence around it. An endpoint that does
    not constrain the output (Anthropic's compatibility, X-7) often writes
    ```` ```json ```` around the object; nothing else is taken off."""
    found = _FENCE.match(text)
    return found.group(1) if found else text


def _first_object(text: str) -> Any:
    """The JSON value ``text`` starts with, text after it ignored: without
    constrained output a model sometimes explains itself after the object
    (Sonnet 4 of 355, X-10). Text before it still does not read."""
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        if exc.msg != "Extra data":
            raise
        value, _ = json.JSONDecoder().raw_decode(text.lstrip())
        return value


def _parse(completion: Completion, approach: Approach) -> Answer:
    try:
        data = completion.parsed
        if data is None:
            try:
                data = _first_object(_unfenced(completion.text))
            except json.JSONDecodeError as exc:
                # The decoder's message names a position, never the text.
                raise unreadable(f"not JSON: {exc.msg} at char {exc.pos}") from None
        answer: Answer = _ANSWER.validate_python(data)
    except RecursionError:
        raise unreadable("nested too deeply") from None
    except ValidationError as exc:
        raise unreadable(_causes(exc)) from None
    if answer.kind not in KINDS[approach]:
        raise unreadable(f"answer kind '{answer.kind}' is not one of the {approach} approach")
    return answer


def _causes(exc: ValidationError) -> str:
    known = _schema_names()

    def where(loc: tuple[int | str, ...]) -> str:
        parts = [str(p) if isinstance(p, int) or p in known else "?" for p in loc]
        return ".".join(parts) or "(answer)"

    errors = exc.errors(include_url=False, include_input=False, include_context=False)
    listed = "; ".join(f"{where(e['loc'])}: {e['type']}" for e in errors[:MAX_LISTED])
    more = len(errors) - MAX_LISTED
    return f"{listed}; and {more} more" if more > 0 else listed
