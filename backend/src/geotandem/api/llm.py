"""The account's side of model support (plan E2.1, C14; E2.0, H6): what it may
choose — connection and level — and its choice. Checked here, on every
request, not only by the interface.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from geotandem.api.auth import CurrentAccount
from geotandem.api.errors import ErrorBody
from geotandem.api.state import AppState, get_state
from geotandem.auth.accounts import Account
from geotandem.connections import ConnectionOption
from geotandem.levels import active_level, choose_level, chosen_level_id, load_levels

router = APIRouter(prefix="/api/llm", tags=["llm"])
State = Annotated[AppState, Depends(get_state)]

ERRORS: dict[int | str, dict[str, Any]] = {400: {"model": ErrorBody}, 422: {"model": ErrorBody}}


class LevelOption(BaseModel):
    id: int
    name: str
    description: str
    selectable: bool
    """False only in an administrator's list: users never see such a level (H6)."""


class LLMOptions(BaseModel):
    connections: list[ConnectionOption]
    """Enabled connections; none when the administrator has set none up (C18)."""
    chosen_connection_id: int | None
    """The account's stored choice, even while that connection is disabled (C17)."""
    active_connection_id: int | None
    """What a model action would use now: the choice if enabled, else the default."""
    levels: list[LevelOption]
    """The levels open to the account: the selectable ones, for administrators all."""
    chosen_level_id: int | None
    active_level_id: int
    """The choice while it exists and is open, else the default (H7)."""


class Choice(BaseModel):
    """Only the fields sent change; ``null`` returns to the default."""

    connection_id: int | None = Field(default=None, description="None: the default.")
    level_id: int | None = Field(default=None, description="None: the default.")


def _options(state: AppState, account: Account) -> LLMOptions:
    admin = account.role == "admin"
    engine = state.backend.engine
    connections = state.connections.options(account.id)
    return LLMOptions(
        **connections.model_dump(),
        levels=[
            LevelOption(
                id=level.id,
                name=level.name,
                description=level.description,
                selectable=level.selectable,
            )
            for level in load_levels(engine)
            if level.id is not None and (level.selectable or admin)
        ],
        chosen_level_id=chosen_level_id(engine, account.id),
        active_level_id=active_level(engine, account.id, admin=admin).id,
    )


@router.get("/options")
def options(state: State, account: CurrentAccount) -> LLMOptions:
    return _options(state, account)


@router.put("/options", responses=ERRORS)
def choose(body: Choice, state: State, account: CurrentAccount) -> LLMOptions:
    """Choose a connection, a level or both. A disabled connection is refused for
    administrators too (C14); a level users may not choose is refused for users."""
    if "connection_id" in body.model_fields_set:
        state.connections.choose(account.id, body.connection_id)
    if "level_id" in body.model_fields_set:
        choose_level(state.backend.engine, account.id, body.level_id, admin=account.role == "admin")
    return _options(state, account)
