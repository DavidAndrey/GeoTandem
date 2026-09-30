"""Registry of GIS tools (F-10.2).

A tool is described once — name, description, Pydantic input and output
models, effect — and from that single description the classic UI, tool
calling (E2, F-7.4) and the MCP server (E4, F-7.5) are served.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel

from geotandem.data import DataBackend, Limits, Op

Effect = Literal["read", "state"]
"""``read`` returns information; ``state`` produces a new analysis state.

No tool writes data: all analysis operations are read-only (F-9.5).
"""


@dataclass(frozen=True)
class ToolContext:
    backend: DataBackend
    limits: Limits
    unsupported: frozenset[Op] = frozenset()


class ToolDescription(BaseModel):
    name: str
    description: str
    effect: Effect
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]


@dataclass(frozen=True)
class Tool[I: BaseModel, O: BaseModel]:
    name: str
    description: str
    input_model: type[I]
    output_model: type[O]
    effect: Effect
    handler: Callable[[ToolContext, I], O]

    def describe(self) -> ToolDescription:
        return ToolDescription(
            name=self.name,
            description=self.description,
            effect=self.effect,
            input_schema=self.input_model.model_json_schema(by_alias=True),
            output_schema=self.output_model.model_json_schema(by_alias=True),
        )

    def call(self, context: ToolContext, arguments: dict[str, Any]) -> O:
        """Validate raw arguments against the input model, then run (F-5.9)."""
        return self.handler(context, self.input_model.model_validate(arguments))


class UnknownTool(KeyError):
    pass


@dataclass
class ToolRegistry:
    _tools: dict[str, Tool[Any, Any]] = field(default_factory=dict)

    def register(self, tool: Tool[Any, Any]) -> None:
        if tool.name in self._tools:
            raise ValueError(f"tool '{tool.name}' is already registered")
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool[Any, Any]:
        try:
            return self._tools[name]
        except KeyError:
            raise UnknownTool(name) from None

    def __iter__(self) -> Iterator[Tool[Any, Any]]:
        return iter(self._tools.values())

    def describe(self) -> list[ToolDescription]:
        return [tool.describe() for tool in self._tools.values()]
