"""The action record in the data core (plan E2.3-E2.6, 1.2 and section 2; WP63).

One row per model request: the proposal and its log entry at once (D2,
F-6.8). Every change of state is one edge of the state diagram in plan 1.2,
written as a compare-and-set on the status the change was checked against,
so of two changes at once exactly one wins and the other finds the record
moved on. A decision is written once, together with the status that ends
the action, and never changed after: only ``undone_at`` follows it.

Who sees what (D4): every method takes the caller. Users read their own
records, administrators all; a record of another account is ``not_found``,
never "forbidden", so its id tells nothing. Changes are the owner's alone,
administrators included: an administrator reads another account's proposal
but does not decide it.

Logs carry ids and codes only, never prompt or answer text (C15).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Collection, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import ColumnElement, Engine, case, delete, func, select, update
from sqlalchemy.orm import Session, object_session

from geotandem import audit
from geotandem.auth.accounts import Account
from geotandem.connections import ConnectionInfo
from geotandem.db.orm import ModelAction, ModelActionStep
from geotandem.db.spatialite import reading
from geotandem.engine import ResultStamp
from geotandem.levels import CellMode, Level, OpClass
from geotandem.model.chain.plan import one_approval
from geotandem.model.chain.view import restored
from geotandem.model.errors import ActionError
from geotandem.model.schemas import (
    MAX_PAGE,
    ActionStatus,
    Approach,
    CannotAnswer,
    Clarification,
    ConnectionSnapshot,
    Decision,
    Governance,
    KeyFigures,
    LevelSnapshot,
    ModelActionPage,
    ModelActionSummary,
    ModelActionView,
    NotCounted,
    PlanAnswer,
    QueryAnswer,
    Reference,
    Refusal,
    RejectReason,
    StepStatus,
    StepView,
    StopReason,
)
from geotandem_query import QueryObject, compact

EDGES: Mapping[str, frozenset[ActionStatus]] = {
    "thinking": frozenset({"refused", "answered", "proposed", "approved", "aborted", "failed"}),
    "proposed": frozenset({"approved", "rejected", "superseded", "applied", "limited"}),
    "approved": frozenset({"applied", "running", "superseded", "limited"}),
    "running": frozenset({"done", "limited", "proposed"}),
    "done": frozenset({"applied", "superseded"}),
    "limited": frozenset({"applied", "superseded"}),
    "applied": frozenset({"undone"}),
}
"""The state diagram of plan 1.2: from a status, the statuses it may move to.
A status without an entry is final. A chain halts for approval before a step
or after a re-plan (``running`` → ``proposed``, P4) and may be aborted while
it waits, halted or approved at a halt and not run again (``proposed``,
``approved`` → ``limited``)."""

RAN: frozenset[str] = frozenset({"ok", "empty", "error"})
"""Step statuses of a step that ran."""
COMPLETE: frozenset[str] = frozenset({"ok", "empty"})
"""Step statuses of a step whose result stands (P4)."""
AHEAD: frozenset[str] = frozenset({"planned", "waiting"})
"""Step statuses of a step still to run."""

OPEN: tuple[ActionStatus, ...] = ("proposed", "approved", "done", "limited")
"""Waiting for the user; a new prompt of the account supersedes them (WP70)."""

DECIDED: Mapping[str, frozenset[Decision]] = {
    "applied": frozenset({"accepted", "adjusted", "auto", "proposal_only"}),
    "rejected": frozenset({"rejected"}),
    "superseded": frozenset({"superseded", "proposal_only"}),
    "undone": frozenset({"accepted", "auto"}),
    "aborted": frozenset({"aborted"}),
    "failed": frozenset({"failed"}),
}
"""The decisions a status can carry. Every other status carries none: open,
or (``refused``, ``answered``) ended without anything to decide (section 2)."""

MAX_RAW_QUERY_BYTES = 64 * 1024
"""The most of a refused answer's raw query a record keeps, as canonical JSON
(UTF-8); a larger one is kept as ``{"omitted": "too large"}`` (review #35)."""

UNDOABLE: frozenset[Decision] = frozenset({"accepted", "auto"})
"""What undo takes back: a change the model made, never the user's own (D2)."""

COUNTED: tuple[Decision, ...] = (
    "accepted",
    "adjusted",
    "rejected",
    "superseded",
    "auto",
    "proposal_only",
)
"""The decisions of a proposal; ``aborted`` and ``failed`` are counted apart."""

AnyAnswer = QueryAnswer | Clarification | CannotAnswer | PlanAnswer


@dataclass(frozen=True)
class NewAction:
    """What the record keeps of a request when it is sent, as it was then (H7)."""

    prompt: str
    approach: Approach
    level: LevelSnapshot
    connection: ConnectionSnapshot
    profile_hash: str
    parent_action_id: int | None = None
    level_prompt: str | None = None
    """The level's system prompt, whose hash ``level`` keeps: a chain's re-plan
    asks with it (H7, WP75)."""
    reference: Reference = "none"
    compare_of: int | None = None
    proposal_only: bool = False
    """The model may only propose: the user applies by hand, an overtaken record
    ends ``proposal_only``, never ``superseded``, and an ``auto`` answer still
    waits as a proposal. Set by the caller: in E2.3 for every record (P1), later
    where the level says so; an answer with an ``off`` class sets it too (D1)."""


@dataclass(frozen=True)
class ChainStep:
    """A step of a chain as the record keeps it (WP75): what the model planned
    (or the user changed: ``edited``), its query object and classes, the cell
    of the level as it was, and what became of it. ``view`` is the step's
    ``model_view`` as stored; only ``chain.view`` turns it into one again."""

    position: int
    text: str
    tool: str
    arguments: dict[str, Any]
    query: QueryObject
    classes: frozenset[OpClass]
    cell: CellMode
    status: StepStatus = "planned"
    revised: bool = False
    edited: bool = False
    approved: bool = False
    """An approval cleared it: the run does not halt before it."""
    count: int | None = None
    view: dict[str, Any] | None = None
    duration_ms: int | None = None

    @property
    def ahead(self) -> bool:
        return self.status in AHEAD


@dataclass(frozen=True)
class Chain:
    """A chain's record as its run reads it."""

    view: ModelActionView
    steps: list[ChainStep]
    """By position, the removed and failed ones included."""
    run_ms: int
    """Its run time so far, halts left out (P4)."""
    turns: list[Any]
    """Its conversation after the prompt, ``[role, text]`` each, a re-plan's
    input with the hash of the profile it was asked with; empty before a re-plan."""
    level_prompt: str
    """The level's system prompt as it was when asked."""


def _chain_step(row: ModelActionStep) -> ChainStep:
    return ChainStep(
        position=row.position,
        text=row.text,
        tool=row.tool,
        arguments=row.arguments,
        query=QueryObject.model_validate(row.query),
        classes=frozenset(OpClass(c) for c in row.classes),
        cell=CellMode(row.cell),
        status=row.status,  # type: ignore[arg-type]  # written from StepStatus only
        revised=row.revised,
        edited=row.edited,
        approved=row.approved,
        count=row.count,
        view=row.model_view,
        duration_ms=row.duration_ms,
    )


def _step_row(action_id: int, step: ChainStep) -> ModelActionStep:
    seen = step.view
    return ModelActionStep(
        action_id=action_id,
        position=step.position,
        text=step.text,
        tool=step.tool,
        arguments=step.arguments,
        classes=[c.value for c in OpClass if c in step.classes],
        cell=step.cell.value,
        status=step.status,
        revised=step.revised,
        edited=step.edited,
        approved=step.approved,
        count=step.count,
        model_view=seen,
        query=compact(step.query),
        duration_ms=step.duration_ms,
    )


def _step_view(row: ModelActionStep) -> StepView:
    """A stored step as the user sees it; the model sees its ``model_view`` only."""
    seen = restored(row.model_view)
    return StepView(
        position=row.position,
        text=row.text,
        tool=row.tool,
        arguments=row.arguments,
        classes=[OpClass(c) for c in row.classes],
        cell=CellMode(row.cell),
        status=row.status,
        revised=row.revised,
        hits=row.count,
        stamp=None if row.stamp is None else ResultStamp.model_validate(row.stamp),
        query=QueryObject.model_validate(row.query),
        model_view=seen,
        duration_ms=row.duration_ms,
    )


def _steps_of(db: Session, action_id: int) -> list[ModelActionStep]:
    stmt = select(ModelActionStep).where(ModelActionStep.action_id == action_id)
    return list(db.scalars(stmt.order_by(ModelActionStep.position)))


def _set_step(db: Session, action_id: int, position: int, **values: Any) -> None:
    db.execute(
        update(ModelActionStep)
        .where(ModelActionStep.action_id == action_id, ModelActionStep.position == position)
        .values(**values)
    )


def _started(db: Session, action_id: int) -> bool:
    """A step of the chain ran, or runs."""
    found = db.scalar(
        select(ModelActionStep.id)
        .where(
            ModelActionStep.action_id == action_id,
            ModelActionStep.status.in_([*RAN, "running", "skipped"]),
        )
        .limit(1)
    )
    return found is not None


def _skip_ahead(db: Session, action_id: int) -> None:
    """The run ended: what did not run, or did not finish, never will."""
    db.execute(
        update(ModelActionStep)
        .where(
            ModelActionStep.action_id == action_id,
            ModelActionStep.status.in_([*AHEAD, "running"]),
        )
        .values(status="skipped")
    )


def _end_steps(db: Session, row: ModelAction) -> None:
    """A chain decided without running on (rejected, superseded, handed over):
    its steps ahead never run."""
    if row.approach == "chain":
        _skip_ahead(db, row.id)


def last_complete(steps: Iterable[ChainStep], max_features: int) -> ChainStep | None:
    """What a chain that ended offers to adopt (WP75, decision 11), the one rule
    for the run's end, an abort, an expiry and the start-up check: the last
    step whose result stands (``ok``, ``empty``) and that is no buffer (D3),
    and only while its count is within the result-size limit, so the record
    never offers a result that ``adopt`` refuses with ``result_too_large``."""
    complete = [s for s in steps if s.status in COMPLETE and s.query.buffer is None]
    if not complete or (complete[-1].count or 0) > max_features:
        return None
    return complete[-1]


@dataclass(frozen=True)
class ActionFilters:
    """Period (``since`` inclusive, ``until`` exclusive), level, connection,
    approach, account (design M16.1)."""

    since: datetime | None = None
    until: datetime | None = None
    level_id: int | None = None
    connection_id: int | None = None
    approach: Approach | None = None
    account: str | None = None


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def level_snapshot(level: Level) -> LevelSnapshot:
    """The level as a record keeps it: its matrix and the hash of its system prompt."""
    if level.id is None:
        raise ValueError("only a stored level can be snapshotted")
    return LevelSnapshot(
        id=level.id,
        name=level.name,
        matrix=dict(level.matrix),
        prompt_hash=text_hash(level.system_prompt),
    )


def connection_snapshot(info: ConnectionInfo) -> ConnectionSnapshot:
    return ConnectionSnapshot(
        id=info.id, name=info.name, model=info.model, host=info.host, locality=info.locality
    )


def utc_now() -> datetime:
    """Naive UTC, as every time the record holds (the project's convention)."""
    return datetime.now(UTC).replace(tzinfo=None)


def _json(model: Any) -> Any:
    return None if model is None else model.model_dump(mode="json", by_alias=True)


def _bounded(answer: AnyAnswer | None) -> Any:
    """A refused answer as the record keeps it (design M3): its raw query only up
    to ``MAX_RAW_QUERY_BYTES`` of canonical JSON (review #35). Everything else
    of an answer is bounded by its schema."""
    data = _json(answer)
    if isinstance(data, dict) and isinstance(data.get("query"), dict):
        text = json.dumps(data["query"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        if len(text.encode()) > MAX_RAW_QUERY_BYTES:
            data["query"] = {"omitted": "too large"}
    return data


def _query_json(query: QueryObject | None) -> dict[str, Any] | None:
    """A query as the editor writes it (``compact``), as every view returns it."""
    return None if query is None else compact(query)


SHOWN: frozenset[str] = frozenset(
    {"time_limit", "result_too_large", "step_limit", "connection_not_available"}
)
"""Codes of a chain's stop whose ``details`` the user sees, as they name no
cause: a limit's numbers (``{step, value, max}``, design M9.5), and why a
re-plan was not sent (``reason``)."""


def _error_for(error: dict[str, Any] | None, detail: bool) -> dict[str, Any] | None:
    """A failure as a view carries it: code and message, and its ``details``
    (the transport's ``cause``, what did not parse) only for ``detail``, the
    administrator's log (D4, review #37); a chain's stop with what it shows (``SHOWN``)."""
    if error is None or detail or error.get("code") in SHOWN:
        return error
    return {"code": error.get("code"), "message": error.get("message"), "details": {}}


def to_view(
    row: ModelAction, *, detail: bool = False, steps: Iterable[ModelActionStep] = ()
) -> ModelActionView:
    """The record as its owner or an administrator sees it; never rows (D10).
    ``detail``: the administrator's log entry (design M16.2), with a failure's
    technical details; every other view has its code and message only.
    ``steps``: a chain's, as the store reads them with the record (``_view``)."""
    return ModelActionView.model_validate(
        {
            "id": row.id,
            "account": row.account,
            "created_at": row.created_at,
            "decided_at": row.decided_at,
            "prompt": row.prompt,
            "approach": row.approach,
            "status": row.status,
            "decision": row.decision,
            "reject_reason": row.reject_reason,
            "proposal_only": row.proposal_only,
            "applied_by_hand": row.applied_by_hand,
            "undone_at": row.undone_at,
            "touched_at": row.touched_at,
            "previewed_at": row.previewed_at,
            "parent_action_id": row.parent_action_id,
            "reference": row.reference,
            "compare_of": row.compare_of,
            "level": {
                "id": row.level_id,
                "name": row.level_name,
                "matrix": row.level_matrix,
                "prompt_hash": row.level_prompt_hash,
            },
            "connection": {
                "id": row.connection_id,
                "name": row.connection_name,
                "model": row.connection_model,
                "host": row.connection_host,
                "locality": row.connection_locality,
            },
            "profile_hash": row.profile_hash,
            "prompt_hash": row.prompt_hash,
            "answer": row.answer,
            "query": row.query,
            "applied_query": row.applied_query,
            "governance": row.governance,
            "refusal": row.refusal,
            "error": _error_for(row.error, detail),
            "steps": [_step_view(step) for step in steps],
            "replans": row.replans,
            "stop_reason": row.stop_reason,
            "stamp": row.stamp,
            "latency_ms": row.latency_ms,
        }
    )


def _summary(row: ModelAction) -> ModelActionSummary:
    return ModelActionSummary(
        id=row.id,
        account=row.account,
        created_at=row.created_at,
        prompt=row.prompt,
        approach=row.approach,
        level_name=row.level_name,
        connection_name=row.connection_name,
        locality=row.connection_locality,
        status=row.status,
        decision=row.decision,
        reject_reason=row.reject_reason,
        refusal_code=(row.refusal or {}).get("code"),
        hits=row.stamp["count"] if row.stamp else None,
    )


def _admin(caller: Account) -> bool:
    return caller.role == "admin"


def _not_found(action_id: int) -> ActionError:
    return ActionError("not_found", f"No model action {action_id}.", http_status=404, id=action_id)


def _wrong_state(row: ModelAction, step: str) -> ActionError:
    """An edge the diagram does not have: decided already, or not there yet."""
    if row.decision is not None or row.status not in EDGES:
        return ActionError(
            "already_decided",
            f"Model action {row.id} is decided already ({row.status}).",
            http_status=409,
            id=row.id,
            status=row.status,
            decision=row.decision,
        )
    return ActionError(
        "not_approved",
        f"Model action {row.id} is {row.status}; '{step}' does not apply.",
        http_status=409,
        id=row.id,
        status=row.status,
    )


def _not_a_chain(row: ModelAction, step: str = "plan") -> ActionError:
    return ActionError(
        "not_approved",
        f"Model action {row.id} is no tool chain; '{step}' does not apply.",
        http_status=409,
        id=row.id,
        status=row.status,
    )


def _a_chain(row: ModelAction, step: str) -> ActionError:
    return ActionError(
        "not_approved",
        f"Model action {row.id} is a tool chain: it runs its steps ('run') and its "
        f"result is adopted ('adopt'); '{step}' does not apply.",
        http_status=409,
        id=row.id,
        status=row.status,
    )


def _nothing_to_undo(row: ModelAction, why: str) -> ActionError:
    return ActionError(
        "nothing_to_undo",
        f"Model action {row.id} cannot be undone: {why}.",
        http_status=409,
        id=row.id,
        status=row.status,
        decision=row.decision,
    )


def _undo_blocked(row: ModelAction) -> ActionError:
    return ActionError(
        "undo_blocked",
        f"Model action {row.id} cannot be undone: the analysis was changed by hand after it.",
        http_status=409,
        id=row.id,
        touched_at=row.touched_at.isoformat() if row.touched_at else None,
    )


def _allowed(row: ModelAction) -> None:
    """Refuse when a class of the answer is ``off`` at the level as it was (D1, M7.3):
    the stored governance, written with the stored query from its ``classify``
    at the snapshotted level, never the account's level now."""
    off = (row.governance or {}).get("off") or []
    if off:
        raise ActionError(
            "class_not_allowed",
            f"The level of model action {row.id} does not allow '{off[0]}'.",
            http_status=409,
            id=row.id,
            part=off[0],
            op_class=off[0],
            level=row.level_name,
        )


def _answered_at(row: ModelAction) -> datetime:
    """When the model's answer arrived: the call's start plus its latency. Never
    before ``created_at``; without a recorded call, ``created_at``."""
    start = max(row.created_at, row.called_at or row.created_at)
    return start + timedelta(milliseconds=row.latency_ms or 0)


def _cell(row: ModelAction) -> str | None:
    """The cell that governed the answer, if there was one."""
    cell = (row.governance or {}).get("cell")
    return str(cell) if cell is not None else None


def _unasked(row: ModelAction) -> bool:
    """An answer that arrived ``approved`` without a question (D2): its cell
    ``auto``, no proposal-only, and no repeat (``compare_of``, WP76), which
    always waits for the person, who compares before anything applies."""
    return _cell(row) == "auto" and not row.proposal_only and row.compare_of is None


def _superseded(row: ModelAction, now: datetime) -> dict[str, Any]:
    """A proposal-only record stays ``proposal_only`` when overtaken (section 2)."""
    decision: Decision = "proposal_only" if row.proposal_only else "superseded"
    return {"status": "superseded", "decision": decision, "decided_at": now}


Change = Callable[[ModelAction], dict[str, Any]]


@dataclass(frozen=True)
class ModelActionStore:
    engine: Engine
    clock: Callable[[], datetime] = utc_now
    """Every time the record holds comes from here, naive UTC (the project's
    convention), never from the database's clock and its time zone."""

    # --- reading -------------------------------------------------------------------

    def _visible(self, db: Session, caller: Account, action_id: int) -> ModelAction:
        row = db.get(ModelAction, action_id)
        if row is None or not (_admin(caller) or row.user_id == caller.id):
            raise _not_found(action_id)
        return row

    @staticmethod
    def _own(db: Session, caller: Account, action_id: int) -> ModelAction:
        row = db.get(ModelAction, action_id)
        if row is None or row.user_id != caller.id:
            raise _not_found(action_id)
        return row

    @staticmethod
    def _view(db: Session, row: ModelAction, *, detail: bool = False) -> ModelActionView:
        """``to_view`` with a chain's steps, read in ``db``."""
        steps = _steps_of(db, row.id) if row.approach == "chain" else []
        return to_view(row, detail=detail, steps=steps)

    def get(self, caller: Account, action_id: int, *, detail: bool = False) -> ModelActionView:
        """``detail``: the administrator's log entry (``to_view``)."""
        with Session(reading(self.engine)) as db:
            row = self._visible(db, caller, action_id)
            return self._view(db, row, detail=detail and _admin(caller))

    def ready(
        self, caller: Account, action_id: int, step: str, sources: Collection[str]
    ) -> ModelActionView:
        """The caller's own record, when ``step`` may follow from its status and no
        class is ``off`` (D1); changes nothing. What ``execute``, the preview,
        ``run`` and ``adopt`` check before anything runs, so a refused step runs
        no query and no model; the step itself checks again as it is written
        (compare-and-set)."""
        with Session(reading(self.engine)) as db:
            row = self._own(db, caller, action_id)
            if row.status not in sources:
                raise _wrong_state(row, step)
            _allowed(row)
            return self._view(db, row)

    def chain(self, caller: Account, action_id: int, step: str = "plan") -> Chain:
        """The caller's own chain with its steps as the run and the plan's edit
        need them (WP75); any other record is ``not_found``, one that is no
        chain ``not_approved``."""
        with Session(reading(self.engine)) as db:
            row = self._own(db, caller, action_id)
            if row.approach != "chain":
                raise _not_a_chain(row, step)
            steps = _steps_of(db, row.id)
            return Chain(
                view=to_view(row, steps=steps),
                steps=[_chain_step(s) for s in steps],
                run_ms=row.run_ms,
                turns=list(row.turns or []),
                level_prompt=row.level_prompt or "",
            )

    def thread(self, caller: Account, action_id: int, depth: int) -> list[ModelActionView]:
        """The caller's record ``action_id`` and its parents, at most ``depth``,
        oldest first: what a follow-up builds its turns from (P6). Another
        account's record is ``not_found``; the chain ends at the first parent
        that is not the caller's (an account deleted meanwhile)."""
        found: list[ModelActionView] = []
        with Session(reading(self.engine)) as db:
            row: ModelAction | None = self._own(db, caller, action_id)
            while row is not None and len(found) < depth:
                found.append(to_view(row))
                parent = row.parent_action_id
                row = db.get(ModelAction, parent) if parent is not None else None
                if row is not None and row.user_id != caller.id:
                    row = None
        return found[::-1]

    def compared(self, caller: Account, action_id: int) -> tuple[ModelActionView, ModelActionView]:
        """The two sides of a comparison (design M10), the caller's own: named by
        the repeat, its ``compare_of`` and itself; named by the record compared,
        it and its newest repeat with a result (else its newest repeat).
        Another account's record, or one without a comparison, is
        ``not_found``; a side with an ``off`` class is refused as the preview
        refuses it (D1, P2). Changes nothing."""
        with Session(reading(self.engine)) as db:
            row = self._own(db, caller, action_id)
            if row.compare_of is not None:
                left, right = self._own(db, caller, row.compare_of), row
            else:
                repeats = db.scalars(
                    select(ModelAction)
                    .where(ModelAction.user_id == caller.id, ModelAction.compare_of == row.id)
                    .order_by(ModelAction.id.desc())
                ).all()
                # The newest repeat with a result; else the newest, to say why not.
                with_result = (r for r in repeats if r.query is not None)
                repeat = next(with_result, repeats[0] if repeats else None)
                if repeat is None:
                    raise ActionError(
                        "not_found",
                        f"Model action {action_id} has not been compared.",
                        http_status=404,
                        id=action_id,
                    )
                left, right = row, repeat
            for side in (left, right):
                _allowed(side)
            return self._view(db, left), self._view(db, right)

    @staticmethod
    def _where(
        caller: Account, filters: ActionFilters, own: bool = False
    ) -> list[ColumnElement[bool]]:
        where: list[ColumnElement[bool]] = []
        if own or not _admin(caller):
            where.append(ModelAction.user_id == caller.id)
        if filters.since is not None:
            where.append(ModelAction.created_at >= filters.since)
        if filters.until is not None:
            where.append(ModelAction.created_at < filters.until)
        if filters.level_id is not None:
            where.append(ModelAction.level_id == filters.level_id)
        if filters.connection_id is not None:
            where.append(ModelAction.connection_id == filters.connection_id)
        if filters.approach is not None:
            where.append(ModelAction.approach == filters.approach)
        if filters.account is not None:
            where.append(ModelAction.account == filters.account)
        return where

    def list_actions(
        self,
        caller: Account,
        filters: ActionFilters = ActionFilters(),  # noqa: B008 - frozen
        *,
        offset: int = 0,
        limit: int = 50,
        own: bool = False,
    ) -> ModelActionPage:
        """Newest first; a user's list holds their own records only (D4). With
        ``own`` an administrator's list does too ("Meine Modellaktionen", M16.3)."""
        if offset < 0 or not 1 <= limit <= MAX_PAGE:
            raise ValueError(f"offset >= 0 and 1 <= limit <= {MAX_PAGE}")
        where = self._where(caller, filters, own)
        with Session(reading(self.engine)) as db:
            total = db.scalar(select(func.count()).select_from(ModelAction).where(*where))
            rows = db.scalars(
                select(ModelAction)
                .where(*where)
                .order_by(ModelAction.created_at.desc(), ModelAction.id.desc())
                .offset(offset)
                .limit(limit)
            )
            return ModelActionPage(items=[_summary(row) for row in rows], total=total or 0)

    def count(
        self,
        caller: Account,
        filters: ActionFilters = ActionFilters(),  # noqa: B008 - frozen
    ) -> int:
        """How many records the filters hold for the caller (D4)."""
        stmt = select(func.count()).select_from(ModelAction).where(*self._where(caller, filters))
        with Session(reading(self.engine)) as db:
            return db.scalar(stmt) or 0

    def export(
        self,
        caller: Account,
        filters: ActionFilters = ActionFilters(),  # noqa: B008 - frozen
        *,
        limit: int | None = None,
        chunk: int = 500,
    ) -> Iterator[ModelActionView]:
        """Every record of the filters as a full view, newest first, at most
        ``limit``, for the CSV of the log (WP73); the same visibility as the list
        (D4). Read ``chunk`` records at a time, each chunk in a session of its own
        that is closed before its records are handed on (keyset paging on time
        and id), so a slow reader of the CSV holds no database session."""
        where = self._where(caller, filters)
        newest_first = (ModelAction.created_at.desc(), ModelAction.id.desc())
        after: tuple[datetime, int] | None = None
        left = limit
        while left is None or left > 0:
            size = chunk if left is None else min(chunk, left)
            stmt = select(ModelAction).where(*where)
            if after is not None:
                at, last = after
                stmt = stmt.where(
                    (ModelAction.created_at < at)
                    | ((ModelAction.created_at == at) & (ModelAction.id < last))
                )
            with Session(reading(self.engine)) as db:
                views = [
                    to_view(row) for row in db.scalars(stmt.order_by(*newest_first).limit(size))
                ]
            yield from views
            if len(views) < size:
                return
            after = (views[-1].created_at, views[-1].id)
            if left is not None:
                left -= len(views)

    def key_figures(
        self,
        caller: Account,
        filters: ActionFilters = ActionFilters(),  # noqa: B008 - frozen
    ) -> KeyFigures:
        """Plan section 2 in one aggregation over the action table, no extra store."""
        decision, status = ModelAction.decision, ModelAction.status
        undone = ModelAction.undone_at.is_not(None)

        def count(condition: ColumnElement[bool]) -> Any:
            return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)

        columns: dict[str, Any] = {
            "proposals": count(decision.in_(COUNTED)),
            **{name: count(decision == name) for name in COUNTED},
            "undone": count((decision == "auto") & undone),
            "undone_after_approval": count((decision == "accepted") & undone),
            "refused": count(status == "refused"),
            "aborted": count(decision == "aborted"),
            "failed": count(decision == "failed"),
        }
        stmt = select(*(c.label(name) for name, c in columns.items())).where(
            *self._where(caller, filters)
        )
        with Session(reading(self.engine)) as db:
            n = {name: int(value) for name, value in db.execute(stmt).one()._mapping.items()}
        decided = n["accepted"] + n["adjusted"] + n["rejected"] + n["superseded"]
        rate = round((n["accepted"] + n["adjusted"]) / decided, 4) if decided else None
        return KeyFigures(
            proposals=n["proposals"],
            accepted=n["accepted"],
            adjusted=n["adjusted"],
            rejected=n["rejected"],
            superseded=n["superseded"],
            proposal_only=n["proposal_only"],
            auto=n["auto"],
            undone=n["undone"],
            undone_after_approval=n["undone_after_approval"],
            acceptance_rate=rate,
            not_counted=NotCounted(refused=n["refused"], aborted=n["aborted"], failed=n["failed"]),
        )

    # --- creating ------------------------------------------------------------------

    def create(
        self,
        caller: Account,
        new: NewAction,
        *,
        supersede: bool = True,
        admit: Callable[[Session], None] | None = None,
    ) -> ModelActionView:
        """A new record, ``thinking`` (P7). With ``supersede`` the account's open
        record is closed in the same transaction (WP70); a comparison (``compare_of``)
        passes ``False``, it waits beside the action it repeats. ``admit`` runs
        first in that transaction and refuses by raising (the prompt flow's
        request limit and one request at a time, WP65)."""
        decided: list[ModelAction] = []
        with Session(self.engine, expire_on_commit=False) as db, db.begin():
            if admit is not None:
                admit(db)
            if supersede:
                decided = self._supersede(db, caller)
            for linked in (new.parent_action_id, new.compare_of):
                if linked is not None:
                    self._own(db, caller, linked)
            row = ModelAction(
                user_id=caller.id,
                account=caller.username,
                created_at=self.clock(),
                proposal_only=new.proposal_only,
                prompt=new.prompt,
                prompt_hash=text_hash(new.prompt),
                approach=new.approach,
                status="thinking",
                parent_action_id=new.parent_action_id,
                reference=new.reference,
                compare_of=new.compare_of,
                level_id=new.level.id,
                level_name=new.level.name,
                level_matrix={str(k): str(v) for k, v in new.level.matrix.items()},
                level_prompt_hash=new.level.prompt_hash,
                level_prompt=new.level_prompt,
                connection_id=new.connection.id,
                connection_name=new.connection.name,
                connection_model=new.connection.model,
                connection_host=new.connection.host,
                connection_locality=new.connection.locality,
                profile_hash=new.profile_hash,
            )
            db.add(row)
            db.flush()
            db.refresh(row)
        self._audit(caller.username, decided)
        return to_view(row)

    # --- superseding ---------------------------------------------------------------

    def _supersede(self, db: Session, caller: Account) -> list[ModelAction]:
        rows = db.scalars(
            select(ModelAction).where(
                ModelAction.user_id == caller.id, ModelAction.status.in_(OPEN)
            )
        ).all()
        now = self.clock()
        closed = [row for row in rows if self._settle(db, row, OPEN, lambda r: _superseded(r, now))]
        for row in closed:
            _end_steps(db, row)
        return closed

    def supersede_open(self, caller: Account) -> list[int]:
        """Close the account's open records as a new prompt overtakes them: decision
        ``superseded``, or ``proposal_only`` for a proposal-only record (WP70)."""
        with Session(self.engine, expire_on_commit=False) as db, db.begin():
            closed = self._supersede(db, caller)
        self._audit(caller.username, closed)
        return [row.id for row in closed]

    # --- the system's own path -----------------------------------------------------

    def close_stale(self, older_than: datetime, max_features: int) -> list[int]:
        """Close what no request will finish any more, for the start-up check (P4,
        P7, WP70, WP82); no caller, every account. The application is one process,
        so nothing in flight survives a restart: every ``thinking`` record ends
        ``failed`` (the model's answer is lost) and every ``running`` one
        ``limited``/``interrupted`` with its last complete result adoptable,
        whatever their age. An ``auto`` answer never executed (``approved``, cell
        ``auto``) that arrived before ``older_than`` is ``superseded``; one that
        arrived later may still have its window open. The record keeps no
        arrival time of its own: it is the call's start (``called_at``, else
        ``created_at``) plus the call's ``latency_ms`` (``_answered_at``). A
        record the user approved stays approved. ``max_features``: the
        result-size limit a chain's result to adopt keeps (``last_complete``)."""
        now = self.clock()
        error = {
            "code": "llm_timeout",
            "message": "No answer arrived before the application stopped waiting.",
            "details": {},
        }

        def change(row: ModelAction) -> dict[str, Any]:
            if row.status == "thinking":
                return {"status": "failed", "decision": "failed", "decided_at": now, "error": error}
            if row.status == "running":
                # Its last complete result, unstamped: nothing here can run it,
                # and adopt runs it as the user anyway (WP75).
                db = object_session(row)
                assert db is not None
                steps = [_chain_step(s) for s in _steps_of(db, row.id)]
                last = last_complete(steps, max_features)
                return {
                    "status": "limited",
                    "stop_reason": row.stop_reason or "interrupted",  # an abort asked for stays
                    "query": None if last is None else compact(last.query),
                    "stamp": None,
                }
            return _superseded(row, now)

        stale = ("thinking", "running", "approved")
        with Session(self.engine, expire_on_commit=False) as db, db.begin():
            rows = db.scalars(
                select(ModelAction).where(
                    ModelAction.status.in_(("thinking", "running"))
                    | ((ModelAction.status == "approved") & (ModelAction.created_at < older_than))
                )
            ).all()
            closed = []
            for row in rows:
                if row.status == "approved" and not (
                    _unasked(row) and _answered_at(row) < older_than
                ):
                    continue
                if self._settle(db, row, stale, change):
                    closed.append(row)
                    _end_steps(db, row)
        self._audit(None, [row for row in closed if row.decision is not None])
        return [row.id for row in closed]

    def fail_thinking(
        self, caller: Account, older_than: datetime, error: Mapping[str, Any]
    ) -> list[int]:
        """The caller's ``thinking`` records created before ``older_than`` end
        ``failed`` with ``error``: no model call will finish them any more, and
        each would hold the account's next prompt (the prompt flow, WP65)."""
        now = self.clock()
        with Session(self.engine, expire_on_commit=False) as db, db.begin():
            rows = db.scalars(
                select(ModelAction).where(
                    ModelAction.user_id == caller.id,
                    ModelAction.status == "thinking",
                    ModelAction.created_at < older_than,
                )
            ).all()
            values = {"status": "failed", "decision": "failed", "decided_at": now, "error": error}
            closed = [row for row in rows if self._settle(db, row, ["thinking"], lambda _: values)]
        self._audit(caller.username, closed)
        return [row.id for row in closed]

    def mark_called(self, caller: Account, action_id: int) -> bool:
        """The model call of a ``thinking`` record starts now: from here it counts
        for the request limit (P5). ``False`` when it is no longer thinking
        (aborted): then the call must not start."""
        with Session(self.engine) as db, db.begin():
            done = db.connection().execute(
                update(ModelAction)
                .where(
                    ModelAction.id == action_id,
                    ModelAction.user_id == caller.id,
                    ModelAction.status == "thinking",
                )
                .values(called_at=self.clock())
            )
        return done.rowcount == 1

    # --- the edges of the diagram -----------------------------------------------------

    @staticmethod
    def _settle(db: Session, row: ModelAction, sources: Collection[str], change: Change) -> bool:
        """Apply ``change`` as a compare-and-set on the status it was computed from.
        When another change came first, decide again from the state it left: a step
        still allowed there is tried anew (statuses only move forward, so this ends)."""
        while row.status in sources:
            before = row.status
            values = change(row)
            target = values.get("status", before)
            assert target == before or target in EDGES[before], (before, target)
            if "decision" in values:
                assert values["decision"] in DECIDED[target], (target, values["decision"])
            result = db.connection().execute(
                update(ModelAction)
                .where(ModelAction.id == row.id, ModelAction.status == before)
                .values(**values)
            )
            db.refresh(row)
            if result.rowcount == 1:
                return True
        return False

    def _move(
        self,
        caller: Account,
        action_id: int,
        step: str,
        sources: Collection[str],
        change: Change,
        refuse: Callable[[ModelAction, str], ActionError] = _wrong_state,
        then: Callable[[Session, ModelAction], None] | None = None,
    ) -> ModelActionView:
        """One edge: check the status, apply ``change``, stamp a decision's time;
        ``then`` writes a chain's steps in the same transaction, once the edge
        is taken."""

        def stamped(row: ModelAction) -> dict[str, Any]:
            values = change(row)
            if "decision" in values:
                values["decided_at"] = self.clock()
            return values

        with Session(self.engine, expire_on_commit=False) as db, db.begin():
            row = self._own(db, caller, action_id)
            before = row.decision
            if not self._settle(db, row, sources, stamped):
                # Not allowed from here, or another change came first and left
                # a state this step does not apply to.
                raise refuse(row, step)
            if then is not None:
                then(db, row)
            view = self._view(db, row)
        if row.decision != before:
            self._audit(caller.username, [row])
        return view

    @staticmethod
    def _audit(actor: str | None, rows: Iterable[ModelAction]) -> None:
        """``actor`` ``None``: the application itself (the start-up check)."""
        for row in rows:
            # A failure's code and cause, which the user's view leaves out (#37);
            # the cause names no prompt or answer text (C13, C15).
            error = row.error or {}
            failure = (
                {"code": error.get("code"), "cause": (error.get("details") or {}).get("cause")}
                if error
                else {}
            )
            audit.event(
                "model_action_decided",
                username=actor or "system",
                action_id=row.id,
                status=row.status,
                decision=row.decision,
                **failure,
            )

    # from thinking (P7)

    def refuse(
        self,
        caller: Account,
        action_id: int,
        refusal: Refusal,
        *,
        answer: AnyAnswer | None = None,
        latency_ms: int | None = None,
    ) -> ModelActionView:
        """The application refused the answer (D1, D3); the answer stays for
        inspection (design M3). Not a decision."""
        return self._move(
            caller,
            action_id,
            "refuse",
            ["thinking"],
            lambda _: {
                "status": "refused",
                "refusal": _json(refusal),
                "answer": _bounded(answer),
                "latency_ms": latency_ms,
            },
        )

    def answer(
        self,
        caller: Account,
        action_id: int,
        answer: Clarification | CannotAnswer,
        *,
        latency_ms: int | None = None,
    ) -> ModelActionView:
        """A clarification or a cannot-answer: nothing proposed, nothing to decide."""
        return self._move(
            caller,
            action_id,
            "answer",
            ["thinking"],
            lambda _: {"status": "answered", "answer": _json(answer), "latency_ms": latency_ms},
        )

    def propose(
        self,
        caller: Account,
        action_id: int,
        answer: QueryAnswer | PlanAnswer,
        *,
        query: QueryObject | None,
        governance: Governance,
        latency_ms: int | None = None,
        steps: Sequence[ChainStep] = (),
    ) -> ModelActionView:
        """A query or a plan the application accepted: ``approved`` without a
        question when the governing cell is ``auto``, else ``proposed`` (D2). A
        proposal-only record, an answer with an ``off`` class, or a repeat of
        another record (``compare_of``, WP76) is ``proposed``.
        A plan's ``steps`` are stored with it; a chain keeps no ``query`` until
        its run ended (``finish``, ``stop``)."""

        def change(row: ModelAction) -> dict[str, Any]:
            only = row.proposal_only or bool(governance.off)
            # A repeat (WP76) waits for the person: it is compared first.
            auto = governance.cell == "auto" and not only and row.compare_of is None
            status: ActionStatus = "approved" if auto else "proposed"
            return {
                "status": status,
                "proposal_only": only,
                "answer": _json(answer),
                "query": _query_json(query),
                "governance": _json(governance),
                "latency_ms": latency_ms,
                "turns": None,
            }

        def then(db: Session, row: ModelAction) -> None:
            db.add_all(_step_row(row.id, step) for step in steps)
            db.flush()

        return self._move(caller, action_id, "propose", ["thinking"], change, then=then)

    def abort(self, caller: Account, action_id: int) -> ModelActionView:
        """The user cancelled while the model thought (M2.1)."""
        return self._move(
            caller,
            action_id,
            "abort",
            ["thinking"],
            lambda _: {"status": "aborted", "decision": "aborted"},
        )

    def fail(self, caller: Account, action_id: int, error: dict[str, Any]) -> ModelActionView:
        """A model or limit error, ``{code, message, details}`` (design M14)."""
        return self._move(
            caller,
            action_id,
            "fail",
            ["thinking"],
            lambda _: {"status": "failed", "decision": "failed", "error": error},
        )

    # from proposed

    def approve(self, caller: Account, action_id: int) -> ModelActionView:
        """Never with an ``off`` class at the level as it was (D2, M7.3). A
        chain's approval clears steps ahead (P4, design M8), decided over the
        whole plan as it stands (every step not removed, the ones that ran and
        a re-plan's included, with their cells at the level as it was): when no
        step of it is ``auto`` (*Prüfen*), one approval covers every step
        ahead; otherwise (*Teilautonom*) it clears the next step only, and the
        run halts before every further step whose cell is ``approve``."""

        def change(row: ModelAction) -> dict[str, Any]:
            _allowed(row)
            return {"status": "approved"}

        def then(db: Session, row: ModelAction) -> None:
            steps = _steps_of(db, row.id)
            whole = one_approval(CellMode(s.cell) for s in steps if s.status != "removed")
            ahead = [s for s in steps if s.status in AHEAD]
            for step in ahead if whole else ahead[:1]:
                _set_step(db, row.id, step.position, approved=True, status="planned")

        return self._move(caller, action_id, "approve", ["proposed"], change, then=then)

    def reject(
        self, caller: Account, action_id: int, reason: RejectReason | None = None
    ) -> ModelActionView:
        return self._move(
            caller,
            action_id,
            "reject",
            ["proposed"],
            lambda _: {"status": "rejected", "decision": "rejected", "reject_reason": reason},
            then=_end_steps,
        )

    def decide(
        self,
        caller: Account,
        action_id: int,
        decision: Literal["proposal_only", "adjusted"],
        *,
        applied_by_hand: bool = False,
        applied_query: QueryObject | None = None,
    ) -> ModelActionView:
        """The hand-over (P1, D2): applied by hand, or edited and applied through
        Modus A; ``applied_query`` is the user's, logged, never run here. An
        adjusted query went through the editor, so it was not applied by hand,
        and it names what the user applied; a proposal applied as proposed has no
        query of the user's."""
        if decision == "adjusted" and applied_by_hand:
            raise ActionError(
                "bad_request",
                "An adjusted query is applied through the editor, not by hand.",
                decision=decision,
            )
        if (decision == "adjusted") != (applied_query is not None):
            raise ActionError(
                "bad_request",
                "An adjusted decision, and only that, names the query the user applied.",
                decision=decision,
            )

        def change(row: ModelAction) -> dict[str, Any]:
            if decision == "proposal_only" and not row.proposal_only:
                # Section 2: a level with an ``off`` part only. One that waits for
                # approval is approved, rejected or adjusted (WP71, security review #29).
                raise ActionError(
                    "not_approved",
                    f"Model action {row.id} waits for approval: 'proposal_only' is for a "
                    "proposal whose level has an 'off' part.",
                    http_status=409,
                    id=row.id,
                    status=row.status,
                )
            return {
                "status": "applied",
                "decision": decision,
                "applied_by_hand": applied_by_hand,
                "applied_query": _query_json(applied_query),
            }

        return self._move(caller, action_id, "decide", ["proposed"], change, then=_end_steps)

    # from approved

    def execute(self, caller: Account, action_id: int, stamp: ResultStamp) -> ModelActionView:
        """The stored query ran (D2): ``auto`` when nobody was asked, else ``accepted``."""

        def change(row: ModelAction) -> dict[str, Any]:
            _allowed(row)  # never approved so (propose, approve); held here as well
            if row.approach == "chain":
                # A chain runs its steps and adopts its result (WP75): its
                # approval may cover the next step only.
                raise _a_chain(row, "execute")
            # Arrived approved, nobody was asked: exactly the auto answers (propose).
            return {
                "status": "applied",
                "decision": "auto" if _unasked(row) else "accepted",
                "stamp": _json(stamp),
            }

        return self._move(caller, action_id, "execute", ["approved"], change)

    def run(self, caller: Account, action_id: int) -> ModelActionView:
        """A chain starts its steps, or goes on after a halt (P4)."""

        def change(row: ModelAction) -> dict[str, Any]:
            _allowed(row)  # never approved so (approve); held here as well
            cleared: dict[str, Any] = dict.fromkeys(("error", "stop_reason"))
            return {"status": "running"} | cleared

        return self._move(caller, action_id, "run", ["approved"], change)

    # a chain's plan, before it runs (design M8.3)

    def edit_plan(
        self,
        caller: Account,
        action_id: int,
        steps: Sequence[ChainStep],
        governance: Governance,
    ) -> ModelActionView:
        """The user's edit of a proposed chain that has not started: ``steps`` are
        all of its steps as they now are (values changed, ``removed``), checked
        whole by the caller, and ``governance`` theirs (D1, union of the steps'
        classes). Never a step more: a position the plan does not have is
        refused. An approval given before cannot carry over: only a ``proposed``
        chain is edited, and its steps lose any clearance."""

        def change(row: ModelAction) -> dict[str, Any]:
            if row.approach != "chain":
                raise _not_a_chain(row)
            _allowed(row)  # a proposal-only plan is the user's to apply by hand (D1)
            db = object_session(row)
            assert db is not None
            if _started(db, row.id):
                raise ActionError(
                    "not_approved",
                    f"Model action {row.id} has started; its plan stays as it ran.",
                    http_status=409,
                    id=row.id,
                    status=row.status,
                )
            stored = {s.position for s in _steps_of(db, row.id)}
            if {s.position for s in steps} != stored:
                raise ActionError(
                    "invalid_query",
                    f"An edit of model action {row.id} names every step of its plan, no other.",
                    http_status=422,
                    id=row.id,
                )
            if governance.off:  # values only and removals: no class can come in
                raise ActionError(
                    "class_not_allowed",
                    f"The level of model action {row.id} does not allow '{governance.off[0]}'.",
                    http_status=409,
                    id=row.id,
                    part=governance.off[0],
                )
            return {"governance": _json(governance)}

        def then(db: Session, row: ModelAction) -> None:
            for step in steps:
                _set_step(
                    db,
                    row.id,
                    step.position,
                    arguments=step.arguments,
                    query=compact(step.query),
                    classes=[c.value for c in OpClass if c in step.classes],
                    cell=step.cell.value,
                    status=step.status,
                    edited=step.edited,
                    approved=False,
                )

        return self._move(caller, action_id, "plan", ["proposed"], change, then=then)

    # a chain's run (P4)

    def _running(
        self,
        caller: Account,
        action_id: int,
        step: str,
        values: dict[str, Any],
        then: Callable[[Session, ModelAction], None] | None = None,
    ) -> ModelActionView:
        """A write of the run while it runs; another change first (the start-up
        check, an expiry) leaves it ``not_approved`` and the run stops."""
        return self._move(caller, action_id, step, ["running"], lambda _: dict(values), then=then)

    def _going_on(
        self,
        caller: Account,
        action_id: int,
        step: str,
        values: dict[str, Any],
        then: Callable[[Session, ModelAction], None],
    ) -> ModelActionView:
        """A write that takes the run further (a step starts, a re-plan's steps
        come in): refused, ``not_approved``, once the user aborted it (P4: no
        step starts after the abort was answered), in the same compare-and-set."""

        def change(row: ModelAction) -> dict[str, Any]:
            if row.stop_reason == "aborted":
                raise _wrong_state(row, step)
            return dict(values)

        return self._move(caller, action_id, step, ["running"], change, then=then)

    def step_started(
        self, caller: Account, action_id: int, position: int, *, run_ms: int
    ) -> ModelActionView:
        def then(db: Session, row: ModelAction) -> None:
            _set_step(db, row.id, position, status="running")

        return self._going_on(caller, action_id, "step", {"run_ms": run_ms}, then)

    def step_ran(
        self,
        caller: Account,
        action_id: int,
        position: int,
        *,
        status: StepStatus,
        count: int | None,
        view: dict[str, Any],
        duration_ms: int,
        run_ms: int,
    ) -> ModelActionView:
        """What became of a step: the count for the user, ``model_view`` for the model."""

        def then(db: Session, row: ModelAction) -> None:
            seen = view
            _set_step(
                db,
                row.id,
                position,
                status=status,
                count=count,
                model_view=seen,
                duration_ms=duration_ms,
            )

        return self._running(caller, action_id, "step", {"run_ms": run_ms}, then)

    def revise(
        self,
        caller: Account,
        action_id: int,
        *,
        after: int,
        steps: Sequence[ChainStep],
        governance: Governance,
        replans: int,
        turns: list[Any],
        run_ms: int,
    ) -> ModelActionView:
        """A re-plan's steps replace those that did not run after position
        ``after`` (P4): the steps that ran stay, the new ones are ``revised``."""

        def then(db: Session, row: ModelAction) -> None:
            db.execute(
                delete(ModelActionStep).where(
                    ModelActionStep.action_id == row.id,
                    ModelActionStep.position > after,
                    ModelActionStep.status.in_([*AHEAD, "removed"]),
                )
            )
            db.add_all(_step_row(row.id, replace(s, revised=True)) for s in steps)
            db.flush()

        values = {
            "governance": _json(governance),
            "replans": replans,
            "turns": turns,
            "run_ms": run_ms,
        }
        return self._going_on(caller, action_id, "revise", values, then)

    def halt(
        self,
        caller: Account,
        action_id: int,
        *,
        waiting: int | None,
        run_ms: int,
        replans: int | None = None,
        turns: list[Any] | None = None,
    ) -> ModelActionView:
        """The run waits for approval (P4, design M9.2): before step ``waiting``,
        or, ``None``, after a re-plan the level wants approved as a whole."""

        def change(row: ModelAction) -> dict[str, Any]:
            if row.stop_reason == "aborted":
                raise _wrong_state(row, "halt")  # the user aborted meanwhile: the run stops
            values: dict[str, Any] = {"status": "proposed", "run_ms": run_ms}
            if replans is not None:
                values |= {"replans": replans, "turns": turns}
            return values

        def then(db: Session, row: ModelAction) -> None:
            if waiting is not None:
                _set_step(db, row.id, waiting, status="waiting")

        return self._move(caller, action_id, "halt", ["running"], change, then=then)

    def request_stop(self, caller: Account, action_id: int) -> ModelActionView:
        """The user aborts a running chain: the step that runs ends, no other
        starts (P4); the run stops ``limited``/``aborted`` at its next step."""
        return self._running(caller, action_id, "abort", {"stop_reason": "aborted"})

    def finish(
        self,
        caller: Account,
        action_id: int,
        stamp: ResultStamp | None = None,
        *,
        result: ChainStep | None = None,
        run_ms: int | None = None,
    ) -> ModelActionView:
        """The last step ran: its result (``result``, stamped) waits to be adopted."""
        return self._ended(
            caller, action_id, "finish", ["running"], {"status": "done"}, stamp, result, run_ms
        )

    def stop(
        self,
        caller: Account,
        action_id: int,
        reason: StopReason,
        stamp: ResultStamp | None = None,
        *,
        result: ChainStep | None = None,
        error: dict[str, Any] | None = None,
        run_ms: int | None = None,
        replans: int | None = None,
        turns: list[Any] | None = None,
    ) -> ModelActionView:
        """A limit, an abort, a re-plan that brought nothing (P4): ``limited``,
        the last complete result (``result``, stamped) adoptable. Also a chain
        that started and waits, halted for approval (``proposed``) or approved
        at a halt and not run again (``approved``), when it is aborted."""
        values: dict[str, Any] = {"status": "limited", "stop_reason": reason, "error": error}
        if replans is not None:
            values |= {"replans": replans, "turns": turns}

        def halted(row: ModelAction) -> bool:
            db = object_session(row)
            assert db is not None
            return reason == "aborted" and row.approach == "chain" and _started(db, row.id)

        def change(row: ModelAction) -> dict[str, Any]:
            if row.status != "running" and not halted(row):
                raise _wrong_state(row, "stop")
            return values

        sources = ["running", "proposed", "approved"]
        return self._ended(caller, action_id, "stop", sources, change, stamp, result, run_ms)

    def _ended(
        self,
        caller: Account,
        action_id: int,
        step: str,
        sources: Collection[str],
        values: dict[str, Any] | Change,
        stamp: ResultStamp | None,
        result: ChainStep | None,
        run_ms: int | None,
    ) -> ModelActionView:
        """The run ended: the steps ahead are ``skipped``; ``result`` is the
        record's query and carries the stamp, the only step that does."""

        def change(row: ModelAction) -> dict[str, Any]:
            found = values(row) if callable(values) else dict(values)
            found |= {
                "stamp": _json(stamp),
                "query": _query_json(None if result is None else result.query),
            }
            if found["status"] == "done":
                found["stop_reason"] = None  # an abort that came too late
            if run_ms is not None:
                found["run_ms"] = run_ms
            return found

        def then(db: Session, row: ModelAction) -> None:
            _skip_ahead(db, row.id)
            if result is not None and stamp is not None:
                _set_step(db, row.id, result.position, stamp=_json(stamp))

        return self._move(caller, action_id, step, sources, change, then=then)

    # from done or limited

    def adopt(self, caller: Account, action_id: int, stamp: ResultStamp) -> ModelActionView:
        """A chain's result became the analysis (design "Kette übernehmen"):
        ``accepted`` at every level, the user chose to adopt it; ``stamp`` is of
        the run as the user, which replaces the run's own."""

        def change(row: ModelAction) -> dict[str, Any]:
            _allowed(row)
            if row.query is None:
                raise ActionError(
                    "not_approved",
                    f"Model action {row.id} has no complete result to adopt.",
                    http_status=409,
                    id=row.id,
                    status=row.status,
                )
            return {"status": "applied", "decision": "accepted", "stamp": _json(stamp)}

        return self._move(caller, action_id, "adopt", ["done", "limited"], change)

    # from applied

    def undo(self, caller: Account, action_id: int) -> ModelActionView:
        """For the log only (D2): the decision stays, ``undone_at`` is set. Only the
        account's last change made by the model is taken back, and only once;
        never after the client reported a hand edit of the analysis (``touch``)."""

        def change(row: ModelAction) -> dict[str, Any]:
            if row.decision not in UNDOABLE:
                raise _nothing_to_undo(row, "it was applied by the user, not by the model")
            if row.touched_at is not None:
                raise _undo_blocked(row)
            db = object_session(row)
            assert db is not None
            latest = db.scalar(
                select(ModelAction.id)
                .where(
                    ModelAction.user_id == row.user_id,
                    ModelAction.status.in_(("applied", "undone")),
                    ModelAction.decision.in_(UNDOABLE),
                )
                .order_by(ModelAction.decided_at.desc(), ModelAction.id.desc())
                .limit(1)
            )
            if latest != row.id:
                raise _nothing_to_undo(row, f"a later model change ({latest}) came after it")
            return {"status": "undone", "undone_at": self.clock()}

        def refuse(row: ModelAction, step: str) -> ActionError:
            if row.status == "undone":
                return _wrong_state(row, step)
            return _nothing_to_undo(row, f"it changed nothing ({row.status})")

        view = self._move(caller, action_id, "undo", ["applied"], change, refuse)
        audit.event(
            "model_action_undone",
            username=caller.username,
            action_id=view.id,
            decision=view.decision,
        )
        return view

    # no change of status

    def touch(self, caller: Account, action_id: int) -> ModelActionView:
        """The client reports a hand edit of the analysis after this applied action
        (design rule 7): its undo is over (``undo_blocked``). The first report's
        time stays; a record that changed nothing is ``nothing_to_undo``."""

        def refuse(row: ModelAction, step: str) -> ActionError:
            return _nothing_to_undo(row, f"it is no applied change ({row.status})")

        return self._move(
            caller,
            action_id,
            "touched",
            ["applied"],
            lambda row: {"touched_at": row.touched_at or self.clock()},
            refuse,
        )

    def mark_previewed(self, caller: Account, action_id: int) -> ModelActionView:
        """The user's preview ran (P2); the log shows it, the status stays. Never
        for an answer with an ``off`` class: it has no preview (design M4.1)."""

        def change(row: ModelAction) -> dict[str, Any]:
            _allowed(row)
            return {"previewed_at": self.clock()}

        return self._move(caller, action_id, "preview", ["proposed", "approved"], change)
