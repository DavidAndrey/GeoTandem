"""Modus B over HTTP: prompt, decide, run (plan E2.3-E2.6, section 6).

Frozen in WP62 with every route, its auth and its answer; each body answers
501 ``not_implemented`` until its WP fills it in (WP70, WP73, WP75, WP76).
WP65 built the prompt of the direct query, the record, ``decide`` and
``abort`` (``model/service.py``). Every route needs a signed-in account; a
record of another account is ``not_found`` (404, never 403), as for sessions.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from geotandem.api.auth import CurrentAccount
from geotandem.api.errors import ErrorBody, Problem
from geotandem.api.state import AppState, get_state
from geotandem.model.schemas import (
    MAX_PAGE,
    ActionPreview,
    Comparison,
    DecideRequest,
    ExecuteResponse,
    ModelActionPage,
    ModelActionView,
    PlanEdit,
    PromptRequest,
    RejectRequest,
)
from geotandem.model.service import PromptFlow

router = APIRouter(prefix="/api/model", tags=["model"])

ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorBody} for status in (400, 404, 409, 422, 501)
}
CALLS_MODEL: dict[int | str, dict[str, Any]] = {
    **ERRORS,
    **{status: {"model": ErrorBody} for status in (429, 502, 503, 504)},
}
"""Routes that call the model: quota, the endpoint's failure, every model-call
slot taken, the endpoint's timeout (design M14)."""


class NotBuilt(Problem):
    """A route of the frozen contract whose work package has not landed yet."""

    status = 501
    code = "not_implemented"

    def __init__(self, wp: str) -> None:
        super().__init__(f"Not built yet ({wp}).", wp=wp)


def prompt_flow(state: Annotated[AppState, Depends(get_state)]) -> PromptFlow:
    """The flow over this instance's data core, connections and model client."""
    return PromptFlow(
        backend=state.backend,
        connections=state.connections,
        client_factory=state.client_factory,
        calls=state.model_calls,
        limits=state.limits,
        unsupported=frozenset(state.unsupported),
    )


Flow = Annotated[PromptFlow, Depends(prompt_flow)]


@router.post("/prompt", status_code=202, responses=CALLS_MODEL)
def prompt(body: PromptRequest, account: CurrentAccount, flow: Flow) -> ModelActionView:
    """Ask the model (F-5.1). Level and connection are the account's, resolved
    here (H6, C17). Stores the action record and answers at once with it,
    ``thinking``; the client polls ``GET /actions/{id}`` and may abort. No
    result data: an ``auto`` answer arrives ``approved`` and the client
    executes it (D2). In E2.3 every answer is a proposal (P1). One prompt of an
    account at a time (409 ``busy``); all model calls at once are bounded
    (503 ``busy``)."""
    if body.approach == "chain":
        raise NotBuilt("WP75")
    return flow.prompt(account, body)


@router.get("/actions/{action_id}", responses=ERRORS)
def action(action_id: int, account: CurrentAccount, flow: Flow) -> ModelActionView:
    """One own record, or any for an administrator (D4); polled while the model
    thinks (P7) and while a chain runs (P4)."""
    return flow.get(account, action_id)


@router.get("/actions/{action_id}/preview", responses=ERRORS)
def preview(action_id: int, account: CurrentAccount) -> ActionPreview:
    """Count and ids of the stored query, for the user only (P2): an interactive
    session, no class ``off``, status unchanged."""
    raise NotBuilt("WP70")


@router.post("/actions/{action_id}/decide", responses=ERRORS)
def decide(
    action_id: int, body: DecideRequest, account: CurrentAccount, flow: Flow
) -> ModelActionView:
    """Applied by hand or edited and applied through Modus A (P1, D2); the
    owner's alone. ``adjusted`` names the query the user applied, logged only."""
    return flow.decide(account, action_id, body)


@router.post("/actions/{action_id}/approve", responses=ERRORS)
def approve(action_id: int, account: CurrentAccount) -> ModelActionView:
    """Refused with ``class_not_allowed`` when a class is ``off`` at the level as
    it was (D1, D2)."""
    raise NotBuilt("WP70")


@router.post("/actions/{action_id}/reject", responses=ERRORS)
def reject(action_id: int, body: RejectRequest, account: CurrentAccount) -> ModelActionView:
    raise NotBuilt("WP70")


@router.post("/actions/{action_id}/execute", responses=ERRORS)
def execute(action_id: int, account: CurrentAccount) -> ExecuteResponse:
    """Run the stored query, never a sent one (the route takes no body); only
    ``approved``, by the user or by an ``auto`` cell (D2). The one answer with rows."""
    raise NotBuilt("WP70")


@router.post("/actions/{action_id}/undo", responses=ERRORS)
def undo(action_id: int, account: CurrentAccount) -> ModelActionView:
    """For the log: the client restores the analysis itself (D2)."""
    raise NotBuilt("WP70")


@router.post("/actions/{action_id}/touched", responses=ERRORS)
def touched(action_id: int, account: CurrentAccount) -> ModelActionView:
    """The analysis was changed by hand after this action: undo is over (design rule 7)."""
    raise NotBuilt("WP70")


@router.post("/actions/{action_id}/abort", responses=ERRORS)
def abort(action_id: int, account: CurrentAccount, flow: Flow) -> ModelActionView:
    """While thinking: ``aborted``; the model's late answer is dropped. A running
    chain stops before its next step and becomes ``limited`` with its last
    complete result adoptable (P4, WP75)."""
    return flow.abort(account, action_id)


@router.patch("/actions/{action_id}/plan", responses=ERRORS)
def edit_plan(action_id: int, body: PlanEdit, account: CurrentAccount) -> ModelActionView:
    raise NotBuilt("WP75")


@router.post("/actions/{action_id}/run", status_code=202, responses=CALLS_MODEL)
def run(action_id: int, account: CurrentAccount) -> ModelActionView:
    raise NotBuilt("WP75")


@router.post("/actions/{action_id}/adopt", responses=ERRORS)
def adopt(action_id: int, account: CurrentAccount) -> ExecuteResponse:
    """A ``done`` or ``limited`` chain's result becomes the analysis (design "Kette übernehmen")."""
    raise NotBuilt("WP75")


@router.post("/actions/{action_id}/compare", status_code=202, responses=CALLS_MODEL)
def compare(action_id: int, account: CurrentAccount) -> ModelActionView:
    """Ask again with the other approach (design M10.1): a new action with
    ``compare_of``, polled like any other."""
    raise NotBuilt("WP76")


@router.get("/actions/{action_id}/comparison", responses=ERRORS)
def comparison(action_id: int, account: CurrentAccount) -> Comparison:
    """Once both are done: the difference, by feature ids (design M10.2, M10.3)."""
    raise NotBuilt("WP76")


@router.get("/my-actions", responses=ERRORS)
def my_actions(
    account: CurrentAccount,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
) -> ModelActionPage:
    """The account's own entries (D4, design M16.3)."""
    raise NotBuilt("WP73")
