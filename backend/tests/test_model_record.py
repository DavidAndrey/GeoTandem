"""The action record and its key figures (plan E2.3-E2.6, 1.2, section 2; WP63).

The state diagram holds for any order of steps, a decision is written once,
level and connection stay as they were, a record of another account does not
exist for the caller, a new prompt closes the open proposal, and the key
figures of the contract fixture come out of the table exactly.
"""

import json
import random
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, get_args

import pytest
from api_helpers import USER_PASSWORD, Events
from model_fixtures import case, fixture
from sqlalchemy import Engine, inspect, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from geotandem.auth import accounts
from geotandem.auth.accounts import Account
from geotandem.config import Settings
from geotandem.connections import ConnectionPatch, Connections, ConnectionWrite
from geotandem.db import migrate
from geotandem.db.bootstrap import bootstrap
from geotandem.db.engine import make_engine
from geotandem.db.orm import ModelAction
from geotandem.engine import ResultStamp
from geotandem.levels import CellMode, Level, OpClass, load_levels, save_levels
from geotandem.model.record import (
    ActionError,
    ActionFilters,
    ModelActionStore,
    NewAction,
    connection_snapshot,
    level_snapshot,
)
from geotandem.model.record.store import MAX_RAW_QUERY_BYTES
from geotandem.model.schemas import (
    ActionStatus,
    CannotAnswer,
    Clarification,
    ConnectionSnapshot,
    Governance,
    LevelSnapshot,
    ModelActionView,
    PlanAnswer,
    QueryAnswer,
    Refusal,
)
from geotandem.vault import Vault
from geotandem_query import QueryObject

LEVEL = LevelSnapshot(
    id=2, name="Prüfen", matrix={c: CellMode.APPROVE for c in OpClass}, prompt_hash="1" * 64
)
CONNECTION = ConnectionSnapshot(
    id=1, name="Lokal", model="qwen3:8b", host="127.0.0.1", locality="local"
)
PROMPT = "Primarschulen in Köniz mit mehr als 200 Schülern"
ANSWER = QueryAnswer.model_validate(case("reference")["answer"])
QUERY = QueryObject.model_validate(ANSWER.query)
PLAN = PlanAnswer.model_validate(case("chain_reference")["answer"])
CLARIFICATION = Clarification.model_validate(case("clarification")["answer"])
STAMP = ResultStamp(count=10, ids_hash="a" * 64, query_hash="b" * 64, data_versions={})
REFUSAL = Refusal(code="unknown_layer", message="Unknown layer.", details={"layer": "x"})
ILLEGAL = {
    "already_decided",
    "not_approved",
    "nothing_to_undo",
    "undo_blocked",
    "class_not_allowed",
}


def governance(cell: str, off: tuple[OpClass, ...] = ()) -> Governance:
    classes = [OpClass.QUERY, *off]
    return Governance(
        classes=classes,
        cell=CellMode(cell),
        needs_approval=[OpClass.QUERY] if cell == "approve" else [],
        off=list(off),
    )


APPROVE, AUTO, OFF = governance("approve"), governance("auto"), governance("off", (OpClass.DERIVE,))


@pytest.fixture
def engine(settings: Settings) -> Engine:
    return bootstrap(settings)


@pytest.fixture
def store(engine: Engine) -> ModelActionStore:
    return ModelActionStore(engine)


@pytest.fixture
def people(engine: Engine) -> dict[str, Account]:
    roles = {"anna": "user", "beat": "user", "admin": "admin"}
    return {
        name: accounts.create(engine, name, USER_PASSWORD, role) for name, role in roles.items()
    }


def new(
    store: ModelActionStore, who: Account, *, supersede: bool = True, **fields: Any
) -> ModelActionView:
    values: dict[str, Any] = {
        "prompt": PROMPT,
        "approach": "direct",
        "level": LEVEL,
        "connection": CONNECTION,
        "profile_hash": "p" * 64,
        **fields,
    }
    return store.create(who, NewAction(**values), supersede=supersede)


def proposed(
    store: ModelActionStore, who: Account, rule: Governance = APPROVE, **fields: Any
) -> int:
    action = new(store, who, **fields)
    answer = PLAN if fields.get("approach") == "chain" else ANSWER
    query = None if fields.get("approach") == "chain" else QUERY
    store.propose(who, action.id, answer, query=query, governance=rule, latency_ms=900)
    return action.id


# --- the migration --------------------------------------------------------------


