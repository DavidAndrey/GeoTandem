from dataclasses import dataclass

from fastapi import Request

from geotandem.config import Settings
from geotandem.data import DataBackend, Limits, Op
from geotandem.importing.staging import Staging
from geotandem.tools import ToolContext, ToolRegistry


@dataclass
class AppState:
    settings: Settings
    backend: DataBackend
    unsupported: dict[Op, list[str]]
    tools: ToolRegistry
    staging: Staging

    @property
    def limits(self) -> Limits:
        return Limits(self.settings.max_features, self.settings.query_timeout_s)

    def tool_context(self, view: DataBackend) -> ToolContext:
        """Tools run as the account calling them: ``view`` is its ``view_for`` (F-2.7)."""
        return ToolContext(view, self.limits, frozenset(self.unsupported))


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.geotandem
    return state
