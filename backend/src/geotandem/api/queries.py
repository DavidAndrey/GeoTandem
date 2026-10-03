"""Saved and shared queries over HTTP (plan E1.7b, design C6).

Every signed-in account: its own queries, and the shared ones whose layers it
sees all (Q4). Only the owner changes a query; anyone may copy one.
"""

from fastapi import APIRouter, Response

from geotandem import saved_queries
from geotandem.api.auth import CurrentAccount
from geotandem.api.routes import ERRORS, State, Visible
from geotandem.engine import validate_query
from geotandem.saved_queries import (
    SavedQueryDetail,
    SavedQueryPatch,
    SavedQuerySummary,
    SavedQueryWrite,
    Usage,
)

router = APIRouter(prefix="/api/queries", tags=["queries"])

QUERY_ERRORS = {**ERRORS, 403: ERRORS[400], 409: ERRORS[400]}


def _layers(body: SavedQueryWrite, state: State, backend: Visible) -> list[str]:
    """Checks the query against the data core under the account's view, like running it."""
    return validate_query(body.query, backend, state.limits, state.unsupported).layers


@router.get("")
def list_queries(
    account: CurrentAccount, state: State, backend: Visible
) -> list[SavedQuerySummary]:
    return saved_queries.list_queries(state.backend.engine, account.id, backend)


@router.post("", status_code=201, responses=QUERY_ERRORS)
def create(
    body: SavedQueryWrite, account: CurrentAccount, state: State, backend: Visible
) -> SavedQueryDetail:
    layers = _layers(body, state, backend)
    return saved_queries.create(state.backend.engine, account.id, body, layers)


@router.get("/{query_id}", responses=ERRORS)
def get(query_id: str, account: CurrentAccount, state: State, backend: Visible) -> SavedQueryDetail:
    return saved_queries.get(state.backend.engine, account.id, query_id, backend)


@router.put("/{query_id}", responses=QUERY_ERRORS)
def save(
    query_id: str,
    body: SavedQueryWrite,
    account: CurrentAccount,
    state: State,
    backend: Visible,
) -> SavedQueryDetail:
    layers = _layers(body, state, backend)
    engine = state.backend.engine
    return saved_queries.save(engine, account.id, query_id, body, layers, backend)


@router.patch("/{query_id}", responses=QUERY_ERRORS)
def patch(
    query_id: str,
    body: SavedQueryPatch,
    account: CurrentAccount,
    state: State,
    backend: Visible,
) -> SavedQuerySummary:
    """Rename or share (owner only)."""
    return saved_queries.patch(state.backend.engine, account.id, query_id, body, backend)


@router.post("/{query_id}/duplicate", status_code=201, responses=ERRORS)
def duplicate(
    query_id: str, account: CurrentAccount, state: State, backend: Visible
) -> SavedQuerySummary:
    return saved_queries.duplicate(state.backend.engine, account.id, query_id, backend)


@router.get("/{query_id}/usage", responses=ERRORS)
def usage(query_id: str, account: CurrentAccount, state: State, backend: Visible) -> Usage:
    return saved_queries.usage(state.backend.engine, account.id, query_id, backend)


@router.delete("/{query_id}", status_code=204, responses=QUERY_ERRORS)
def delete(query_id: str, account: CurrentAccount, state: State, backend: Visible) -> Response:
    saved_queries.delete(state.backend.engine, account.id, query_id, backend)
    return Response(status_code=204)
