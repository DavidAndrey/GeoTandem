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
from collections.abc import Callable, Collection, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import ColumnElement, Engine, case, func, select, update
from sqlalchemy.orm import Session

from geotandem import audit
from geotandem.auth.accounts import Account
from geotandem.connections import ConnectionInfo
from geotandem.db.orm import ModelAction
from geotandem.db.spatialite import reading
from geotandem.engine import ResultStamp
from geotandem.levels import Level
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
    StopReason,
)
from geotandem_query import QueryObject

EDGES: Mapping[str, frozenset[ActionStatus]] = {
    "thinking": frozenset({"refused", "answered", "proposed", "approved", "aborted", "failed"}),
    "proposed": frozenset({"approved", "rejected", "superseded", "applied"}),
    "approved": frozenset({"applied", "running", "superseded"}),
    "running": frozenset({"done", "limited"}),
    "done": frozenset({"applied", "superseded"}),
    "limited": frozenset({"applied", "superseded"}),
    "applied": frozenset({"undone"}),
}
"""The state diagram of plan 1.2: from a status, the statuses it may move to.
A status without an entry is final."""

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


class ActionError(Exception):
    """A rule about action records was violated; ``code`` is stable for the UI."""

    def __init__(self, status: int, code: str, message: str, /, **details: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


@dataclass(frozen=True)
class NewAction:
    """What the record keeps of a request when it is sent, as it was then (H7)."""

    prompt: str
    approach: Approach
    level: LevelSnapshot
    connection: ConnectionSnapshot
    profile_hash: str
    parent_action_id: int | None = None
    reference: Reference = "none"
    compare_of: int | None = None


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


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _json(model: Any) -> Any:
    return None if model is None else model.model_dump(mode="json", by_alias=True)


def to_view(row: ModelAction) -> ModelActionView:
    """The record as its owner or an administrator sees it; never rows (D10)."""
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
            "applied_by_hand": row.applied_by_hand,
            "undone_at": row.undone_at,
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
            "error": row.error,
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
        hits=row.stamp["count"] if row.stamp else None,
    )


def _admin(caller: Account) -> bool:
    return caller.role == "admin"


def _not_found(action_id: int) -> ActionError:
    return ActionError(404, "not_found", f"No model action {action_id}.", id=action_id)


def _wrong_state(row: ModelAction, step: str) -> ActionError:
    """An edge the diagram does not have: decided already, or not there yet."""
    if row.decision is not None or row.status not in EDGES:
        return ActionError(
            409,
            "already_decided",
            f"Model action {row.id} is decided already ({row.status}).",
            id=row.id,
            status=row.status,
            decision=row.decision,
        )
    return ActionError(
        409,
        "not_approved",
        f"Model action {row.id} is {row.status}; '{step}' does not apply.",
        id=row.id,
        status=row.status,
    )


def _nothing_to_undo(row: ModelAction, why: str) -> ActionError:
    return ActionError(
        409,
        "nothing_to_undo",
        f"Model action {row.id} cannot be undone: {why}.",
        id=row.id,
        status=row.status,
        decision=row.decision,
    )


def _supersede_decision(row: ModelAction) -> Decision:
    """A proposal with ``off`` parts stays ``proposal_only`` when overtaken (section 2)."""
    governance = row.governance or {}
    return "proposal_only" if governance.get("off") else "superseded"


Change = Callable[[ModelAction], dict[str, Any]]


