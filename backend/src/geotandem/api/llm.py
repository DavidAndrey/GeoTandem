"""The account's side of model support (plan E2.1, C14): what it may choose, and its choice.

The levels join these options with the workplace pickers (WP59).
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from geotandem.api.auth import CurrentAccount
from geotandem.api.errors import ErrorBody
from geotandem.api.state import AppState, get_state
from geotandem.connections import Choice, LLMOptions

router = APIRouter(prefix="/api/llm", tags=["llm"])
State = Annotated[AppState, Depends(get_state)]

ERRORS: dict[int | str, dict[str, Any]] = {400: {"model": ErrorBody}, 422: {"model": ErrorBody}}


@router.get("/options")
def options(state: State, account: CurrentAccount) -> LLMOptions:
    """Enabled connections, the account's choice and what is active now (C17)."""
    return state.connections.options(account.id)


@router.put("/options", responses=ERRORS)
def choose(body: Choice, state: State, account: CurrentAccount) -> LLMOptions:
    """Choose a connection, or none for the default. A disabled one is refused,
    for administrators too (C14)."""
    return state.connections.choose(account.id, body.connection_id)
