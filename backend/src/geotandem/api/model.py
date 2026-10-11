"""Modus B over HTTP: prompt, decide, run (plan E2.3-E2.6, section 6).

Frozen in WP62 with every route, its auth and its answer; each body answered
501 ``not_implemented`` until its WP filled it in.
WP65 built the prompt of the direct query, the record, ``decide`` and
``abort``; WP70 the enforcement: ``approve``, ``reject``, ``execute``,
``undo``, ``touched`` and the preview; WP75 the tool chain: its prompt, the
plan's edit, ``run`` and ``adopt``; WP76 the comparison (all in
``model/service.py``). Every route needs a signed-in account; a record of
another account is ``not_found`` (404, never 403), as for sessions, and
changing one is the owner's alone, administrators included.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query

from geotandem.api.auth import CurrentAccount, InteractiveAccount
from geotandem.api.errors import ErrorBody
from geotandem.api.routes import QuerySlot
from geotandem.api.state import AppState, get_state
from geotandem.model.schemas import (
    MAX_ID,
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

ActionId = Annotated[int, Path(ge=1, le=MAX_ID)]
"""A record's id in a path: one beyond a 64-bit integer is refused (422), never
sent to the database (review #38)."""

ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorBody} for status in (400, 404, 409, 422, 501)
}
CALLS_MODEL: dict[int | str, dict[str, Any]] = {
    **ERRORS,
    **{status: {"model": ErrorBody} for status in (429, 502, 503, 504)},
}
"""Routes that call the model: quota, the endpoint's failure, every model-call
slot taken, the endpoint's timeout (design M14)."""
RUNS: dict[int | str, dict[str, Any]] = {
    **ERRORS,
    **{status: {"model": ErrorBody} for status in (413, 503, 504)},
}
"""Routes that run the stored query: the result-size limit (``execute``), every
query slot taken, the query's time limit (as ``/api/query``)."""
DECISIONS: dict[int | str, dict[str, Any]] = {**ERRORS, 403: {"model": ErrorBody}}
"""Routes of the person's decision (F-6.2, section 2): ``approve``, ``reject``,
``decide``. An interactive session only (``session_required``), as for the
preview (P2): a program acting for the account, a model's or an MCP client's
token (E4), never approves, rejects or hands over (WP71)."""


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
    executes it (D2); one with an ``off`` class is a proposal the user applies
    by hand (D1). Closes the account's open record (WP70). One prompt of an
    account at a time (409 ``busy``); all model calls at once are bounded
    (503 ``busy``)."""
    return flow.prompt(account, body)


@router.get("/actions/{action_id}", responses=ERRORS)
def action(action_id: ActionId, account: CurrentAccount, flow: Flow) -> ModelActionView:
    """One own record, or any for an administrator (D4); polled while the model
    thinks (P7) and while a chain runs (P4)."""
    return flow.get(account, action_id)


@router.post(
    "/actions/{action_id}/preview",
    responses={**RUNS, 403: {"model": ErrorBody}},
    dependencies=[QuerySlot],
)
def preview(action_id: ActionId, account: InteractiveAccount, flow: Flow) -> ActionPreview:
    """Count, the result layer's total and ids of the stored query, for the user
    only (P2): an interactive session (``session_required`` for any token), no
    class ``off`` (``class_not_allowed``), status unchanged. A ``POST``: it
    writes ``previewed_at``, so it is a change the origin check covers (review
    #39)."""
    return flow.preview(account, action_id)


@router.post("/actions/{action_id}/decide", responses=DECISIONS)
def decide(
    action_id: ActionId, body: DecideRequest, account: InteractiveAccount, flow: Flow
) -> ModelActionView:
    """Applied by hand or edited and applied through Modus A (P1, D2); the
    owner's alone. ``adjusted`` names the query the user applied, logged only;
    ``proposal_only`` only for a proposal with an ``off`` class (section 2)."""
    return flow.decide(account, action_id, body)


@router.post("/actions/{action_id}/approve", responses=DECISIONS)
def approve(action_id: ActionId, account: InteractiveAccount, flow: Flow) -> ModelActionView:
    """Refused with ``class_not_allowed`` when a class is ``off`` at the level as
    it was (D1, D2, M7.3); only ``proposed``."""
    return flow.approve(account, action_id)


@router.post("/actions/{action_id}/reject", responses=DECISIONS)
def reject(
    action_id: ActionId, body: RejectRequest, account: InteractiveAccount, flow: Flow
) -> ModelActionView:
    """Only ``proposed``; with the optional reason chip (design M5.3)."""
    return flow.reject(account, action_id, body)


@router.post("/actions/{action_id}/execute", responses=RUNS, dependencies=[QuerySlot])
def execute(action_id: ActionId, account: CurrentAccount, flow: Flow) -> ExecuteResponse:
    """Run the stored query, never a sent one (the route takes no body); only
    ``approved``, by the user or by an ``auto`` cell (D2): else ``not_approved``,
    and ``already_decided`` once it ran. The one answer with rows."""
    return flow.execute(account, action_id)


@router.post("/actions/{action_id}/undo", responses=ERRORS)
def undo(action_id: ActionId, account: CurrentAccount, flow: Flow) -> ModelActionView:
    """For the log: the client restores the analysis itself (D2). Only the
    account's last change made by the model, and ``undo_blocked`` once a hand
    edit after it was reported (``touched``)."""
    return flow.undo(account, action_id)


@router.post("/actions/{action_id}/touched", responses=ERRORS)
def touched(action_id: ActionId, account: CurrentAccount, flow: Flow) -> ModelActionView:
    """The analysis was changed by hand after this applied action: undo is over
    (design rule 7). Reporting it again changes nothing."""
    return flow.touched(account, action_id)


@router.post("/actions/{action_id}/abort", responses=ERRORS)
def abort(action_id: ActionId, account: CurrentAccount, flow: Flow) -> ModelActionView:
    """While thinking: ``aborted``; the model's late answer is dropped. A running
    chain stops before its next step and becomes ``limited`` with its last
    complete result adoptable (P4, WP75)."""
    return flow.abort(account, action_id)


@router.patch("/actions/{action_id}/plan", responses=DECISIONS)
def edit_plan(
    action_id: ActionId, body: PlanEdit, account: InteractiveAccount, flow: Flow
) -> ModelActionView:
    """Change values and remove steps of a chain that waits for approval and has
    not started; never add one (design M8.3). The plan is checked whole again
    and governed by the level as it was; 422 names the step a refusal is
    about. The person's edit: an interactive session only, as ``approve``."""
    return flow.edit_plan(account, action_id, body)


@router.post("/actions/{action_id}/run", status_code=202, responses=CALLS_MODEL)
def run(action_id: ActionId, account: CurrentAccount, flow: Flow) -> ModelActionView:
    """Start an ``approved`` chain, or let it go on after a halt (P4): 202 with
    the record ``running``; the client polls ``GET /actions/{id}``. The steps
    run one at a time as the caller's background task, among the model calls
    (409/503 ``busy``); the record halts for approval where the level as it
    was asks for it."""
    return flow.run(account, action_id)


@router.post(
    "/actions/{action_id}/adopt",
    responses={**RUNS, 403: {"model": ErrorBody}},
    dependencies=[QuerySlot],
)
def adopt(action_id: ActionId, account: InteractiveAccount, flow: Flow) -> ExecuteResponse:
    """A ``done`` or ``limited`` chain's result becomes the analysis (design
    "Kette übernehmen"): its last complete step as one query object, run as
    the caller like ``execute``; the other answer with rows. Once only. The
    person's decision (``accepted``): an interactive session only."""
    return flow.adopt(account, action_id)


@router.post("/actions/{action_id}/compare", status_code=202, responses=CALLS_MODEL)
def compare(action_id: ActionId, account: CurrentAccount, flow: Flow) -> ModelActionView:
    """Ask again with the other approach (design M10.1): a new action with
    ``compare_of``, polled like any other. A prompt, so as ``/prompt``: the
    account's level and connection now, its request limit, one at a time
    (409/503 ``busy``). Only an own record with a result to compare, never a
    repeat (``repeat_of_repeat``); it stays open beside the repeat, which
    waits ``proposed`` whatever the level."""
    return flow.compare(account, action_id)


@router.post(
    "/actions/{action_id}/comparison",
    responses={**RUNS, 403: {"model": ErrorBody}},
    dependencies=[QuerySlot],
)
def comparison(action_id: ActionId, account: InteractiveAccount, flow: Flow) -> Comparison:
    """Once both have a result (else 409): both stamps and the difference by
    feature ids, with names (design M10.2, M10.3), computed from both stored
    queries run as the caller; the model is not asked. Feature ids and names
    for the person, as the preview's ids (P2): an interactive session only,
    and a side that waits gets ``previewed_at``; so a ``POST``, a change the
    origin check covers, as the preview (review #41). The reason is data (which
    layer, which conditions), worded by the interface. Addressed by either
    side: the repeat, or the record compared (its newest repeat with a
    result). 409 ``not_approved`` while a side may still get a result,
    ``nothing_to_compare`` once it ended without one."""
    return flow.comparison(account, action_id)


@router.get("/my-actions", responses=ERRORS)
def my_actions(
    account: CurrentAccount,
    flow: Flow,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
) -> ModelActionPage:
    """The account's own entries, newest first (D4, design M16.3); an
    administrator's too, the log of all is ``/api/admin/model-actions``."""
    return flow.store.list_actions(account, offset=offset, limit=limit, own=True)
