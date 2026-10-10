"""The log of model actions for administrators (F-6.9, D4, design M16.1, M16.2).

Frozen in WP62, filled in by WP73. Administrators see every entry, prompt text
included; users read their own through ``/api/model/my-actions`` and never
reach this router (403). The list, its key figures and its CSV take the same
filters, so the figures above the list are the figures of the list.
"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from geotandem.api.auth import require_admin
from geotandem.api.model import ERRORS
from geotandem.api.state import AppState, get_state
from geotandem.auth.accounts import Account
from geotandem.model.record import ActionFilters, ModelActionStore
from geotandem.model.record.export import to_csv
from geotandem.model.schemas import (
    MAX_PAGE,
    Approach,
    KeyFigures,
    ModelActionPage,
    ModelActionView,
)

router = APIRouter(
    prefix="/api/admin/model-actions", tags=["admin"], dependencies=[Depends(require_admin)]
)

Admin = Annotated[Account, Depends(require_admin)]


def action_store(state: Annotated[AppState, Depends(get_state)]) -> ModelActionStore:
    return ModelActionStore(state.backend.engine)


Store = Annotated[ModelActionStore, Depends(action_store)]


def _utc(moment: datetime | None) -> datetime | None:
    """The record holds naive UTC; a time sent with a zone is turned into it."""
    if moment is None or moment.tzinfo is None:
        return moment
    return moment.astimezone(UTC).replace(tzinfo=None)


class Filters:
    """Period (``from`` inclusive, ``to`` exclusive, naive UTC or with a zone),
    level, connection, approach, account (design M16.1)."""

    def __init__(
        self,
        since: Annotated[datetime | None, Query(alias="from")] = None,
        until: Annotated[datetime | None, Query(alias="to")] = None,
        level_id: int | None = None,
        connection_id: int | None = None,
        approach: Approach | None = None,
        account: str | None = None,
    ) -> None:
        self.since = since
        self.until = until
        self.level_id = level_id
        self.connection_id = connection_id
        self.approach = approach
        self.account = account

    def for_store(self) -> ActionFilters:
        return ActionFilters(
            since=_utc(self.since),
            until=_utc(self.until),
            level_id=self.level_id,
            connection_id=self.connection_id,
            approach=self.approach,
            account=self.account,
        )


Filtered = Annotated[Filters, Depends()]


@router.get("", responses=ERRORS)
def actions(
    filters: Filtered,
    admin: Admin,
    store: Store,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
) -> ModelActionPage:
    """Newest first, every account's; ``total`` counts all that match."""
    return store.list_actions(admin, filters.for_store(), offset=offset, limit=limit)


# Before "/{action_id}", which would take the name for an id.
@router.get("/key-figures", responses=ERRORS)
def key_figures(filters: Filtered, admin: Admin, store: Store) -> KeyFigures:
    """Plan section 2, computed over the action table for the filters."""
    return store.key_figures(admin, filters.for_store())


@router.get(
    "/export.csv",
    responses={**ERRORS, 200: {"content": {"text/csv": {}}}},
    response_class=Response,
)
def export_csv(filters: Filtered, admin: Admin, store: Store) -> Response:
    """CSV of the filtered log, prompt text included (D4); cells safe against
    formula injection (``model/record/export.py`` names the columns)."""
    body = to_csv(store.export(admin, filters.for_store()))
    day = datetime.now(UTC).date().isoformat()
    return Response(
        # With a byte order mark, so a spreadsheet reads the umlauts as UTF-8.
        content="﻿" + body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="modellprotokoll-{day}.csv"'},
    )


@router.get("/{action_id}", responses=ERRORS)
def action(action_id: int, admin: Admin, store: Store) -> ModelActionView:
    """Any account's record as it was (design M16.2); 404 when there is none."""
    return store.get(admin, action_id)