@dataclass(frozen=True)
class ModelActionStore:
    engine: Engine
    clock: Callable[[], datetime] = _now
    """Naive UTC, as ``CURRENT_TIMESTAMP`` writes ``created_at``."""

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

    def get(self, caller: Account, action_id: int) -> ModelActionView:
        with Session(reading(self.engine)) as db:
            return to_view(self._visible(db, caller, action_id))

    @staticmethod
    def _where(caller: Account, filters: ActionFilters) -> list[ColumnElement[bool]]:
        where: list[ColumnElement[bool]] = []
        if not _admin(caller):
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
    ) -> ModelActionPage:
        """Newest first; a user's list holds their own records only (D4)."""
        if offset < 0 or not 1 <= limit <= MAX_PAGE:
            raise ValueError(f"offset >= 0 and 1 <= limit <= {MAX_PAGE}")
        where = self._where(caller, filters)
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

    def create(self, caller: Account, new: NewAction, *, supersede: bool = True) -> ModelActionView:
        """A new record, ``thinking`` (P7). With ``supersede`` the account's open
        record is closed in the same transaction (WP70); a comparison (``compare_of``)
        passes ``False``, it waits beside the action it repeats."""
        decided: list[ModelAction] = []
        with Session(self.engine, expire_on_commit=False) as db, db.begin():
            if supersede:
                decided = self._supersede(db, caller)
            for linked in (new.parent_action_id, new.compare_of):
                if linked is not None:
                    self._own(db, caller, linked)
            row = ModelAction(
                user_id=caller.id,
                account=caller.username,
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
        self._audit(caller, decided)
        return to_view(row)

    # --- superseding ---------------------------------------------------------------

    def _supersede(self, db: Session, caller: Account) -> list[ModelAction]:
        rows = db.scalars(
            select(ModelAction).where(
                ModelAction.user_id == caller.id, ModelAction.status.in_(OPEN)
            )
        ).all()
        closed = []
        for row in rows:
            moved = self._compare_and_set(
                db,
                row,
                {
                    "status": "superseded",
                    "decision": _supersede_decision(row),
                    "decided_at": self.clock(),
                },
            )
            if moved:
                closed.append(row)
        return closed

    def supersede_open(self, caller: Account) -> list[int]:
        """Close the account's open records as a new prompt overtakes them: decision
        ``superseded``, or ``proposal_only`` when a class was ``off`` (WP70)."""
        with Session(self.engine, expire_on_commit=False) as db, db.begin():
            closed = self._supersede(db, caller)
        self._audit(caller, closed)
        return [row.id for row in closed]

    # --- the edges of the diagram -----------------------------------------------------

    @staticmethod
    def _compare_and_set(db: Session, row: ModelAction, values: dict[str, Any]) -> bool:
        """Write ``values`` only if the record is still where it was read."""
        result = db.connection().execute(
            update(ModelAction)
            .where(ModelAction.id == row.id, ModelAction.status == row.status)
            .values(**values)
        )
        db.refresh(row)
        return result.rowcount == 1

    def _move(
        self,
        caller: Account,
        action_id: int,
        step: str,
        sources: Collection[str],
        change: Change,
        refuse: Callable[[ModelAction, str], ActionError] = _wrong_state,
    ) -> ModelActionView:
        """One edge: check the status, apply ``change``, stamp a decision's time."""
        with Session(self.engine, expire_on_commit=False) as db, db.begin():
            row = self._own(db, caller, action_id)
            if row.status not in sources:
                raise refuse(row, step)
            before = row.status
            values = change(row)
            target = values.get("status", before)
            assert target == before or target in EDGES[before], (before, target)
            if "decision" in values:
                assert values["decision"] in DECIDED[target], (target, values["decision"])
                values["decided_at"] = self.clock()
            if not self._compare_and_set(db, row, values):
                # Another change came first; report the state it left.
                raise refuse(row, step)
        if "decision" in values:
            self._audit(caller, [row])
        return to_view(row)

    @staticmethod
    def _audit(caller: Account, rows: Iterable[ModelAction]) -> None:
        for row in rows:
            audit.event(
                "model_action_decided",
                username=caller.username,
                action_id=row.id,
                status=row.status,
                decision=row.decision,
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
                "answer": _json(answer),
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
    ) -> ModelActionView:
        """A query or a plan the application accepted: ``approved`` without a
        question when the governing cell is ``auto``, else ``proposed`` (D2)."""
        status: ActionStatus = "approved" if governance.cell == "auto" else "proposed"
        return self._move(
            caller,
            action_id,
            "propose",
            ["thinking"],
            lambda _: {
                "status": status,
                "answer": _json(answer),
                "query": _json(query),
                "governance": _json(governance),
                "latency_ms": latency_ms,
            },
        )

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
        """Never with an ``off`` class at the level as it was (D2, M7.3)."""

        def change(row: ModelAction) -> dict[str, Any]:
            off = (row.governance or {}).get("off") or []
            if off:
                raise ActionError(
                    409,
                    "class_not_allowed",
                    f"The level of model action {row.id} does not allow '{off[0]}'.",
                    id=row.id,
                    part=off[0],
                    op_class=off[0],
                    level=row.level_name,
                )
            return {"status": "approved"}

        return self._move(caller, action_id, "approve", ["proposed"], change)

    def reject(
        self, caller: Account, action_id: int, reason: RejectReason | None = None
    ) -> ModelActionView:
        return self._move(
            caller,
            action_id,
            "reject",
            ["proposed"],
            lambda _: {"status": "rejected", "decision": "rejected", "reject_reason": reason},
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
        Modus A; ``applied_query`` is the user's, logged, never run here."""
        return self._move(
            caller,
            action_id,
            "decide",
            ["proposed"],
            lambda _: {
                "status": "applied",
                "decision": decision,
                "applied_by_hand": applied_by_hand,
                "applied_query": _json(applied_query),
            },
        )

    # from approved

    def execute(self, caller: Account, action_id: int, stamp: ResultStamp) -> ModelActionView:
        """The stored query ran (D2): ``auto`` when nobody was asked, else ``accepted``."""

        def change(row: ModelAction) -> dict[str, Any]:
            auto = (row.governance or {}).get("cell") == "auto"
            return {
                "status": "applied",
                "decision": "auto" if auto else "accepted",
                "stamp": _json(stamp),
            }

        return self._move(caller, action_id, "execute", ["approved"], change)

    def run(self, caller: Account, action_id: int) -> ModelActionView:
        """A chain starts its steps (P4)."""
        return self._move(caller, action_id, "run", ["approved"], lambda _: {"status": "running"})

    # from running

    def finish(
        self, caller: Account, action_id: int, stamp: ResultStamp | None = None
    ) -> ModelActionView:
        return self._move(
            caller,
            action_id,
            "finish",
            ["running"],
            lambda _: {"status": "done", "stamp": _json(stamp)},
        )

    def stop(
        self,
        caller: Account,
        action_id: int,
        reason: StopReason,
        stamp: ResultStamp | None = None,
    ) -> ModelActionView:
        """A limit, an abort or a restart; the last complete result stays adoptable (P4)."""
        return self._move(
            caller,
            action_id,
            "stop",
            ["running"],
            lambda _: {"status": "limited", "stop_reason": reason, "stamp": _json(stamp)},
        )

    # from done or limited

    def adopt(self, caller: Account, action_id: int, stamp: ResultStamp) -> ModelActionView:
        return self._move(
            caller,
            action_id,
            "adopt",
            ["done", "limited"],
            lambda _: {"status": "applied", "decision": "accepted", "stamp": _json(stamp)},
        )

    # from applied

    def undo(self, caller: Account, action_id: int) -> ModelActionView:
        """For the log only (D2): the decision stays, ``undone_at`` is set. Only a
        change the model made is taken back, and only once."""

        def change(row: ModelAction) -> dict[str, Any]:
            if row.decision not in UNDOABLE:
                raise _nothing_to_undo(row, "it was applied by the user, not by the model")
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

    def mark_previewed(self, caller: Account, action_id: int) -> ModelActionView:
        """The user's preview ran (P2); the log shows it, the status stays."""
        return self._move(
            caller,
            action_id,
            "preview",
            ["proposed", "approved"],
            lambda _: {"previewed_at": self.clock()},
        )
