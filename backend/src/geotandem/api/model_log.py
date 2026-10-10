"""The log of model actions for administrators (F-6.9, D4, design M16.1, M16.2).

Frozen in WP62; WP73 fills it in. Administrators see every entry, prompt text
included; users read their own through ``/api/model/my-actions``.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from geotandem.api.auth import require_admin
from geotandem.api.model import ERRORS, NotBuilt
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


class Filters:
    """Period, level, connection, approach, account (design M16.1)."""

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


Filtered = Annotated[Filters, Depends()]


@router.get("", responses=ERRORS)
def actions(
    filters: Filtered,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
) -> ModelActionPage:
    raise NotBuilt("WP73")


# Before "/{action_id}", which would take the name for an id.
@router.get("/key-figures", responses=ERRORS)
def key_figures(filters: Filtered) -> KeyFigures:
    """Plan section 2, computed over the action table for the filters."""
    raise NotBuilt("WP73")


@router.get("/export.csv", responses=ERRORS, response_class=Response)
def export_csv(filters: Filtered) -> Response:
    """CSV of the filtered log; cells safe against formula injection."""
    raise NotBuilt("WP73")


@router.get("/{action_id}", responses=ERRORS)
def action(action_id: int) -> ModelActionView:
    raise NotBuilt("WP73")
