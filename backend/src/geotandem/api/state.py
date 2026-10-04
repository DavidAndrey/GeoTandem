from dataclasses import dataclass

from fastapi import Request

from geotandem.api.slots import QuerySlots
from geotandem.auth.throttle import LoginThrottle
from geotandem.config import Settings
from geotandem.data import DataBackend, Limits, Op
from geotandem.importing.isolation import ReadLimits
from geotandem.importing.staging import Staging
from geotandem.tools import ToolContext, ToolRegistry


@dataclass
class AppState:
    settings: Settings
    backend: DataBackend
    unsupported: dict[Op, list[str]]
    tools: ToolRegistry
    staging: Staging
    login_throttle: LoginThrottle
    query_slots: QuerySlots
    setup_token: str | None = None
    """While no account exists: what setup asks for (auth.setup_token)."""

    @property
    def read_limits(self) -> ReadLimits:
        """How an import file is read, in a process of its own (security review #9)."""
        s = self.settings
        return ReadLimits(
            memory_mb=s.import_memory_mb,
            cpu_s=s.import_timeout_s,
            wall_s=s.import_timeout_s * 1.2,
            unpacked_mb=s.max_import_unpacked_mb,
        )

    @property
    def limits(self) -> Limits:
        return Limits(self.settings.max_features, self.settings.query_timeout_s)

    def tool_context(self, view: DataBackend) -> ToolContext:
        """Tools run as the account calling them: ``view`` is its ``view_for`` (F-2.7)."""
        return ToolContext(view, self.limits, frozenset(self.unsupported))


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.geotandem
    return state