def test_migration_up_and_down_keeps_connections_and_choices(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine, "0008")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO llm_connection (id, name, base_url, model, temperature,"
                " timeout_s, reasoning_effort, enabled, is_default, may_receive_data,"
                " marked_external) VALUES (1, 'Lokal', 'http://127.0.0.1:11434/v1', 'm',"
                " 0, 120, 'none', 1, 1, 1, 0)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO app_user (username, display_name, password_hash, role, status,"
                " must_change_password, llm_connection_id)"
                " VALUES ('anna', '', 'x', 'user', 'active', 0, 1)"
            )
        )

    migrate.upgrade(engine)

    found = inspect(engine)
    assert "model_action" in found.get_table_names()
    assert {i["name"] for i in found.get_indexes("model_action")} >= {
        "ix_model_action_user_id_created_at",
        "ix_model_action_decision_created_at",
        "ix_model_action_parent_action_id",
    }
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT llm_connection_id FROM app_user")) == 1
        limit = conn.execute(
            text("SELECT request_limit_enabled, request_limit_per_day FROM llm_connection")
        ).one()
    assert tuple(limit) == (0, None)

    migrate.downgrade(engine, "0008")

    assert "model_action" not in inspect(engine).get_table_names()
    columns = {c["name"] for c in inspect(engine).get_columns("llm_connection")}
    assert not {"request_limit_enabled", "request_limit_per_day"} & columns
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT llm_connection_id FROM app_user")) == 1
    migrate.upgrade(engine)


@pytest.mark.parametrize(
    ("enabled", "per_day", "ok"),
    [
        (False, None, True),
        (False, 0, True),
        (True, 50, True),
        (True, None, False),
        (True, 0, False),
    ],
)
def test_a_request_limit_that_is_on_needs_a_positive_number(
    engine: Engine, enabled: bool, per_day: int | None, ok: bool
) -> None:
    """P5: the switch and its threshold, held by the database too."""
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO llm_connection (id, name, base_url, model, temperature,"
                " timeout_s, reasoning_effort, enabled, is_default, may_receive_data,"
                " marked_external) VALUES (1, 'Lokal', 'http://127.0.0.1:11434/v1', 'm',"
                " 0, 120, 'none', 1, 1, 1, 0)"
            )
        )
    statement = text(
        "UPDATE llm_connection SET request_limit_enabled = :on, request_limit_per_day = :n"
    )
    if ok:
        with engine.begin() as conn:
            conn.execute(statement, {"on": enabled, "n": per_day})
    else:
        with pytest.raises(IntegrityError), engine.begin() as conn:
            conn.execute(statement, {"on": enabled, "n": per_day})


# --- the state diagram ----------------------------------------------------------

Step = Callable[[ModelActionStore, Account, int], object]

STEPS: dict[str, Step] = {
    "refuse": lambda s, a, i: s.refuse(a, i, REFUSAL, answer=ANSWER),
    "answer": lambda s, a, i: s.answer(a, i, CLARIFICATION),
    "propose": lambda s, a, i: s.propose(a, i, ANSWER, query=QUERY, governance=APPROVE),
    "propose_auto": lambda s, a, i: s.propose(a, i, ANSWER, query=QUERY, governance=AUTO),
    "propose_off": lambda s, a, i: s.propose(a, i, ANSWER, query=QUERY, governance=OFF),
    "propose_plan": lambda s, a, i: s.propose(a, i, PLAN, query=None, governance=APPROVE),
    "abort": lambda s, a, i: s.abort(a, i),
    "fail": lambda s, a, i: s.fail(a, i, {"code": "llm_timeout", "message": "-"}),
    "approve": lambda s, a, i: s.approve(a, i),
    "reject": lambda s, a, i: s.reject(a, i, "wrong_layer"),
    "by_hand": lambda s, a, i: s.decide(a, i, "proposal_only", applied_by_hand=True),
    "adjusted": lambda s, a, i: s.decide(a, i, "adjusted", applied_query=QUERY),
    "execute": lambda s, a, i: s.execute(a, i, STAMP),
    "run": lambda s, a, i: s.run(a, i),
    "finish": lambda s, a, i: s.finish(a, i, STAMP),
    "stop": lambda s, a, i: s.stop(a, i, "step_limit", STAMP),
    "adopt": lambda s, a, i: s.adopt(a, i, STAMP),
    "undo": lambda s, a, i: s.undo(a, i),
    "touched": lambda s, a, i: s.touch(a, i),
    "preview": lambda s, a, i: s.mark_previewed(a, i),
    "new_prompt": lambda s, a, i: s.supersede_open(a),
    "restart": lambda s, a, i: s.close_stale(datetime(2100, 1, 1)),
}

