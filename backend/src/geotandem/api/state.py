from dataclasses import dataclass

from fastapi import Request

from geotandem.config import Settings
from geotandem.data import DataBackend, Limits, Op
from geotandem.tools import ToolContext, ToolRegistry


@dataclass
class AppState:
    settings: Settings
    backend: DataBackend
    unsupported: dict[Op, list[str]]
    tools: ToolRegistry

    @property
    def limits(self) -> Limits:
        return Limits(self.settings.max_features, self.settings.query_timeout_s)

    @property
    def tool_context(self) -> ToolContext:
        return ToolContext(self.backend, self.limits, frozenset(self.unsupported))


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.geotandem
    return state
