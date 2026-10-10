"""The chain's tools as the model meets them (P4, plan WP74).

The registry's chain tools (``geotandem.tools.chain``) take earlier results as
query objects. In a planned step the model names an earlier step by its
position instead (``Ref``, 1 for the first): the same input model with
``Ref`` in place of ``QueryObject``. The application resolves a reference to
that step's query object, never the model.

Planning is one call that returns the steps as structured output (P4): no
tool is called by the model. ``tool_list`` is the part of the answer format
that names the tools, their arguments as JSON schema, and the conditions they
take, cut to what the controls write (``result.conditions_as_controls``).
"""

import json
from dataclasses import dataclass
from functools import cache
from typing import Annotated, Any, Final, get_args

from pydantic import BaseModel, Field

from geotandem.model.result import NOT_IN_CONTROLS, conditions_as_controls, drop_titles
from geotandem.model.schemas import MAX_CONDITIONS, MAX_STEPS
from geotandem.tools.chain import chain_tools
from geotandem.tools.registry import Tool
from geotandem_query import QueryObject

Ref = Annotated[
    int, Field(ge=1, le=MAX_STEPS, description="Position of an earlier step; 1 is the first.")
]
"""An earlier step, in a planned step's arguments."""


@dataclass(frozen=True)
class ChainTool:
    tool: Tool[Any, QueryObject]
    """The registry's tool: earlier results as query objects."""
    arguments: type[BaseModel]
    """Its input as the model writes it: earlier results as ``Ref``."""
    references: tuple[str, ...]
    """The fields that name an earlier step."""

    @property
    def name(self) -> str:
        return self.tool.name


def _references(model: type[BaseModel]) -> tuple[str, ...]:
    def mentions(annotation: Any) -> bool:
        return annotation is QueryObject or any(mentions(a) for a in get_args(annotation))

    return tuple(name for name, f in model.model_fields.items() if mentions(f.annotation))


def _as_planned(tool: Tool[Any, QueryObject]) -> ChainTool:
    origin = tool.input_model.__pydantic_generic_metadata__["origin"]
    if origin is None:
        raise TypeError(f"chain tool '{tool.name}' has no generic input")
    return ChainTool(tool, origin[Ref], _references(tool.input_model))


CHAIN: Final[dict[str, ChainTool]] = {t.name: _as_planned(t) for t in chain_tools()}
"""Every chain tool by name, in the prompt's order."""


@cache
def _schemas() -> tuple[dict[str, Any], dict[str, Any]]:
    """Each tool's arguments schema, and the definitions they share, with the
    conditions as the controls write them (as for the direct query)."""
    shared: dict[str, Any] = {}
    tools: dict[str, Any] = {}
    for name, chain in CHAIN.items():
        schema = chain.arguments.model_json_schema(by_alias=True)
        shared.update(schema.pop("$defs", {}))
        tools[name] = schema
    conditions_as_controls(shared, tools)
    for name in NOT_IN_CONTROLS:
        del shared[name]
    drop_titles(tools)
    drop_titles(shared)
    return tools, shared


def _compact(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


@cache
def tool_list() -> str:
    """The tools in the answer format of the chain (P4), in German framing; the
    descriptions are the registry's, written once (F-10.2)."""
    tools, shared = _schemas()
    lines = [
        'Werkzeuge: ein Schritt ist {"text", "tool", "arguments"}. "text" sagt den Schritt '
        'in Worten, "arguments" folgt dem Schema des Werkzeugs. Ein früherer Schritt wird mit '
        "seiner Nummer genannt (1 ist der erste) und muss vor dem Schritt stehen, der ihn "
        f"nennt. Höchstens {MAX_STEPS} Schritte; das Ergebnis des letzten Schritts ist die "
        "Antwort. Jeder Schritt baut ein Abfrageobjekt, nichts wird gespeichert; es hat "
        f"höchstens {MAX_CONDITIONS} Bedingungen, die übernommenen eingerechnet. Ein Schritt, "
        "auf den sich ein räumlicher Schritt bezieht, hat höchstens eine Attributbedingung, "
        "nicht verneint.",
    ]
    for name, chain in CHAIN.items():
        lines.append(f"- {name} ({chain.tool.op_class}): {chain.tool.description}")
        lines.append(f"  {_compact(tools[name])}")
    lines.append('Bedingungen ("where"), auf die "#/$defs/…" verweist: ' + _compact(shared))
    lines.append(
        "Nach jedem Schritt erfährst du nur: ok oder ein Fehlercode, leer oder nicht und die "
        "Trefferzahl; nie Objekte, Werte oder Geometrien."
    )
    return "\n".join(lines)