# Plan 1.2 and section 2, copied here on purpose: the store is checked against
# the plan, not against itself.
PLAN_EDGES: dict[str, set[str]] = {
    "thinking": {"refused", "answered", "proposed", "approved", "aborted", "failed"},
    "proposed": {"approved", "rejected", "superseded", "applied"},
    "approved": {"applied", "running", "superseded"},
    "running": {"done", "limited"},
    "done": {"applied", "superseded"},
    "limited": {"applied", "superseded"},
    "applied": {"undone"},
}
PLAN_DECISIONS: dict[str, set[str]] = {
    "applied": {"accepted", "adjusted", "auto", "proposal_only"},
    "rejected": {"rejected"},
    "superseded": {"superseded", "proposal_only"},
    "undone": {"accepted", "auto"},
    "aborted": {"aborted"},
    "failed": {"failed"},
}


def check(before: ModelActionView, after: ModelActionView) -> None:
    """What every step leaves true, legal or refused."""
    if after.status != before.status:
        assert after.status in PLAN_EDGES.get(before.status, set()), (before, after.status)
    if after.status in PLAN_DECISIONS:
        assert after.decision in PLAN_DECISIONS[after.status], (after.status, after.decision)
        assert after.decided_at is not None
    else:
        assert after.decision is None and after.decided_at is None, after.status
    if before.decision is not None:
        assert (after.decision, after.decided_at) == (before.decision, before.decided_at)
    assert (after.undone_at is not None) == (after.status == "undone")
    assert after.reject_reason is None or after.decision == "rejected"
    assert not after.applied_by_hand or after.decision == "proposal_only"
    if after.decision == "auto":
        assert after.governance is not None and after.governance.cell == "auto"


LIKELY: dict[str, list[str]] = {
    "thinking": ["refuse", "answer", "propose", "propose_auto", "propose_off", "propose_plan"],
    "proposed": ["approve", "reject", "by_hand", "adjusted", "preview", "new_prompt"],
    "approved": ["execute", "run", "run", "preview", "new_prompt"],
    "running": ["finish", "stop"],
    "done": ["adopt", "new_prompt"],
    "limited": ["adopt", "new_prompt"],
    "applied": ["undo", "undo", "touched"],
}
"""A hint for the walk only, so it gets deep into the diagram; the check does not
rely on it, and half of the steps are drawn from all of them."""


