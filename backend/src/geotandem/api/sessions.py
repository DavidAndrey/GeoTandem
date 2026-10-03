"""Analysis sessions over HTTP (F-4.10, plan E1.7): every signed-in account,
its own sessions only. Another account's session answers 404, never 403, so
ids reveal nothing (design decision 2).
"""

from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Response

from geotandem import sessions
from geotandem.api.auth import CurrentAccount
from geotandem.api.routes import ERRORS, State, Visible
from geotandem.engine import ResultStamp, stamp_query
from geotandem.sessions import Check, SessionDetail, SessionRename, SessionSummary, SessionWrite
from geotandem_query import QueryObject

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

SESSION_ERRORS = {**ERRORS, 409: ERRORS[400]}


def stamper(state: State, backend: Visible) -> Callable[[QueryObject], ResultStamp]:
    """Stamps a query under the account's view and the server's limits (F-2.7, F-9.6)."""

    def stamp(query: QueryObject) -> ResultStamp:
        return stamp_query(query, backend, state.limits, state.unsupported)

    return stamp


Stamper = Annotated[Callable[[QueryObject], ResultStamp], Depends(stamper)]


def _stamp(body: SessionWrite, stamp: Stamper) -> ResultStamp | None:
    return stamp(body.query) if body.query is not None else None


@router.get("")
def list_sessions(account: CurrentAccount, state: State, backend: Visible) -> list[SessionSummary]:
    return sessions.list_sessions(state.backend.engine, account.id, backend)


@router.post("", status_code=201, responses=SESSION_ERRORS)
def create(
    body: SessionWrite, account: CurrentAccount, state: State, backend: Visible, stamp: Stamper
) -> SessionDetail:
    """Save the analysis as a new session ("Speichern unter", design C2)."""
    return sessions.create(state.backend.engine, account.id, body, _stamp(body, stamp), backend)


@router.get("/last")
def last(account: CurrentAccount, state: State, backend: Visible) -> SessionDetail | None:
    """The session to open after sign-in; null when there is none (design A2)."""
    return sessions.last_opened(state.backend.engine, account.id, backend)


@router.get("/{session_id}", responses=ERRORS)
def get(session_id: str, account: CurrentAccount, state: State, backend: Visible) -> SessionDetail:
    return sessions.get(state.backend.engine, account.id, session_id, backend)


@router.put("/{session_id}", responses=SESSION_ERRORS)
def save(
    session_id: str,
    body: SessionWrite,
    account: CurrentAccount,
    state: State,
    backend: Visible,
    stamp: Stamper,
) -> SessionDetail:
    """Overwrite with the current state ("Speichern"); sets a new stamp."""
    engine = state.backend.engine
    return sessions.save(engine, account.id, session_id, body, _stamp(body, stamp), backend)


@router.patch("/{session_id}", responses=SESSION_ERRORS)
def rename(
    session_id: str,
    body: SessionRename,
    account: CurrentAccount,
    state: State,
    backend: Visible,
) -> SessionSummary:
    return sessions.rename(state.backend.engine, account.id, session_id, body, backend)


@router.delete("/{session_id}", status_code=204, responses=ERRORS)
def delete(session_id: str, account: CurrentAccount, state: State) -> Response:
    sessions.delete(state.backend.engine, account.id, session_id)
    return Response(status_code=204)


@router.post("/{session_id}/duplicate", status_code=201, responses=ERRORS)
def duplicate(
    session_id: str, account: CurrentAccount, state: State, backend: Visible
) -> SessionSummary:
    return sessions.duplicate(state.backend.engine, account.id, session_id, backend)


@router.post("/{session_id}/check", responses=ERRORS)
def check(
    session_id: str,
    account: CurrentAccount,
    state: State,
    backend: Visible,
    stamp: Stamper,
) -> Check:
    """Open with check (design C4): the saved query again, against the saved stamp."""
    engine = state.backend.engine
    return sessions.check(engine, account.id, session_id, backend, stamp)
