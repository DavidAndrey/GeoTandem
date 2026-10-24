"""The evaluation of model connections over HTTP (plan E3, section 6).

Frozen in WP85 with every route, its guard and its answer; each body answers
501 ``not_implemented`` until its work package fills it in (WP87, WP90, WP92,
WP94). Administrators only (F-3.1): a user gets 403 on every route. A run is a
measurement, not use (D8): no route here writes a model action.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query, Response

from geotandem.api.auth import require_admin
from geotandem.api.errors import ErrorBody, Problem
from geotandem.evaluation.schemas import (
    AnswerView,
    CaseFile,
    CaseId,
    CasePage,
    CaseView,
    CompareRequest,
    CostEstimate,
    DataState,
    EvalCase,
    ImportResult,
    Origin,
    ProfileSummary,
    RunComparison,
    RunExport,
    RunPage,
    RunRequest,
    RunView,
    Split,
)
from geotandem.model.schemas import MAX_ID, MAX_PAGE

router = APIRouter(
    prefix="/api/admin/evaluation", tags=["evaluation"], dependencies=[Depends(require_admin)]
)

ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorBody} for status in (400, 404, 409, 422, 501)
}

Id = Annotated[int, Path(ge=1, le=MAX_ID)]
"""A run's or a model action's id; beyond a 64-bit integer it is 422 (E2 review #38)."""


class NotBuilt(Problem):
    """A route of the frozen contract whose work package has not landed yet."""

    status = 501
    code = "not_implemented"

    def __init__(self, wp: str) -> None:
        super().__init__(f"Not built yet ({wp}).", wp=wp)


# --- cases (WP87, WP92) ----------------------------------------------------------


@router.get("/cases", responses=ERRORS)
def cases(
    split: Split | None = None,
    tag: str | None = None,
    origin: Origin | None = None,
    data_state: DataState | None = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = MAX_PAGE,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> CasePage:
    """The start set and the own cases, start cases first (V1.1); each with its
    status (D3). The list leaves ``reference_hits`` out."""
    raise NotBuilt("WP87")


@router.post("/cases", status_code=201, responses=ERRORS)
def create_case(body: EvalCase) -> CaseView:
    """An own case: authored in the workplace (V3), taken from the log (V2 from
    M16.2) or copied from a start case. Its reference passes the checks a model
    query passes (``case_invalid``); an id in use is ``case_id_taken``."""
    raise NotBuilt("WP87")


@router.get("/cases/export", responses=ERRORS)
def export_cases(start: bool = False) -> CaseFile:
    """The own cases as a case file (F-3.13, F-10.4); with ``start`` the start set too."""
    raise NotBuilt("WP87")


@router.post("/cases/import", responses=ERRORS)
def import_cases(body: CaseFile) -> ImportResult:
    """All or nothing (V1.3): one invalid case and none is taken."""
    raise NotBuilt("WP87")


@router.get("/cases/draft-from-action/{action_id}", responses=ERRORS)
def case_from_action(action_id: Id) -> EvalCase:
    """A case prefilled from a logged direct query with decision ``accepted``, or
    ``auto`` not undone (F-3.14); nothing is stored until it is saved with
    ``POST /cases``. A hand-corrected action is not offered (decision 2)."""
    raise NotBuilt("WP92")


@router.get("/cases/{case_id}", responses=ERRORS)
def case(case_id: CaseId) -> CaseView:
    """One case with the hits of its reference on its data state (V2.1)."""
    raise NotBuilt("WP87")


@router.put("/cases/{case_id}", responses=ERRORS)
def update_case(case_id: CaseId, body: EvalCase) -> CaseView:
    """A start case is ``case_read_only``; editing a stale case makes it run again."""
    raise NotBuilt("WP87")


@router.delete("/cases/{case_id}", status_code=204, responses=ERRORS)
def delete_case(case_id: CaseId) -> Response:
    raise NotBuilt("WP87")


# --- runs (WP90) -------------------------------------------------------------------


@router.post("/runs/estimate", responses=ERRORS)
def estimate(body: RunRequest) -> CostEstimate:
    """Requests, tokens, cost and duration before the start (D12, V4.1); no model call."""
    raise NotBuilt("WP90")


@router.post("/runs", status_code=202, responses=ERRORS)
def start_run(body: RunRequest) -> RunView:
    """Starts the run in the background and answers at once, ``running``; the
    client polls ``GET /runs/{id}`` (D8). One run at a time (``run_busy``); an
    external connection not in ``confirm_external`` is ``external_not_confirmed``."""
    raise NotBuilt("WP90")


@router.get("/runs", responses=ERRORS)
def runs(
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> RunPage:
    raise NotBuilt("WP90")


@router.get("/runs/{run_id}", responses=ERRORS)
def run(run_id: Id) -> RunView:
    """Polled while the run runs; figures and comparisons once it is done."""
    raise NotBuilt("WP90")


@router.post("/runs/{run_id}/abort", responses=ERRORS)
def abort_run(run_id: Id) -> RunView:
    """Stops before the next question; the answers so far stay."""
    raise NotBuilt("WP90")


@router.get("/runs/{run_id}/answers", responses=ERRORS)
def answers(
    run_id: Id,
    case_id: CaseId,
    point: Annotated[int, Query(ge=0)],
) -> list[AnswerView]:
    """The repeats of one case at one measuring point (V7)."""
    raise NotBuilt("WP90")


@router.get("/runs/{run_id}/export", responses=ERRORS)
def export_run(run_id: Id) -> RunExport:
    """The run with every answer, as JSON (V6.2 *Exportieren*)."""
    raise NotBuilt("WP90")


@router.post("/comparison", responses=ERRORS)
def compare_runs(body: CompareRequest) -> RunComparison:
    """Two complete runs over the same cases side by side (V6.6, D7);
    otherwise ``runs_not_comparable``."""
    raise NotBuilt("WP90")


# --- the state of the layer profile (WP94) -------------------------------------


@router.get("/profile-summary", responses=ERRORS)
def profile_summary(account: str) -> ProfileSummary:
    """How complete the metadata is that ``account``'s model sees (D11, V8)."""
    raise NotBuilt("WP94")