def test_no_order_of_steps_reaches_an_illegal_state(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna = people["anna"]
    rng = random.Random(63)
    reached: set[str] = set()
    names = sorted(STEPS)
    for _ in range(250):
        action = new(store, anna, proposal_only=rng.random() < 0.3)
        for _ in range(10):
            before = store.get(anna, action.id)
            likely = LIKELY.get(before.status)
            step = rng.choice(likely if likely and rng.random() < 0.5 else names)
            try:
                STEPS[step](store, anna, action.id)
            except ActionError as refused:
                assert (refused.status, refused.code) in {(409, c) for c in ILLEGAL}
                assert store.get(anna, action.id) == before, "a refused step changed the record"
            after = store.get(anna, action.id)
            check(before, after)
            reached.add(after.status)
    assert reached == set(get_args(ActionStatus))


def test_a_decision_is_set_once(store: ModelActionStore, people: dict[str, Account]) -> None:
    anna = people["anna"]
    action_id = proposed(store, anna)
    store.reject(anna, action_id, "misunderstood")
    for step in ("approve", "reject", "by_hand", "execute", "propose"):
        with pytest.raises(ActionError) as refused:
            STEPS[step](store, anna, action_id)
        assert refused.value.code == "already_decided"
        assert refused.value.details["status"] == "rejected"
    assert store.get(anna, action_id).reject_reason == "misunderstood"


def test_only_an_approved_action_executes(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna = people["anna"]
    action_id = proposed(store, anna)
    with pytest.raises(ActionError) as refused:
        store.execute(anna, action_id, STAMP)
    assert (refused.value.code, refused.value.details["status"]) == ("not_approved", "proposed")
    store.approve(anna, action_id)
    applied = store.execute(anna, action_id, STAMP)
    assert (applied.status, applied.decision, applied.stamp) == ("applied", "accepted", STAMP)
    with pytest.raises(ActionError) as replay:
        store.execute(anna, action_id, STAMP)
    assert replay.value.code == "already_decided"


def test_an_auto_answer_arrives_approved_and_executes_as_auto(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna = people["anna"]
    action_id = proposed(store, anna, AUTO)
    assert store.get(anna, action_id).status == "approved"
    assert store.execute(anna, action_id, STAMP).decision == "auto"


def test_approve_is_refused_with_an_off_class(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    """D2: an ``off`` part is for the user to apply by hand, never approved."""
    anna = people["anna"]
    action_id = proposed(store, anna, OFF)
    with pytest.raises(ActionError) as refused:
        store.approve(anna, action_id)
    assert refused.value.code == "class_not_allowed"
    assert refused.value.details["part"] == "derive"
    applied = store.decide(anna, action_id, "proposal_only", applied_by_hand=True)
    assert (applied.status, applied.decision, applied.applied_by_hand) == (
        "applied",
        "proposal_only",
        True,
    )


def test_undo_takes_back_only_what_the_model_changed(
    store: ModelActionStore, people: dict[str, Account], events: Events
) -> None:
    anna = people["anna"]
    auto = proposed(store, anna, AUTO)
    store.execute(anna, auto, STAMP)
    undone = store.undo(anna, auto)
    assert (undone.status, undone.decision) == ("undone", "auto") and undone.undone_at
    with pytest.raises(ActionError) as again:
        store.undo(anna, auto)
    assert again.value.code == "already_decided"

    adjusted = proposed(store, anna)
    store.decide(anna, adjusted, "adjusted", applied_query=QUERY)
    with pytest.raises(ActionError) as own:
        store.undo(anna, adjusted)
    assert own.value.code == "nothing_to_undo"

    waiting = proposed(store, anna)
    with pytest.raises(ActionError) as early:
        store.undo(anna, waiting)
    assert early.value.code == "nothing_to_undo"

    undo_events = [e for e in events if e["event"] == "model_action_undone"]
    assert undo_events == [
        {"event": "model_action_undone", "username": "anna", "action_id": auto, "decision": "auto"}
    ]


def test_only_the_latest_model_change_is_undone(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna, beat = people["anna"], people["beat"]
    first = proposed(store, anna, AUTO)
    store.execute(anna, first, STAMP)
    second = proposed(store, anna)
    store.approve(anna, second)
    store.execute(anna, second, STAMP)
    theirs = proposed(store, beat, AUTO)
    store.execute(beat, theirs, STAMP)  # another account's change does not count

    with pytest.raises(ActionError) as older:
        store.undo(anna, first)
    assert older.value.code == "nothing_to_undo"
    assert store.undo(anna, second).undone_at is not None
    with pytest.raises(ActionError) as still:
        store.undo(anna, first)  # no redo, and no reaching further back
    assert still.value.code == "nothing_to_undo"


def test_an_adjusted_query_is_not_applied_by_hand(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna = people["anna"]
    action_id = proposed(store, anna)
    with pytest.raises(ActionError) as refused:
        store.decide(anna, action_id, "adjusted", applied_by_hand=True, applied_query=QUERY)
    assert (refused.value.status, refused.value.code) == (400, "bad_request")
    assert store.get(anna, action_id).status == "proposed"
    adjusted = store.decide(anna, action_id, "adjusted", applied_query=QUERY)
    assert (adjusted.decision, adjusted.applied_by_hand, adjusted.applied_query) == (
        "adjusted",
        False,
        QUERY,
    )


def racing(monkeypatch: pytest.MonkeyPatch, status: str, **values: Any) -> None:
    """Another request moves the record on between reading and writing it."""
    original = ModelActionStore._own

    def own(db: Session, caller: Account, action_id: int) -> ModelAction:
        row = original(db, caller, action_id)
        db.connection().execute(
            update(ModelAction).where(ModelAction.id == action_id).values(status=status, **values)
        )
        return row

    monkeypatch.setattr(ModelActionStore, "_own", staticmethod(own))


def test_of_two_changes_at_once_the_later_one_loses(
    store: ModelActionStore, people: dict[str, Account], monkeypatch: pytest.MonkeyPatch
) -> None:
    anna = people["anna"]
    action_id = proposed(store, anna)
    racing(monkeypatch, "rejected", decision="rejected", decided_at=datetime(2026, 10, 10))
    with pytest.raises(ActionError) as lost:
        store.approve(anna, action_id)
    assert (lost.value.status, lost.value.code) == (409, "already_decided")
    assert lost.value.details["status"] == "rejected"


def test_a_preview_racing_an_approval_still_counts(
    store: ModelActionStore, people: dict[str, Account], monkeypatch: pytest.MonkeyPatch
) -> None:
    anna = people["anna"]
    action_id = proposed(store, anna)
    racing(monkeypatch, "approved")
    previewed = store.mark_previewed(anna, action_id)
    assert (previewed.status, previewed.previewed_at is not None) == ("approved", True)


def test_every_time_comes_from_the_application_clock(
    engine: Engine, people: dict[str, Account]
) -> None:
    """Naive UTC everywhere, so a period means the same on every database."""
    now = datetime(2026, 10, 10, 8, 30)
    store = ModelActionStore(engine, clock=lambda: now)
    anna = people["anna"]
    auto = proposed(store, anna, AUTO)
    store.mark_previewed(anna, auto)
    store.execute(anna, auto, STAMP)
    view = store.undo(anna, auto)
    assert (view.created_at, view.previewed_at, view.decided_at, view.undone_at) == (now,) * 4
    assert store.list_actions(anna, ActionFilters(since=now, until=now + timedelta(1))).total == 1


def test_the_start_up_check_closes_what_nobody_will_finish(
    engine: Engine, store: ModelActionStore, people: dict[str, Account], events: Events
) -> None:
    anna, beat = people["anna"], people["beat"]
    thinking = new(store, anna, supersede=False).id
    auto = proposed(store, beat, AUTO, supersede=False)
    approved = proposed(store, anna, supersede=False)
    store.approve(anna, approved)
    running = proposed(store, anna, approach="chain", supersede=False)
    store.approve(anna, running)
    store.run(anna, running)
    store.mark_previewed(anna, approved)
    waiting = proposed(store, anna, supersede=False)
    cutoff = datetime.now(UTC).replace(tzinfo=None) + timedelta(seconds=1)
    young = new(store, beat, supersede=False, proposal_only=True).id
    young_auto = proposed(store, beat, AUTO, supersede=False)
    with Session(engine) as db, db.begin():
        db.execute(
            update(ModelAction)
            .where(ModelAction.id.in_((young, young_auto)))
            .values(created_at=cutoff + timedelta(minutes=1))
        )

    # Nothing in flight survives a restart, whatever its age; only an auto
    # answer's window is measured.
    closed = store.close_stale(cutoff)
    assert sorted(closed) == sorted([thinking, auto, running, young])

    failed = store.get(anna, thinking)
    assert (failed.status, failed.decision, failed.error and failed.error["code"]) == (
        "failed",
        "failed",
        "llm_timeout",
    )
    assert store.get(beat, auto).decision == "superseded"
    interrupted = store.get(anna, running)
    assert (interrupted.status, interrupted.stop_reason) == ("limited", "interrupted")
    assert store.adopt(anna, running, STAMP).decision == "accepted"  # still adoptable
    assert store.get(anna, approved).status == "approved"  # the user approved it
    assert store.get(anna, waiting).status == "proposed"
    assert store.get(beat, young).status == "failed"
    assert store.get(beat, young_auto).status == "approved"
    assert store.close_stale(cutoff) == []
    system = [
        e for e in events if e["event"] == "model_action_decided" and e["username"] == "system"
    ]
    assert {e["action_id"] for e in system} == {thinking, auto, young}


def test_a_proposal_only_record_never_runs_unasked_and_is_never_superseded(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    """P1: in E2.3 every record is proposal-only, whatever the level's cells say."""
    anna = people["anna"]
    action_id = proposed(store, anna, AUTO, proposal_only=True)
    assert store.get(anna, action_id).status == "proposed"
    new(store, anna)
    closed = store.get(anna, action_id)
    assert (closed.status, closed.decision) == ("superseded", "proposal_only")


def test_a_chain_runs_and_is_adopted_or_stopped(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna = people["anna"]
    done = proposed(store, anna, approach="chain")
    store.approve(anna, done)
    store.run(anna, done)
    assert store.finish(anna, done, STAMP).status == "done"
    adopted = store.adopt(anna, done, STAMP)
    assert (adopted.status, adopted.decision) == ("applied", "accepted")

    stopped = proposed(store, anna, AUTO, approach="chain")
    store.run(anna, stopped)
    limited = store.stop(anna, stopped, "time_limit", STAMP)
    assert (limited.status, limited.stop_reason, limited.decision) == (
        "limited",
        "time_limit",
        None,
    )
    assert store.adopt(anna, stopped, STAMP).decision == "accepted"


def test_a_preview_is_logged_and_changes_no_status(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna = people["anna"]
    action_id = proposed(store, anna)
    previewed = store.mark_previewed(anna, action_id)
    assert previewed.status == "proposed" and previewed.previewed_at is not None


def test_a_refusal_keeps_the_answer_and_is_no_decision(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna = people["anna"]
    action = new(store, anna)
    refused = store.refuse(anna, action.id, REFUSAL, answer=ANSWER, latency_ms=1200)
    assert (refused.status, refused.decision, refused.refusal) == ("refused", None, REFUSAL)
    assert refused.answer == ANSWER and refused.query is None and refused.latency_ms == 1200
    answered = store.answer(
        anna, new(store, anna).id, CannotAnswer(kind="cannot_answer", explanation="Kein Layer.")
    )
    assert (answered.status, answered.decision) == ("answered", None)


def test_a_refused_answer_keeps_its_raw_query_up_to_a_bound(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    """Review #35: up to 64 kB of canonical JSON as it came, beyond as omitted."""
    anna = people["anna"]
    room = MAX_RAW_QUERY_BYTES - len('{"junk":""}')
    for size, kept in ((room, True), (room + 1, False)):
        raw = {"junk": "x" * size}
        answer = QueryAnswer(kind="query", explanation="Zu gross.", query=raw)
        refused = store.refuse(anna, new(store, anna).id, REFUSAL, answer=answer)
        assert isinstance(refused.answer, QueryAnswer)
        assert refused.answer.query == (raw if kept else {"omitted": "too large"})
        assert refused.answer.explanation == "Zu gross."


# --- as it was (H7) -------------------------------------------------------------


def test_the_log_outlives_the_account_and_no_new_account_inherits_it(
    engine: Engine, store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna, admin = people["anna"], people["admin"]
    action_id = proposed(store, anna)
    accounts.delete(engine, "anna")
    successor = accounts.create(engine, "anna", USER_PASSWORD, "user")

    assert store.get(admin, action_id).account == "anna"
    assert store.list_actions(admin, ActionFilters(account="anna")).total == 1
    assert store.list_actions(successor).total == 0
    with pytest.raises(ActionError):
        store.get(successor, action_id)


def test_level_and_connection_stay_as_they_were(
    engine: Engine, store: ModelActionStore, people: dict[str, Account], tmp_path: Path
) -> None:
    anna = people["anna"]
    levels = load_levels(engine)
    level = next(lv for lv in levels if lv.is_default)
    connections = Connections(engine, Vault.open(tmp_path))
    info = connections.create(
        ConnectionWrite(
            name="Lokal",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen3:8b",
            enabled=True,
            is_default=True,
        )
    )
    action = new(store, anna, level=level_snapshot(level), connection=connection_snapshot(info))
    store.propose(anna, action.id, ANSWER, query=QUERY, governance=APPROVE)
    before = store.get(anna, action.id)

    edited = Level(
        **{
            **level.model_dump(),
            "name": "Streng",
            "system_prompt": "Anders.",
            "matrix": {c: CellMode.OFF for c in OpClass},
        }
    )
    save_levels(engine, [edited if lv.id == level.id else lv for lv in levels])
    connections.update(
        info.id,
        ConnectionPatch(
            name="Extern",
            model="gpt-5-mini",
            base_url="https://api.openai.com/v1",
            confirm_data_release=True,
        ),
    )
    after_edit = store.get(anna, action.id)
    connections.delete(info.id)

    assert after_edit == before == store.get(anna, action.id)
    assert before.level.name == level.name and before.level.matrix == level.matrix
    assert (before.connection.name, before.connection.host, before.connection.locality) == (
        "Lokal",
        "127.0.0.1",
        "local",
    )


# --- who sees what (D4) ---------------------------------------------------------

CHANGES = sorted(set(STEPS) - {"new_prompt", "restart"})  # those take no record id


@pytest.mark.parametrize("step", CHANGES)
@pytest.mark.parametrize("who", ["beat", "admin"])
def test_another_account_cannot_change_a_record(
    store: ModelActionStore, people: dict[str, Account], step: str, who: str
) -> None:
    anna = people["anna"]
    action_id = proposed(store, anna)
    before = store.get(anna, action_id)
    with pytest.raises(ActionError) as refused:
        STEPS[step](store, people[who], action_id)
    assert (refused.value.status, refused.value.code) == (404, "not_found")
    assert store.get(anna, action_id) == before


def test_a_user_reads_only_their_own_records(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna, beat, admin = people["anna"], people["beat"], people["admin"]
    mine = proposed(store, anna)
    theirs = proposed(store, beat)
    store.reject(beat, theirs)

    with pytest.raises(ActionError) as hidden:
        store.get(anna, theirs)
    assert (hidden.value.status, hidden.value.code) == (404, "not_found")
    with pytest.raises(ActionError) as missing:
        store.get(anna, 9999)
    assert hidden.value.message.replace(str(theirs), "#") == missing.value.message.replace(
        "9999", "#"
    )
    assert [a.id for a in store.list_actions(anna).items] == [mine]
    assert store.list_actions(anna, ActionFilters(account="beat")).total == 0
    assert store.key_figures(anna).rejected == 0

    assert store.get(admin, theirs).prompt == PROMPT
    assert {a.id for a in store.list_actions(admin).items} == {mine, theirs}
    assert [a.id for a in store.list_actions(admin, ActionFilters(account="beat")).items] == [
        theirs
    ]
    assert store.key_figures(admin).rejected == 1


def test_a_follow_up_refers_to_an_own_record_only(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna, beat = people["anna"], people["beat"]
    parent = proposed(store, anna)
    with pytest.raises(ActionError) as refused:
        new(store, beat, parent_action_id=parent, reference="last_answer")
    assert refused.value.code == "not_found"
    with pytest.raises(ActionError):
        new(store, beat, compare_of=parent, supersede=False)
    child = new(store, anna, parent_action_id=parent, reference="hand_edited")
    assert (child.parent_action_id, child.reference) == (parent, "hand_edited")


def test_the_list_pages_newest_first_and_filters(
    engine: Engine, store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna, admin = people["anna"], people["admin"]
    ids = [new(store, anna, supersede=False).id for _ in range(5)]
    other = new(
        store,
        anna,
        approach="chain",
        level=LEVEL.model_copy(update={"id": 9}),
        connection=CONNECTION.model_copy(update={"id": 7}),
    ).id
    start = datetime(2026, 10, 1)
    with Session(engine) as db, db.begin():
        for n, action_id in enumerate([*ids, other]):
            db.execute(
                update(ModelAction)
                .where(ModelAction.id == action_id)
                .values(created_at=start + timedelta(days=n))
            )
    page = store.list_actions(admin, offset=1, limit=2)
    assert page.total == 6 and [a.id for a in page.items] == [ids[4], ids[3]]
    assert page.items[0].hits is None and page.items[0].level_name == "Prüfen"
    for filters in (
        ActionFilters(approach="chain"),
        ActionFilters(level_id=9),
        ActionFilters(connection_id=7),
        ActionFilters(since=start + timedelta(days=5)),
    ):
        assert [a.id for a in store.list_actions(anna, filters).items] == [other], filters
    window = ActionFilters(since=start + timedelta(days=1), until=start + timedelta(days=3))
    assert [a.id for a in store.list_actions(anna, window).items] == [ids[2], ids[1]]
    with pytest.raises(ValueError):
        store.list_actions(anna, limit=10_000)


# --- superseding (WP70) ---------------------------------------------------------


def test_a_new_prompt_closes_the_open_record(
    store: ModelActionStore, people: dict[str, Account], events: Events
) -> None:
    anna, beat = people["anna"], people["beat"]
    waiting = proposed(store, anna)
    after = new(store, anna)
    assert store.get(anna, waiting).status == "superseded"
    assert store.get(anna, waiting).decision == "superseded"
    assert store.get(anna, after.id).status == "thinking"

    off = proposed(store, anna, OFF)
    store.supersede_open(anna)
    closed = store.get(anna, off)
    assert (closed.status, closed.decision, closed.applied_by_hand) == (
        "superseded",
        "proposal_only",
        False,
    )

    auto = proposed(store, anna, AUTO)  # approved, never executed (window closed)
    chain = proposed(store, anna, approach="chain", supersede=False)
    store.approve(anna, chain)
    store.run(anna, chain)
    store.finish(anna, chain, STAMP)
    stopped = proposed(store, anna, approach="chain", supersede=False)
    store.approve(anna, stopped)
    store.run(anna, stopped)
    store.stop(anna, stopped, "aborted")
    running = proposed(store, anna, approach="chain", supersede=False)
    store.approve(anna, running)
    store.run(anna, running)
    applied = proposed(store, anna, OFF, supersede=False)  # proposal_only: an off part (WP71)
    store.decide(anna, applied, "proposal_only", applied_by_hand=True)
    theirs = proposed(store, beat)
    thinking = new(store, anna, supersede=False).id

    assert sorted(store.supersede_open(anna)) == sorted([auto, chain, stopped])
    for action_id in (auto, chain, stopped):
        assert store.get(anna, action_id).decision == "superseded"
    assert store.get(anna, running).status == "running"
    assert store.get(anna, applied).decision == "proposal_only"
    assert store.get(anna, thinking).status == "thinking"
    assert store.get(beat, theirs).status == "proposed"
    assert store.supersede_open(anna) == []

    decided = [e for e in events if e["event"] == "model_action_decided"]
    assert {(e["action_id"], e["decision"]) for e in decided} >= {
        (waiting, "superseded"),
        (off, "proposal_only"),
        (auto, "superseded"),
    }
    assert PROMPT not in json.dumps(events, ensure_ascii=False, default=str)


def test_a_comparison_leaves_the_action_it_repeats_open(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna = people["anna"]
    first = proposed(store, anna)
    other = new(store, anna, approach="chain", compare_of=first, supersede=False)
    assert other.compare_of == first
    assert store.get(anna, first).status == "proposed"


# --- key figures (section 2) ----------------------------------------------------


def build(store: ModelActionStore, who: Account, end: str, **fields: Any) -> int:
    """One record that ends in ``end``, the way the flow would get it there."""
    if end in ("refused", "aborted", "failed"):
        action_id = new(store, who, supersede=False, **fields).id
        {"refused": STEPS["refuse"], "aborted": STEPS["abort"], "failed": STEPS["fail"]}[end](
            store, who, action_id
        )
        return action_id
    rule = {"auto": AUTO, "auto_undone": AUTO, "proposal_only": OFF}.get(end, APPROVE)
    action_id = proposed(store, who, rule, supersede=False, **fields)
    if end in ("accepted", "accepted_undone"):
        store.approve(who, action_id)
        store.execute(who, action_id, STAMP)
    elif end in ("auto", "auto_undone"):
        store.execute(who, action_id, STAMP)
    elif end == "adjusted":
        store.decide(who, action_id, "adjusted", applied_query=QUERY)
    elif end == "rejected":
        store.reject(who, action_id)
    elif end == "proposal_only":
        store.decide(who, action_id, "proposal_only", applied_by_hand=True)
    if end.endswith("_undone"):
        store.undo(who, action_id)
    if end == "superseded":
        store.supersede_open(who)
    return action_id


def test_key_figures_reproduce_the_fixture(
    store: ModelActionStore, people: dict[str, Account]
) -> None:
    figures = fixture()["key_figures"]
    counts = dict(figures["decisions"])
    # The fixture counts undone ones inside their decision; build them apart.
    counts["auto"] -= counts["auto_undone"]
    counts["accepted"] -= counts["accepted_undone"]
    anna, beat, admin = people["anna"], people["beat"], people["admin"]
    for n, (end, count) in enumerate(sorted(counts.items())):
        for i in range(count):
            build(store, anna if (n + i) % 2 else beat, end)
    proposed(store, anna, supersede=False)  # open: no decision yet
    new(store, beat, supersede=False)  # still thinking

    expect = {k: v for k, v in figures["expect"].items() if not k.startswith("_")}
    assert store.key_figures(admin).model_dump() == expect


def test_key_figures_follow_the_filters(
    engine: Engine, store: ModelActionStore, people: dict[str, Account]
) -> None:
    anna, admin = people["anna"], people["admin"]
    assert store.key_figures(admin).acceptance_rate is None
    build(store, anna, "accepted")
    build(store, anna, "rejected", approach="chain")
    build(store, anna, "auto_undone", level=LEVEL.model_copy(update={"id": 9}))
    build(store, anna, "accepted_undone", connection=CONNECTION.model_copy(update={"id": 7}))
    old = build(store, anna, "superseded")
    with Session(engine) as db, db.begin():
        db.execute(
            update(ModelAction).where(ModelAction.id == old).values(created_at=datetime(2020, 1, 1))
        )

    everything = store.key_figures(admin)
    assert (everything.proposals, everything.acceptance_rate) == (5, 0.5)
    assert (everything.undone, everything.undone_after_approval) == (1, 1)
    recent = store.key_figures(admin, ActionFilters(since=datetime(2026, 1, 1)))
    assert (recent.superseded, recent.acceptance_rate) == (0, round(2 / 3, 4))
    assert store.key_figures(admin, ActionFilters(approach="chain")).rejected == 1
    level = store.key_figures(admin, ActionFilters(level_id=9))
    assert (level.auto, level.undone, level.acceptance_rate) == (1, 1, None)
    connection = store.key_figures(admin, ActionFilters(connection_id=7))
    assert (connection.accepted, connection.undone_after_approval) == (1, 1)
