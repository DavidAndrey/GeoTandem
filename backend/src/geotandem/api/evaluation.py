"""The evaluation of model connections over HTTP (plan E3, section 6).

Frozen in WP85 with every route, its guard and its answer; every work package
behind them has landed (WP87, WP90, WP92, WP94). Administrators only (F-3.1):
a user gets 403 on every route. A run is a measurement, not use (D8): no
route here writes a model action. A route that runs a case's reference holds
one of the instance's query slots (``QuerySlot``, security review #47); an
import and a deletion of cases are security events (#50).
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query, Response
from fastapi.responses import StreamingResponse

from geotandem import audit
from geotandem.api.auth import require_admin
from geotandem.api.errors import ErrorBody, NotFound
from geotandem.api.routes import QuerySlot
from geotandem.api.state import AppState, get_state
from geotandem.auth import accounts
from geotandem.auth.accounts import Account
from geotandem.catalog import model_profile
from geotandem.evaluation.cases import Cases, sample_backend
from geotandem.evaluation.run import Evaluation
from geotandem.evaluation.schemas import (
    MAX_POINTS,
    AnswerView,
    CaseDraft,
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
    Tag,
    Username,
)
from geotandem.evaluation.store import CaseFilters
from geotandem.evaluation.summary import profile_summary as summarize
from geotandem.model.schemas import MAX_ID, MAX_PAGE
from geotandem.model.service import profile_for

router = APIRouter(
    prefix="/api/admin/evaluation", tags=["evaluation"], dependencies=[Depends(require_admin)]
)

ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorBody} for status in (400, 404, 409, 422)
}

Admin = Annotated[Account, Depends(require_admin)]

Id = Annotated[int, Path(ge=1, le=MAX_ID)]
"""A run's or a model action's id; beyond a 64-bit integer it is 422 (E2 review #38)."""


# --- cases (WP87, WP92) ----------------------------------------------------------


def case_service(state: Annotated[AppState, Depends(get_state)], admin: Admin) -> Cases:
    """The cases as the calling administrator works on them (D4)."""
    return Cases(state.settings, state.backend, admin, state.limits, state.unsupported)


CaseService = Annotated[Cases, Depends(case_service)]


@router.get("/cases", responses=ERRORS)
def cases(
    service: CaseService,
    split: Split | None = None,
    tag: Tag | None = None,
    origin: Origin | None = None,
    data_state: DataState | None = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = MAX_PAGE,
    offset: Annotated[int, Query(ge=0, le=MAX_ID)] = 0,
) -> CasePage:
    """The start set and the own cases, start cases first (V1.1); each with its
    status (D3), ``invalid`` by the checks alone. The list leaves
    ``reference_hits`` out."""

    filters = CaseFilters(split=split, tag=tag, origin=origin, data_state=data_state)
    return service.page(filters, offset=offset, limit=limit)


@router.post("/cases", status_code=201, responses=ERRORS, dependencies=[QuerySlot])
def create_case(body: EvalCase, service: CaseService) -> CaseView:
    """An own case: authored in the workplace (V3), taken from the log (V2 from
    M16.2) or copied from a start case. Its reference passes the checks a model
    query passes (``case_invalid``); an id in use is ``case_id_taken``."""
    return service.create(body)


# Unset fields stay out too: a case is written with the fields it was given,
# so the start set exports as its files hold it (same keys, F-3.13).
@router.get(
    "/cases/export",
    responses=ERRORS,
    response_model_exclude_none=True,
    response_model_exclude_unset=True,
)
def export_cases(service: CaseService, start: bool = False) -> CaseFile:
    """The own cases as a case file (F-3.13, F-10.4); with ``start`` the start set
    too, and then without an own case behind a start id (logged). Without
    ``null`` fields, so export and import are a round trip."""
    return service.export(start=start)


@router.post("/cases/import", responses=ERRORS)
def import_cases(body: CaseFile, service: CaseService, admin: Admin) -> ImportResult:
    """All or nothing (V1.3): one invalid case and none is taken."""
    # The body is held to ``max_request_mb`` (2 MiB by default) like any request;
    # a file of ``MAX_CASES`` long cases may exceed it and is then split in two.
    result = service.import_file(body)
    if result.imported:
        audit.event("evaluation_cases_imported", username=admin.username, count=result.imported)
    return result


@router.get("/cases/draft-from-action/{action_id}", responses=ERRORS)
def case_from_action(action_id: Id, service: CaseService) -> CaseDraft:
    """A case prefilled from a logged direct query with decision ``accepted``, or
    ``auto`` not undone (F-3.14); nothing is stored until it is saved with
    ``POST /cases``. Any other action, a hand-corrected one too (decision 2), is
    ``action_not_eligible``."""
    return service.draft(action_id)


@router.get("/cases/{case_id}", responses=ERRORS, dependencies=[QuerySlot])
def case(case_id: CaseId, service: CaseService) -> CaseView:
    """One case with the hits of its reference on its data state (V2.1)."""
    return service.get(case_id)


@router.put("/cases/{case_id}", responses=ERRORS, dependencies=[QuerySlot])
def update_case(case_id: CaseId, body: EvalCase, service: CaseService) -> CaseView:
    """A start case is ``case_read_only``; editing a stale or invalid case makes
    it run again. An own case behind a start id (a later start set brought it)
    is reached here, so it can be renamed."""
    return service.update(case_id, body)


@router.delete("/cases/{case_id}", status_code=204, responses=ERRORS)
def delete_case(case_id: CaseId, service: CaseService, admin: Admin) -> Response:
    """A start case is ``case_read_only``; an own case behind a start id is deleted."""
    service.delete(case_id)
    audit.event("evaluation_case_deleted", username=admin.username, case=case_id)
    return Response(status_code=204)


# --- runs (WP90) -------------------------------------------------------------------


def evaluation(state: Annotated[AppState, Depends(get_state)], admin: Admin) -> Evaluation:
    """The runs as the calling administrator starts them: a live run uses
    the administrator's view (D4)."""
    return Evaluation(
        settings=state.settings,
        backend=state.backend,
        connections=state.connections,
        client_factory=state.client_factory,
        runs=state.runs,
        admin=admin,
        limits=state.limits,
        unsupported=frozenset(state.unsupported),
        gate=state.query_slots,
    )


RunService = Annotated[Evaluation, Depends(evaluation)]


@router.post("/runs/estimate", responses=ERRORS)
def estimate(body: RunRequest, service: RunService) -> CostEstimate:
    """Requests, tokens, cost and duration before the start (D12, V4.1); no
    model call. A selection without a runnable case is ``no_cases``, as at the
    start."""
    return service.estimate(body)


@router.post("/runs", status_code=202, responses=ERRORS)
def start_run(body: RunRequest, service: RunService) -> RunView:
    """Starts the run in the background and answers at once, ``running``; the
    client polls ``GET /runs/{id}`` (D8). One run at a time (``run_busy``); an
    external connection not in ``confirm_external``, or whose host is not in
    ``confirm_external_hosts`` (changed since the estimate), is
    ``external_not_confirmed``;
    a selection with no runnable case (all filtered out, stale or invalid) is
    refused before the start, 400 ``no_cases``. ``RunView.error`` is for what
    fails while the run runs."""
    return service.start(body)


@router.get("/runs", responses=ERRORS)
def runs(
    service: RunService,
    connection_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
    offset: Annotated[int, Query(ge=0, le=MAX_ID)] = 0,
) -> RunPage:
    """Newest first; with ``connection_id`` the runs that measured it (O7)."""
    return service.page(connection_id, offset=offset, limit=limit)


@router.get("/runs/{run_id}", responses=ERRORS)
def run(run_id: Id, service: RunService) -> RunView:
    """Polled while the run runs; figures and comparisons once it is done."""
    return service.view(run_id)


@router.post("/runs/{run_id}/abort", responses=ERRORS)
def abort_run(run_id: Id, service: RunService) -> RunView:
    """Stops before the next question; the answers so far stay."""
    return service.abort(run_id)


@router.get("/runs/{run_id}/answers", responses=ERRORS)
def answers(
    run_id: Id,
    case_id: CaseId,
    point: Annotated[int, Query(ge=0, le=MAX_POINTS - 1)],
    service: RunService,
) -> list[AnswerView]:
    """The repeats of one case at one measuring point (V7)."""
    return service.answers(run_id, case_id, point)


@router.get("/runs/{run_id}/export", responses=ERRORS, response_model=RunExport)
def export_run(run_id: Id, service: RunService) -> StreamingResponse:
    """The run with every answer, as JSON (V6.2 *Exportieren*): written as it is
    read, the answers a batch at a time, so a large run is never held whole
    (security review #46). Every key of the schema is present, ``null`` ones
    too."""
    return StreamingResponse(service.export(run_id), media_type="application/json")


@router.post("/comparison", responses=ERRORS)
def compare_runs(body: CompareRequest, service: RunService) -> RunComparison:
    """Two complete runs over the same cases side by side (V6.6, D7);
    otherwise ``runs_not_comparable``."""
    return service.compare(body)


# --- the state of the layer profile (WP94) -------------------------------------


@router.get("/profile-summary", responses=ERRORS)
def profile_summary(
    state: Annotated[AppState, Depends(get_state)],
    admin: Admin,
    data_state: DataState = "live",
    account: Username | None = None,
) -> ProfileSummary:
    """How complete the metadata is that the model sees (D11, V8): of the sample
    data, or of the live catalog as ``account`` sees it (default: the caller).
    An unknown ``account`` is 404, as on ``GET /api/admin/llm/profile``; the
    sample is the same for every account (D4)."""
    found = admin
    if account is not None:
        known = (a for a in accounts.list_accounts(state.backend.engine) if a.username == account)
        match = next(known, None)
        if match is None:
            raise NotFound(f"Unknown account '{account}'.", account=account)
        found = match
    if data_state == "sample":
        view = sample_backend(state.settings)
        return summarize(model_profile(view.engine, view.layer_names()), view.engine)
    _, found_profile = profile_for(state.backend, found)
    return summarize(found_profile, state.backend.engine)
