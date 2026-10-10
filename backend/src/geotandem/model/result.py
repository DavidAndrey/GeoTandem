"""The model's reply read as a ``ModelAnswer`` (D7, plan WP64).

What the prompt demands and what is accepted are the same set of answers:
``answer_format`` cuts ``answer_schema()`` down to the kinds of one approach,
and ``parse_answer`` accepts exactly those. A reply that is not JSON, does not
fit the schema or is of another approach's kind is ``model_unreadable``, with
the verbatim cause in ``details.cause``. The cause is logged on the record and
never shown to the model again.
"""

import json
from typing import Any, Final

from pydantic import TypeAdapter, ValidationError

from geotandem.llm import Completion
from geotandem.model.errors import ActionError
from geotandem.model.schemas import (
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

_ANSWER = TypeAdapter[Any](ModelAnswer)

Answer = QueryAnswer | Clarification | CannotAnswer | PlanAnswer


def answer_format(approach: Approach) -> dict[str, Any]:
    """``answer_schema()`` with only the kinds of ``approach``: what the prompt
    shows and what the call sends as constrained output (D7)."""
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
    schema["$defs"] = {name: defs[name] for name in sorted(_reachable(schema, defs))}
    return schema


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


def unreadable(cause: str) -> ActionError:
    return ActionError(
        "model_unreadable",
        "The model's answer does not fit the answer schema.",
        status=502,
        cause=cause,
    )


def parse_answer(completion: Completion, approach: Approach) -> Answer:
    """The completion as an answer of ``approach``; ``model_unreadable`` otherwise."""
    data = completion.parsed
    if data is None:
        try:
            data = json.loads(completion.text)
        except json.JSONDecodeError as exc:
            raise unreadable(completion.parse_error or str(exc)) from None
    try:
        answer: Answer = _ANSWER.validate_python(data)
    except ValidationError as exc:
        raise unreadable(_causes(exc)) from None
    if answer.kind not in KINDS[approach]:
        raise unreadable(f"answer kind '{answer.kind}' is not one of the {approach} approach")
    return answer


def _causes(exc: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(map(str, e['loc'])) or '(answer)'}: {e['msg']}"
        for e in exc.errors(include_url=False, include_input=False)
    )
