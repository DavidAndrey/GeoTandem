"""The prompt flow of the direct query and its enforcement (plan E2.3-E2.6,
WP65, WP70).

``POST /api/model/prompt`` in steps, everything that can refuse the request
first, so a refused request leaves no record and reaches no model:

1. level and connection are the account's, resolved here on every request
   (H6, C17); no connection ⇒ ``connection_not_available``;
2. the account's layer profile, built once: the record keeps its hash (S4) and
   the model gets exactly it; the prompt, built once over it, against the
   connection's context length ⇒ ``context_too_large`` (400, no record, as the
   contract fixture says);
3. a free model-call slot (``ModelCalls``) ⇒ else 503 ``busy``;
4. in one critical section: no model call of the account still in flight,
   an aborted one included, since it still holds the model ⇒ else 409
   ``busy`` (``reason: running``, ``id``); a ``thinking`` record of the
   account older than ``MODEL_CALL_S`` and a margin is one no call will
   finish any more and ends ``failed``; then, inside the transaction that
   creates the record: no other prompt of the account still ``thinking`` ⇒
   else 409 ``busy`` likewise; the connection's request limit, when the
   administrator switched it on (P5): the requests of the current calendar
   day (the server's time zone) that reached the model call or may still
   reach it, counted from the action table over all accounts ⇒
   ``quota_exceeded``. Then the record, ``thinking``. Creating it closes the
   account's open record (``proposed``, ``approved`` never executed, ``done``,
   ``limited``): ``superseded``, or ``proposal_only`` when a class of it was
   ``off`` (WP70).

The 202 leaves at once (P7); the model call runs in a thread of
``ModelCalls``, never in the threads that answer requests. It has a wall-clock
deadline from the prompt on: the connection's timeout, at most
``MODEL_CALL_S``, for every attempt and retry together (``LLMClient``). Its
outcome is stored as one edge out of ``thinking``: ``refused``, ``answered``,
``proposed``, ``approved``, or ``failed`` with the seam's ``llm_*`` code,
``model_unreadable`` or, when the outcome cannot be stored,
``internal_error``. A query answer is governed by the level as it was when
asked (D1, D2, M6.3): its classes (``classify``) and their cells, the
strictest cell for the whole answer. Any class ``off``: a proposal the user
applies by hand (``proposal_only``); else any ``approve``: ``proposed``, it
waits for ``approve``; all ``auto``: ``approved`` at once, and the client
calls ``execute`` (P7). An abort sets the call's cancel event: a call not started
yet never reaches the model, an answer that arrives later is dropped (and the
store's compare-and-set would drop it too). The HTTP call itself is not
cancelled: it ends by its deadline, which bounds every socket operation, so an
endpoint that trickles its answer cannot outlast it, and its answer is capped
in size (``openai_compat``, review #34); until then the account's next prompt
waits (409). Should the call's thread still linger ``EXPIRY_GRACE_S`` after
the deadline, ``ModelCalls`` gives it up: the account and the slot are free,
the record ends ``failed`` (``llm_timeout``), and a late answer is dropped.

A follow-up (P6) is linked to its parent, which must be the caller's own
record (404 otherwise). The model gets the turns of the parent chain, at most
``MAX_TURNS`` of the account's own records: so the reply to a clarification
(M12.2) carries its question. The derived reference, the sent ``analysis``
and ``stale_reference`` arrive with WP81; until then ``reference`` stays
``none``.

Enforcement (WP70): every step after the prompt works on the stored record
alone, with the level as it was snapshotted (M7.3); the account's level now
is never consulted. ``approve`` is refused with ``class_not_allowed`` for an
``off`` class; ``execute`` runs the stored query, never one sent along, only
for ``approved``, as the caller through the engine with its limits, and is
the one answer with rows; the preview (P2) counts the stored query for the
user, never for the model, and changes no status. Undo is for the log only:
the client restores the analysis itself.

The tool chain (WP75, P4) goes the same way up to its answer: the prompt
with the chain's answer format, one planning call, the plan checked whole
(``check_plan``) and stored with its steps, governed by the union of their
classes at the level as it was (``chain_governance``): any class ``off``, a
proposal only (D1); any ``approve``, ``proposed``; all ``auto``, ``approved``.
Each step keeps its own cell. Before it runs, the user may change values and
remove steps (``edit_plan``, never a new step); the plan is checked whole
again. ``run`` (202, only ``approved``) starts the steps in a thread of
``ModelCalls``, as a model call is (one per account, a bounded number in
all): one step at a time, counted at the profile and view as they are at run
time (``run_step``), its count stored for the user and its ``model_view`` for
the model. It halts (``proposed``, the step ``waiting``) before a step whose
cell is ``approve`` that no approval cleared, re-plans after an error or an
empty step before the last (at most ``MAX_REPLANS``, the re-plan's steps
continue the count, ``MAX_STEPS`` in all), asks for approval again after a
re-plan where the level wants it, and stops ``limited`` at the request's
deadline (``CHAIN_TIME_LIMIT_S``, halts left out), at a last step beyond the
result-size limit, when re-plans are used up or bring nothing, or when the
user aborts: the step that runs ends, no other starts. Its last complete
result waits to be adopted: ``adopt`` runs it as the user, as ``execute``
runs a direct answer, and is the other answer with rows.

The comparison (WP76, design M10, P7) is a prompt too: ``compare`` asks the
prompt of a record with a result again with the other approach, as a new
record that repeats it (``compare_of``), through the same flow with the
account's level and connection as they are now; the record compared is not
closed. Once both have a result, ``comparison`` runs both stored queries as
the user and compares their feature ids; the model is not asked. Taking a
side is that record's own ``execute`` or ``adopt``, with its own approval.

Logs carry ids and codes only, never the prompt or the answer (C15).
"""

import logging
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import wait as wait_for
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta, tzinfo
from functools import partial
from typing import Any, Final

from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from geotandem.auth.accounts import Account
from geotandem.auth.visibility import visible_names
from geotandem.catalog import ModelProfile, list_layers, model_profile
from geotandem.connections import ConnectionInfo, ConnectionProblem, Connections
from geotandem.data import DataBackend, Limits, Op
from geotandem.data.view import LayerView
from geotandem.db.orm import ModelAction
from geotandem.engine import (
    QueryError,
    ResultStamp,
    count_query,
    ids_query,
    run_query,
    stamp_of,
    stamped_ids,
    values_of,
)
from geotandem.engine.errors import QueryTimedOut, ResultTooLarge
from geotandem.levels import CellMode, Level, OpClass, active_level
from geotandem.llm import ClientFactory, Endpoint, LLMClient, LLMError
from geotandem.model.chain.ask import (
    ChainState,
    ask,
    edits_message,
    kept_turns,
    restored_turns,
)
from geotandem.model.chain.plan import (
    CheckedStep,
    Placed,
    chain_governance,
    check_plan,
    edit_plan,
    one_approval,
    step_cell,
)
from geotandem.model.chain.run import run_step, stamp
from geotandem.model.chain.view import restored
from geotandem.model.compare import Labels, name_attribute, reason
from geotandem.model.direct import DirectAnswer, DirectQuery, governance
from geotandem.model.errors import ActionError
from geotandem.model.prompt import FollowUp, Prompt, Turn, build_prompt
from geotandem.model.record import (
    COMPLETE,
    RAN,
    Chain,
    ChainStep,
    ModelActionStore,
    NewAction,
    connection_snapshot,
    last_complete,
    level_snapshot,
    utc_now,
)
from geotandem.model.schemas import (
    CHAIN_TIME_LIMIT_S,
    MAX_STEPS,
    MAX_TURNS,
    ActionPreview,
    CannotAnswer,
    Clarification,
    Comparison,
    DecideRequest,
    ExecuteResponse,
    FeatureRef,
    Governance,
    ModelActionView,
    ModelView,
    PlanAnswer,
    PlanEdit,
    PlannedStep,
    PromptRequest,
    QueryAnswer,
    Refusal,
    RejectRequest,
    StepStatus,
    StopReason,
)
from geotandem.tools import ToolContext
from geotandem_query import QueryObject

log = logging.getLogger(__name__)

MODEL_CALL_S: Final = 120
"""The model call's time limit (plan 1, fixture ``limits.model_call_s``); also
how long an ``auto`` answer waits to be executed before the start-up check
closes it. The frontend's timer repeats it (``panel/state.ts``); a test on
each side holds it to the fixture."""
EXPIRY_GRACE_S: Final = 5
"""Past a call's deadline: a call not finished by then is given up
(``ModelCalls``). Its sockets end at the deadline itself (``openai_compat``);
the grace leaves time to store the outcome."""
STALE_MARGIN_S: Final = 30
"""Beyond ``MODEL_CALL_S``: a ``thinking`` record this old has no call left
that could finish it."""
STALE_ERROR: Final = {
    "code": "llm_timeout",
    "message": "No answer arrived before the application stopped waiting.",
    "details": {},
}


def day_start(now: datetime, tz: tzinfo | None = None) -> datetime:
    """Midnight of ``now``'s calendar day in ``tz`` (``None``: the server's time
    zone), as naive UTC like ``now`` (P5)."""
    local = now.replace(tzinfo=UTC).astimezone(tz)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    # The offset at midnight, which differs from now's on a day the clocks change.
    aware = midnight.astimezone() if tz is None else midnight.replace(tzinfo=tz)
    return aware.astimezone(UTC).replace(tzinfo=None)


def close_stale(
    engine: Engine, max_features: int, clock: Callable[[], datetime] = utc_now
) -> list[int]:
    """The start-up check (P7): nothing in flight survives a restart of the one
    process, so every ``thinking`` record ends ``failed``, every ``running``
    chain ``limited``/``interrupted`` with its result within ``max_features``
    adoptable; an unexecuted ``auto`` answer older than ``MODEL_CALL_S`` is
    closed too."""
    older_than = clock() - timedelta(seconds=MODEL_CALL_S)
    return ModelActionStore(engine, clock).close_stale(older_than, max_features)


def read_view(backend: DataBackend, account: Account) -> DataBackend:
    """The layers ``account`` sees, read-only whatever its role (F-9.5):
    ``view_for`` hands an administrator the data core itself, which can write;
    the model path gets a ``LayerView`` over the same layers instead, whose
    writes raise ``PermissionError`` (WP71)."""
    return LayerView(backend, visible_names(backend.engine, account.role))


def profile_for(backend: DataBackend, account: Account) -> tuple[DataBackend, ModelProfile]:
    """The account's read-only view and the layer profile its model gets over it
    (S3): what it sees and the administrator released for the model."""
    view = read_view(backend, account)
    return view, model_profile(backend.engine, view.layer_names())


def _error(code: str, message: str, **details: Any) -> dict[str, Any]:
    """The record's ``error`` (design M14): the same shape as an error body."""
    return {"code": code, "message": message, "details": details}


def _busy(action_id: int) -> ActionError:
    """The account's prompt ``action_id`` still holds the model (one at a time)."""
    return ActionError(
        "busy",
        f"The account's prompt {action_id} is still being answered.",
        http_status=409,
        reason="running",
        id=action_id,
    )


def turns_of(thread: list[ModelActionView]) -> list[Turn]:
    """The follow-up turns of a parent chain, oldest first (P6): words, never a query."""
    return [
        Turn.of(
            view.prompt,
            view.answer,
            refusal=view.refusal.code if view.refusal else None,
            decision=view.decision,
            reject_reason=view.reject_reason,
        )
        for view in thread
    ]


class ModelCallsBusy(Exception):
    """Every model-call slot is taken: 503 ``busy``, nothing recorded."""


class ModelCalls:
    """The model calls in flight (P7): at most ``size`` at once, each in a thread
    of its own pool, so a slow model never holds the threads that answer
    requests; and at most one per account, an aborted call included until it
    has ended, or until its deadline and ``grace_s`` have passed, whichever
    comes first (review #34): then the call is given up, its account entry and
    its slot are free, its ``expire`` closes the record, and the thread, if it
    lingers, finds its cancel event set and its answer dropped. One per
    application (``AppState``)."""

    def __init__(self, size: int, grace_s: float = EXPIRY_GRACE_S) -> None:
        self.admission = threading.Lock()
        """Held around the checks of a new record and its creation, so two
        prompts never both pass (P5, one prompt at a time per account)."""
        self._executor = ThreadPoolExecutor(max_workers=size, thread_name_prefix="model-call")
        self._slots = threading.BoundedSemaphore(size)
        self._grace_s = grace_s
        self._lock = threading.Lock()
        self._cancel: dict[int, threading.Event] = {}
        self._accounts: dict[int, int] = {}
        """Account id → the action whose call it has in flight."""
        self._held: dict[int, threading.Timer | None] = {}
        """Actions whose call holds a slot, with the timer that gives it up."""
        self._running: set[Future[None]] = set()
        self._executing: set[int] = set()
        """Actions whose stored query runs now (``PromptFlow.execute``)."""

    def claim(self, action_id: int) -> bool:
        """The action's ``execute`` may run: ``False`` while another runs it. The
        application is one process, so this holds across its threads."""
        with self._lock:
            if action_id in self._executing:
                return False
            self._executing.add(action_id)
            return True

    def release(self, action_id: int) -> None:
        with self._lock:
            self._executing.discard(action_id)

    def take(self) -> None:
        """A slot for one call, without waiting; given back when the call ends."""
        if not self._slots.acquire(blocking=False):
            raise ModelCallsBusy

    def give_back(self) -> None:
        self._slots.release()

    def in_flight(self, account_id: int) -> int | None:
        """The action whose call the account has in flight, aborted or not."""
        with self._lock:
            return self._accounts.get(account_id)

    def start(
        self,
        account_id: int,
        action_id: int,
        call: Callable[[threading.Event], None],
        *,
        deadline: float | None = None,
        expire: Callable[[], None] | None = None,
    ) -> None:
        """Run ``call`` with the action's cancel event; it calls ``finish``. With
        ``deadline`` (``time.monotonic()``) the call is given up ``grace_s``
        after it, if it has not finished by then: its cancel event is set, its
        account entry and its slot are free, and ``expire`` runs."""
        cancel = threading.Event()
        timer = None
        if deadline is not None:
            wait = max(0.0, deadline - time.monotonic()) + self._grace_s
            timer = threading.Timer(wait, self._expire, (account_id, action_id, expire))
            timer.daemon = True
        with self._lock:
            self._cancel[action_id] = cancel
            self._accounts[account_id] = action_id
            self._held[action_id] = timer
        try:
            future = self._executor.submit(call, cancel)
        except BaseException:
            self._drop(account_id, action_id)
            raise
        with self._lock:
            self._running.add(future)
        future.add_done_callback(self._done)
        if timer is not None:
            timer.start()

    def _done(self, future: Future[None]) -> None:
        with self._lock:
            self._running.discard(future)

    def _drop(self, account_id: int, action_id: int) -> bool:
        """Forget the call; ``True`` if it still held its slot (once only)."""
        with self._lock:
            self._cancel.pop(action_id, None)
            if self._accounts.get(account_id) == action_id:
                del self._accounts[account_id]
            held = action_id in self._held
            timer = self._held.pop(action_id, None)
        if timer is not None:
            timer.cancel()
        return held

    def finish(self, account_id: int, action_id: int) -> None:
        """The call of ``action_id`` ended: forget it, give its slot back,
        unless its deadline gave it up already."""
        if self._drop(account_id, action_id):
            self.give_back()

    def _expire(self, account_id: int, action_id: int, expire: Callable[[], None] | None) -> None:
        """The call outlived its deadline: give it up (``start``)."""
        self.cancel(action_id)
        if not self._drop(account_id, action_id):
            return  # it finished meanwhile
        self.give_back()
        log.warning("model action %d: given up at its deadline, the call still runs", action_id)
        if expire is not None:
            try:
                expire()
            except Exception as exc:
                log.error("model action %d: not closed (%s)", action_id, type(exc).__name__)

    def cancel(self, action_id: int) -> None:
        with self._lock:
            event = self._cancel.get(action_id)
        if event is not None:
            event.set()

    def wait(self, timeout: float | None = None) -> None:
        """Until every call started so far has ended (tests)."""
        with self._lock:
            running = list(self._running)
        wait_for(running, timeout)

    def shutdown(self) -> None:
        """Calls not started are dropped; their records are closed at the next start."""
        with self._lock:
            timers = [t for t in self._held.values() if t is not None]
        for timer in timers:
            timer.cancel()
        self._executor.shutdown(wait=False, cancel_futures=True)


@dataclass(frozen=True)
class _Call:
    """What the call needs, resolved while the request was checked."""

    endpoint: Endpoint = field(repr=False)
    deadline: float
    """``PromptFlow.monotonic()`` by which the call ends, retries included."""
    context: ToolContext
    level: Level
    prompt: Prompt = field(repr=False)
    profile: ModelProfile = field(repr=False)
    approach: str = "direct"


@dataclass(frozen=True)
class _Planned:
    """The planning call's outcome (P4): a plan checked whole with its steps
    and their governance, a plan refused, or what the model said instead."""

    answer: PlanAnswer | Clarification | CannotAnswer
    latency_ms: int
    steps: list[ChainStep] | None = None
    governance: Governance | None = None
    refusal: Refusal | None = None


def new_step(level: Level, checked: CheckedStep, **more: Any) -> ChainStep:
    """A checked step as the record keeps it, with its cell at ``level`` (H4):
    how the planning call stores a plan, an edit and a re-plan their steps."""
    planned = checked.step
    return ChainStep(
        position=checked.position,
        text=planned.text,
        tool=planned.tool,
        arguments=planned.arguments,
        query=checked.query,
        classes=checked.classes,
        cell=step_cell(level, checked),
        **more,
    )


def _checked(step: ChainStep) -> CheckedStep:
    """A stored step as the chain's state takes it again."""
    planned = PlannedStep(text=step.text, tool=step.tool, arguments=step.arguments)
    return CheckedStep(step.position, planned, step.query, step.classes)


def _snapshot_level(view: ModelActionView, system_prompt: str = "") -> Level:
    """The level as the record keeps it (H7, M7.3): its matrix governs."""
    return Level(
        id=view.level.id,
        name=view.level.name,
        matrix=view.level.matrix,
        system_prompt=system_prompt,
    )


def _adopted(
    steps: list[ChainStep], context: ToolContext, profile: ModelProfile
) -> tuple[ChainStep | None, ResultStamp | None]:
    """A chain's result to adopt (decision 11, ``last_complete``) with its
    stamp, the only one a chain's steps get."""
    found = last_complete(steps, context.limits.max_features)
    if found is None:
        return None, None
    try:
        return found, stamp(found.query, context, profile)
    except QueryError as exc:  # the stamp's run failed: offered unstamped
        log.warning("model chain: result not stamped (%s)", exc.code)
        return found, None


@dataclass(frozen=True)
class PromptFlow:
    backend: DataBackend
    connections: Connections
    client_factory: ClientFactory
    calls: ModelCalls
    limits: Limits
    unsupported: frozenset[Op] = frozenset()
    clock: Callable[[], datetime] = utc_now
    """Naive UTC; the record's times and the day the request limit counts."""
    tz: tzinfo | None = None
    """The time zone whose calendar day the request limit counts; ``None``: the server's."""
    monotonic: Callable[[], float] = time.monotonic
    """The clock of every time limit: a model call's deadline, a chain's (P4)."""

    @property
    def store(self) -> ModelActionStore:
        return ModelActionStore(self.backend.engine, self.clock)

    def _real(self, deadline: float) -> float:
        """``deadline`` on ``time.monotonic``, for the timer that gives a call up."""
        return time.monotonic() + (deadline - self.monotonic())

    # --- the prompt (P7) ---------------------------------------------------------

    def prompt(self, caller: Account, request: PromptRequest) -> ModelActionView:
        """Check, record ``thinking``, start the call; the record as it is now."""
        return self._ask_model(caller, request)

    def _ask_model(
        self, caller: Account, request: PromptRequest, compare_of: int | None = None
    ) -> ModelActionView:
        """The prompt flow (module docstring), for a prompt and for a comparison:
        a repeat (``compare_of``) waits beside the record it repeats instead of
        closing the account's open record."""
        level = active_level(self.backend.engine, caller.id, admin=caller.role == "admin")
        # One read: the snapshot is of the connection the call goes to (WP71).
        active = self.connections.active_call(caller.id)
        if active is None:
            raise ConnectionProblem(
                409,
                "connection_not_available",
                "No model connection is set up for this account.",
                reason="none",
            )
        connection, endpoint = active
        view, profile = profile_for(self.backend, caller)
        follow_up = None
        if request.parent_action_id is not None:
            # Own records only, 404 otherwise; reference and analysis arrive with WP81.
            thread = self.store.thread(caller, request.parent_action_id, MAX_TURNS)
            follow_up = FollowUp(turns=turns_of(thread))
        prompt = build_prompt(
            request.text,
            approach=request.approach,
            level=level,
            profile=profile,
            follow_up=follow_up,
            context_length=connection.context_length,
        )
        timeout_s = min(endpoint.timeout_s, MODEL_CALL_S)
        call = _Call(
            endpoint=replace(endpoint, timeout_s=timeout_s),
            deadline=self.monotonic() + timeout_s,
            context=ToolContext(view, self.limits, self.unsupported),
            level=level,
            prompt=prompt,
            profile=profile,
            approach=request.approach,
        )
        new = NewAction(
            prompt=request.text,
            approach=request.approach,
            level=level_snapshot(level),
            connection=connection_snapshot(connection),
            profile_hash=profile.hash,
            parent_action_id=request.parent_action_id,
            level_prompt=level.system_prompt,
            compare_of=compare_of,
        )
        # The account's own call first (review #36): an account that waits for
        # its answer gets 409 and never holds a slot, even for a moment, that
        # another account's prompt would find taken (503).
        in_flight = self.calls.in_flight(caller.id)
        if in_flight is not None:
            raise _busy(in_flight)
        self.calls.take()
        try:
            with self.calls.admission:
                in_flight = self.calls.in_flight(caller.id)
                if in_flight is not None:
                    raise _busy(in_flight)
                stale = self.clock() - timedelta(seconds=MODEL_CALL_S + STALE_MARGIN_S)
                for closed in self.store.fail_thinking(caller, stale, STALE_ERROR):
                    log.warning("model action %d: closed, no call left to finish it", closed)
                action = self.store.create(
                    caller,
                    new,
                    supersede=compare_of is None,
                    admit=partial(self._admit, caller=caller, connection=connection),
                )
                answer = partial(self._answer, caller, action.id, call)
                self.calls.start(
                    caller.id,
                    action.id,
                    answer,
                    deadline=self._real(call.deadline),
                    expire=partial(self._expired, caller, action.id),
                )
        except BaseException:
            self.calls.give_back()
            raise
        log.info(
            "model action %d asked (%s): connection %d, level %d, profile %s",
            action.id,
            request.approach,
            connection.id,
            action.level.id,
            profile.hash[:12],
        )
        return action

    def _admit(self, db: Session, *, caller: Account, connection: ConnectionInfo) -> None:
        """In the transaction that creates the record: one prompt at a time per
        account, and the connection's request limit (P5). Off: no counting."""
        thinking = db.scalar(
            select(ModelAction.id)
            .where(ModelAction.user_id == caller.id, ModelAction.status == "thinking")
            .limit(1)
        )
        if thinking is not None:
            raise _busy(thinking)
        if not connection.request_limit_enabled:
            return
        limit = connection.request_limit_per_day
        if limit is None:  # the connection rules and the table's check keep it set
            raise RuntimeError(f"connection {connection.id} has a request limit without number")
        # A request counts once it reached the model call, or while it still may
        # (thinking): one refused before any record, or aborted before its call,
        # does not.
        used = db.scalar(
            select(func.count())
            .select_from(ModelAction)
            .where(
                ModelAction.connection_id == connection.id,
                ModelAction.created_at >= day_start(self.clock(), self.tz),
                ModelAction.called_at.is_not(None) | (ModelAction.status == "thinking"),
            )
        )
        if (used or 0) >= limit:
            raise ActionError(
                "quota_exceeded",
                f"The {limit} requests per day of the connection '{connection.name}' are "
                "used up; an administrator sets the limit.",
                http_status=429,
                limit=limit,
                connection=connection.name,
            )

    # --- the call (P7) -------------------------------------------------------------

    def _answer(
        self, caller: Account, action_id: int, call: _Call, cancel: threading.Event
    ) -> None:
        """Ask the model and store what came of it. Never raises; gives the slot
        back. Whatever goes wrong ends the record ``failed``: an outcome that
        cannot be stored as ``internal_error`` where that still can be, else the
        account's next prompt or the start-up check closes it."""
        store = self.store
        try:
            if cancel.is_set() or not store.mark_called(caller, action_id):
                log.info("model action %d: aborted before the call", action_id)
                return
            write = self._ask(store, caller, action_id, call)
            if cancel.is_set():
                log.info("model action %d: answer dropped (aborted)", action_id)
                return
            self._settle(action_id, write)
        except Exception as exc:
            # The type only: an exception's text may quote the prompt (C15).
            log.error("model action %d: the call failed (%s)", action_id, type(exc).__name__)
            self._fail_quietly(store, caller, action_id)
        finally:
            self.calls.finish(caller.id, action_id)

    def _expired(self, caller: Account, action_id: int) -> None:
        """The call outlived its deadline and was given up (``ModelCalls``): the
        record ends ``failed``, ``llm_timeout``, unless it was settled or aborted
        meanwhile; the call's late answer is dropped by the compare-and-set."""
        try:
            self.store.fail(
                caller,
                action_id,
                _error(
                    "llm_timeout",
                    "No answer before the call's time limit.",
                    cause="given up at the deadline",
                ),
            )
        except ActionError:
            return  # settled or aborted meanwhile

    @staticmethod
    def _fail_quietly(store: ModelActionStore, caller: Account, action_id: int) -> None:
        """Best effort: a record left ``thinking`` would hold the account."""
        try:
            store.fail(
                caller, action_id, _error("internal_error", "The answer could not be stored.")
            )
        except Exception as exc:
            log.error("model action %d: not closed either (%s)", action_id, type(exc).__name__)

    def _ask(
        self, store: ModelActionStore, caller: Account, action_id: int, call: _Call
    ) -> Callable[[], ModelActionView]:
        """The model's answer, as the write that stores it."""
        found: DirectAnswer | _Planned
        try:
            client = self.client_factory(call.endpoint)
            try:
                if call.approach == "chain":
                    found = self._plan(client, call)
                else:
                    direct = DirectQuery(client, call.context, call.level)
                    found = direct.ask(call.prompt, profile=call.profile, deadline=call.deadline)
            finally:
                client.close()
        except LLMError as exc:
            error = _error(exc.code, exc.message, cause=exc.cause)
        except ActionError as exc:  # model_unreadable; its cause names no text
            error = _error(exc.code, exc.message, **exc.details)
        except Exception as exc:
            log.error("model action %d: the call failed (%s)", action_id, type(exc).__name__)
            error = _error("internal_error", "The model call stopped unexpectedly.")
        else:
            return partial(self._keep, store, caller, action_id, found)
        return partial(store.fail, caller, action_id, error)

    def _plan(self, client: LLMClient, call: _Call) -> _Planned:
        """The chain's planning call (P4): one call, the plan checked whole in the
        model's world (``check_plan``); never run here. Its time counts towards
        the request's (``CHAIN_TIME_LIMIT_S``), on the flow's clock."""
        started = self.monotonic()
        answer = ask(client, call.prompt.messages, call.prompt.schema, call.deadline)
        latency = round((self.monotonic() - started) * 1000)
        if not isinstance(answer, PlanAnswer):
            assert not isinstance(answer, QueryAnswer)  # parse_answer took the chain's kinds only
            return _Planned(answer, latency)
        checked = check_plan(answer.steps, call.context, call.profile)
        if isinstance(checked, Refusal):
            return _Planned(answer, latency, refusal=checked)
        steps = [new_step(call.level, step) for step in checked]
        return _Planned(answer, latency, steps, chain_governance(call.level, checked))

    @staticmethod
    def _keep(
        store: ModelActionStore, caller: Account, action_id: int, found: DirectAnswer | _Planned
    ) -> ModelActionView:
        answer, latency = found.answer, found.latency_ms
        if found.refusal is not None:
            return store.refuse(caller, action_id, found.refusal, answer=answer, latency_ms=latency)
        if isinstance(found, _Planned) and isinstance(answer, PlanAnswer):
            assert found.governance is not None and found.steps is not None
            return store.propose(
                caller,
                action_id,
                answer,
                query=None,
                governance=found.governance,
                latency_ms=latency,
                steps=found.steps,
            )
        if isinstance(answer, QueryAnswer) and isinstance(found, DirectAnswer):
            assert found.governance is not None  # a validated query has its governance
            return store.propose(
                caller,
                action_id,
                answer,
                query=found.query,
                governance=found.governance,
                latency_ms=latency,
            )
        assert isinstance(answer, Clarification | CannotAnswer)
        return store.answer(caller, action_id, answer, latency_ms=latency)

    @staticmethod
    def _settle(action_id: int, write: Callable[[], ModelActionView]) -> None:
        try:
            view = write()
        except ActionError as exc:
            # Aborted meanwhile: the compare-and-set lost, the late answer is dropped.
            log.info("model action %d: answer dropped (%s)", action_id, exc.code)
            return
        code = (view.refusal.code if view.refusal else None) or (view.error or {}).get("code")
        log.info("model action %d: %s%s", action_id, view.status, f" ({code})" if code else "")

    # --- the record (D4) ---------------------------------------------------------

    def get(self, caller: Account, action_id: int) -> ModelActionView:
        """Own records, an administrator's every record (D4); polled (P7)."""
        return self.store.get(caller, action_id)

    def decide(self, caller: Account, action_id: int, request: DecideRequest) -> ModelActionView:
        """The hand-over (P1); the store keeps its rules, ``proposal_only`` only
        for a proposal whose level had an ``off`` part (section 2, WP71)."""
        view = self.store.decide(
            caller,
            action_id,
            request.decision,
            applied_by_hand=request.applied_by_hand,
            applied_query=request.query,
        )
        log.info("model action %d: decided %s", action_id, view.decision)
        return view

    def abort(self, caller: Account, action_id: int) -> ModelActionView:
        """While the model thinks (M2.1): ``aborted``. A call not started yet never
        reaches the model; a running one ends by its deadline, its answer
        dropped, and holds the account's next prompt until then.

        A running chain (P4): the step that runs ends, no other starts; the
        record says so at once (``stop_reason`` ``aborted``, still ``running``)
        and ends ``limited`` at the run's next step, its last complete result
        adoptable. A chain halted for approval ends ``limited`` at once."""
        try:
            view = self.store.abort(caller, action_id)
        except ActionError as refused:
            if refused.code == "not_found":
                raise
            return self._abort_chain(caller, action_id, refused)
        self.calls.cancel(action_id)
        log.info("model action %d: aborted", action_id)
        return view

    def _abort_chain(
        self, caller: Account, action_id: int, refused: ActionError
    ) -> ModelActionView:
        try:
            chain = self.store.chain(caller, action_id, "abort")
        except ActionError:
            raise refused from None
        status = chain.view.status
        if status == "running" and self.calls.in_flight(caller.id) == action_id:
            # The run's event first: the run checks it before every step, the
            # store refuses its next step once the abort is written.
            self.calls.cancel(action_id)
            view = self.store.request_stop(caller, action_id)
            log.info("model action %d: abort asked, the run stops before its next step", action_id)
            return view
        started = any(step.status in RAN for step in chain.steps)
        waits = status in ("proposed", "approved")
        if status not in ("running", "proposed", "approved") or (waits and not started):
            raise refused  # a plan not started is rejected, not aborted
        # Halted for approval, approved at a halt and not run again, or running
        # without a run (it was given up): now.
        view_, profile = profile_for(self.backend, caller)
        context = ToolContext(view_, self.limits, self.unsupported)
        result, stamped = _adopted(chain.steps, context, profile)
        view = self.store.stop(caller, action_id, "aborted", stamped, result=result)
        log.info("model action %d: aborted, limited", action_id)
        return view

    # --- the tool chain (P4, WP75) -------------------------------------------------

    def edit_plan(self, caller: Account, action_id: int, edit: PlanEdit) -> ModelActionView:
        """Change values, remove steps, never add one (design M8.3, decision 17):
        only a chain that waits for approval and has not started, never a
        proposal-only one (D1). The plan as it then stands is checked whole, in
        the model's world as it is now (``check_plan``), and governed again by
        the level as it was; an approval cannot carry over, since only a
        ``proposed`` chain is edited. Refusals answer 422 with the code of the
        check, ``invalid_query`` for the edit itself, naming the step."""
        self.store.ready(caller, action_id, "plan", ["proposed"])
        chain = self.store.chain(caller, action_id, "plan")
        if any(step.status not in ("planned", "removed") for step in chain.steps):
            raise ActionError(
                "not_approved",
                f"Model action {action_id} has started; its plan stays as it ran.",
                http_status=409,
                id=action_id,
                status=chain.view.status,
            )
        changes = {change.position: change.arguments for change in edit.change}
        if len(changes) != len(edit.change):
            raise _edit_refused(
                Refusal(code="invalid_query", message="A step is changed once per edit.")
            )
        live = [
            Placed(s.position, PlannedStep(text=s.text, tool=s.tool, arguments=s.arguments))
            for s in chain.steps
            if s.status != "removed"
        ]
        edited = edit_plan(live, changes, set(edit.remove))
        if isinstance(edited, Refusal):
            raise _edit_refused(edited)
        view, profile = profile_for(self.backend, caller)
        context = ToolContext(view, self.limits, self.unsupported)
        checked = check_plan(
            [p.step for p in edited], context, profile, positions=[p.position for p in edited]
        )
        if isinstance(checked, Refusal):
            raise _edit_refused(checked)
        level = _snapshot_level(chain.view)
        by_position = {step.position: step for step in checked}
        steps = [
            new_step(
                level,
                by_position[s.position],
                status="planned",
                edited=s.edited or s.position in changes,
            )
            if s.position in by_position
            else replace(s, status="removed")
            for s in chain.steps
        ]
        result = self.store.edit_plan(caller, action_id, steps, chain_governance(level, checked))
        log.info(
            "model action %d: plan edited, %d changed, %d removed",
            action_id,
            len(changes),
            len(set(edit.remove)),
        )
        return result

    def run(self, caller: Account, action_id: int) -> ModelActionView:
        """Start an approved chain's steps, or go on after a halt (P4): 202 at
        once, the steps in a thread of ``ModelCalls``. Only an ``approved``
        chain of the caller's with no ``off`` class (``not_approved``,
        ``class_not_allowed``); one run of an account at a time, a run counted
        among the model calls (409, 503 ``busy``)."""
        ready = self.store.ready(caller, action_id, "run", ["approved"])
        if ready.approach != "chain":
            raise ActionError(
                "not_approved",
                f"Model action {action_id} is a direct query: it is executed, not run.",
                http_status=409,
                id=action_id,
                status=ready.status,
            )
        in_flight = self.calls.in_flight(caller.id)
        if in_flight is not None:
            raise _busy(in_flight)
        self.calls.take()
        try:
            with self.calls.admission:
                in_flight = self.calls.in_flight(caller.id)
                if in_flight is not None:
                    raise _busy(in_flight)
                view = self.store.run(caller, action_id)
                chain = self.store.chain(caller, action_id, "run")
                expiry = time.monotonic() + self._run_budget(view, chain.run_ms)
                try:
                    self.calls.start(
                        caller.id,
                        action_id,
                        partial(self._run, caller, action_id),
                        deadline=expiry,
                        expire=partial(self._run_expired, caller, action_id),
                    )
                except BaseException:
                    self._stop_quietly(caller, action_id, "interrupted")
                    raise
        except BaseException:
            self.calls.give_back()
            raise
        log.info("model action %d: run", action_id)
        return view

    def _run_budget(self, view: ModelActionView, run_ms: int) -> float:
        """Seconds until a run is given up (``ModelCalls``, which adds its grace):
        what the request has left, and two step limits on top, for the step
        that runs at the deadline and the stamp of the result after it."""
        left = CHAIN_TIME_LIMIT_S - ((view.latency_ms or 0) + run_ms) / 1000
        return max(left, 0) + 2 * self.limits.timeout_s

    def _run(self, caller: Account, action_id: int, cancel: threading.Event) -> None:
        """The run in its thread. Never raises; gives the slot back."""
        try:
            _Runner.start(self, caller, action_id, cancel)
        except ActionError as exc:
            # A write found the record moved on (given up at its deadline): it
            # is closed already.
            log.info("model action %d: run ended (%s)", action_id, exc.code)
        except Exception as exc:
            log.error("model action %d: the run failed (%s)", action_id, type(exc).__name__)
            self._stop_quietly(caller, action_id, "interrupted")
        finally:
            self.calls.finish(caller.id, action_id)

    def _run_expired(self, caller: Account, action_id: int) -> None:
        """The run outlived the request's deadline and was given up (``ModelCalls``):
        ``limited``/``time_limit``; the run, should it go on, finds it closed."""
        self.calls.cancel(action_id)
        self._stop_quietly(caller, action_id, "time_limit")

    def _stop_quietly(self, caller: Account, action_id: int, reason: StopReason) -> None:
        """Best effort, without the engine: a record left ``running`` would hold
        nothing, but say it runs; its last complete result stays, unstamped."""
        try:
            chain = self.store.chain(caller, action_id, "run")
            if chain.view.status != "running":
                return
            error = None
            if reason == "interrupted":
                error = _error("internal_error", "The run stopped unexpectedly.")
            result = last_complete(chain.steps, self.limits.max_features)
            self.store.stop(caller, action_id, reason, result=result, error=error)
        except Exception as exc:
            log.error("model action %d: not closed (%s)", action_id, type(exc).__name__)

    def adopt(self, caller: Account, action_id: int) -> ExecuteResponse:
        """A ``done`` or ``limited`` chain's result becomes the analysis (design
        "Kette übernehmen"): the record's query, the last complete step that is
        no buffer, as one query object; run as the caller (visibility, limits)
        as ``execute`` runs a direct answer, the stamp kept, the rows to the
        user only. ``accepted`` at every level: the user chose to adopt it.
        Claimed once, as ``execute`` is."""
        self.store.ready(caller, action_id, "adopt", ["done", "limited"])
        if not self.calls.claim(action_id):
            raise ActionError(
                "already_decided",
                f"Model action {action_id} is being adopted already.",
                http_status=409,
                id=action_id,
                status="done",
            )
        try:
            ready = self.store.ready(caller, action_id, "adopt", ["done", "limited"])
            if ready.approach != "chain":
                raise _not_runnable(ready, "adopt")
            query = _stored(ready, "adopt", chain=True)
            visible = read_view(self.backend, caller)
            result = run_query(query, visible, self.limits, self.unsupported)
            view = self.store.adopt(caller, action_id, stamp_of(result))
        finally:
            self.calls.release(action_id)
        log.info("model action %d: adopted, %d features", action_id, result.meta.feature_count)
        return ExecuteResponse(action=view, result=result)

    # --- the comparison (P7, WP76, design M10) ------------------------------------

    def compare(self, caller: Account, action_id: int) -> ModelActionView:
        """Ask the same prompt again with the other approach (M10.1): a new
        record that repeats ``action_id`` (``compare_of``), through the prompt
        flow as any prompt goes, and so with the account's level and connection
        as they are now, never the record's (H6, C17): a level taken from the
        user since, or a connection disabled, is not used again by a repeat.
        Its request counts towards the request limit, and it is the account's
        one prompt at a time. The record compared stays as it is (no
        supersede): it is the left side. Only the caller's own record with a
        result to compare: a direct query with its query, a chain that ended
        with a result; none with an ``off`` class (``ready``), whose query is
        not run for the user (P2)."""
        original = self.store.ready(caller, action_id, "compare", COMPARABLE)
        if original.query is None:
            raise _not_runnable(original, "compare", "has no result to compare")
        request = PromptRequest(
            text=original.prompt,
            approach="chain" if original.approach == "direct" else "direct",
            parent_action_id=original.parent_action_id,
        )
        view = self._ask_model(caller, request, compare_of=original.id)
        log.info("model action %d: compares %d", view.id, original.id)
        return view

    def comparison(self, caller: Account, action_id: int) -> Comparison:
        """Both sides once each has a result (M10.2, M10.3): their stamps and the
        difference by feature ids, computed here from both stored queries run
        as the caller (visibility, the result-size limit, one time limit for
        all its reads), never by the model, which is not called. Names from
        each layer's name attribute, read as the caller; the reason only where
        the two queries say it (``compare.reason``). Changes nothing: taking a
        side is that record's own ``execute`` or ``adopt``, under its own level."""
        left, right = self.store.compared(caller, action_id)
        queries = _compared(left), _compared(right)
        view = read_view(self.backend, caller)
        budget = self.limits.timeout_s
        deadline = time.monotonic() + budget

        def limits() -> Limits:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise QueryTimedOut(
                    f"The comparison took longer than {budget:g} s and was stopped.",
                    timeout_s=budget,
                )
            return replace(self.limits, timeout_s=remaining)

        found = []
        for query in queries:
            ids, stamped = stamped_ids(query, view, limits(), self.unsupported)
            if len(ids) > self.limits.max_features:
                raise ResultTooLarge(
                    f"The result exceeds {self.limits.max_features} features.",
                    max_features=self.limits.max_features,
                )
            found.append(({(query.source, i) for i in ids}, stamped))
        (left_ids, left_stamp), (right_ids, right_stamp) = found
        labels = Labels.of(list_layers(self.backend.engine, view.layer_names()))
        names = _names(left_ids ^ right_ids, labels, view, limits)
        refs = [
            [FeatureRef(id=i, name=names.get((layer, i))) for layer, i in sorted(only)]
            for only in (left_ids - right_ids, right_ids - left_ids)
        ]
        differ = left_ids != right_ids
        why = reason(*queries, (left.approach, right.approach), labels) if differ else None
        log.info("model action %d: compared with %d", right.id, left.id)
        return Comparison(
            left_action_id=left.id,
            right_action_id=right.id,
            left=left_stamp,
            right=right_stamp,
            only_left=refs[0],
            only_right=refs[1],
            reason=why,
        )

    # --- what a chain's re-plan asks with (P4) ------------------------------------

    def _chain_prompt(
        self, caller: Account, chain: Chain, profile: ModelProfile
    ) -> tuple[Prompt, Level]:
        """The planning prompt again, for a re-plan: the record's text and
        thread, the level as it was (H7: its matrix and its system prompt as
        the record keeps them, never the level's now), the profile at run time,
        what the model may see now. No size check here: the re-plan's own
        (``fit``)."""
        view = chain.view
        level = _snapshot_level(view, chain.level_prompt)
        follow_up = None
        if view.parent_action_id is not None:
            try:
                thread = self.store.thread(caller, view.parent_action_id, MAX_TURNS)
            except ActionError:  # the parent is gone: no turns
                thread = []
            follow_up = FollowUp(turns=turns_of(thread))
        prompt = build_prompt(
            view.prompt, approach="chain", level=level, profile=profile, follow_up=follow_up
        )
        return prompt, level

    def _replan_endpoint(
        self, caller: Account, view: ModelActionView
    ) -> tuple[Endpoint, int | None] | None:
        """The connection the record names, read once with its endpoint (C14,
        security review #28), and only while it is enabled, still the account's
        and still what the record says it is (H7): the same host and locality.
        Its endpoint and context length; ``None`` otherwise."""
        active = self.connections.active_call(caller.id)
        if active is None:
            return None
        connection, endpoint = active
        snapshot = view.connection
        same = (connection.id, connection.host, connection.locality) == (
            snapshot.id,
            snapshot.host,
            snapshot.locality,
        )
        return (endpoint, connection.context_length) if same else None

    # --- enforcement (D2, P2, WP70) ----------------------------------------------

    def approve(self, caller: Account, action_id: int) -> ModelActionView:
        """``proposed`` to ``approved``; ``class_not_allowed`` for an ``off`` class
        at the level as it was (D1, M7.3)."""
        view = self.store.approve(caller, action_id)
        log.info("model action %d: approved", action_id)
        return view

    def reject(self, caller: Account, action_id: int, request: RejectRequest) -> ModelActionView:
        view = self.store.reject(caller, action_id, request.reason)
        log.info("model action %d: rejected (%s)", action_id, request.reason or "no reason")
        return view

    def execute(self, caller: Account, action_id: int) -> ExecuteResponse:
        """Run the stored query (D2): only an ``approved`` record of the caller's,
        as the caller (visibility, limits); the stamp is kept, the rows go to the
        user only. The decision is ``auto`` when nobody was asked, else
        ``accepted``. A refused step runs nothing; a replay is ``already_decided``,
        and so is an ``execute`` while another of the same action runs: the
        action is claimed (``ModelCalls.claim``), so its query runs once. The
        record is checked before the claim (another account's is ``not_found``,
        never "busy") and again under it (one executed meanwhile runs nothing)."""
        self.store.ready(caller, action_id, "execute", ["approved"])
        if not self.calls.claim(action_id):
            raise ActionError(
                "already_decided",
                f"Model action {action_id} is being executed already.",
                http_status=409,
                id=action_id,
                status="approved",
            )
        try:
            ready = self.store.ready(caller, action_id, "execute", ["approved"])
            query = _stored(ready, "execute")
            visible = read_view(self.backend, caller)
            result = run_query(query, visible, self.limits, self.unsupported)
            view = self.store.execute(caller, action_id, stamp_of(result))
        finally:
            self.calls.release(action_id)
        log.info(
            "model action %d: executed (%s), %d features",
            action_id,
            view.decision,
            result.meta.feature_count,
        )
        return ExecuteResponse(action=view, result=result)

    def preview(self, caller: Account, action_id: int) -> ActionPreview:
        """Hits, the result layer's total and the hits' ids of the stored query, as
        the caller (P2): for the user's dashed preview, never for the model.
        Only while the record waits (``proposed``, ``approved``) and has no
        class ``off``; ``previewed_at`` is set, the status stays. Both counts
        share one time limit, as ``/api/query/count`` does."""
        ready = self.store.ready(caller, action_id, "preview", ["proposed", "approved"])
        query = _stored(ready, "preview")
        view = read_view(self.backend, caller)
        budget = self.limits.timeout_s
        deadline = time.monotonic() + budget
        ids = ids_query(query, view, self.limits, self.unsupported)
        left = deadline - time.monotonic()
        if left <= 0:
            raise QueryTimedOut(
                f"The preview took longer than {budget:g} s and was stopped.", timeout_s=budget
            )
        whole = QueryObject(source=query.source)
        total = count_query(whole, view, replace(self.limits, timeout_s=left), self.unsupported)
        self.store.mark_previewed(caller, action_id)
        log.info("model action %d: previewed", action_id)
        return ActionPreview(count=len(ids), total=total, ids=ids)

    def undo(self, caller: Account, action_id: int) -> ModelActionView:
        """For the log (D2): the account's last change made by the model, while no
        hand edit followed it (``undo_blocked``)."""
        view = self.store.undo(caller, action_id)
        log.info("model action %d: undone", action_id)
        return view

    def touched(self, caller: Account, action_id: int) -> ModelActionView:
        """The client edited the analysis by hand after this applied action."""
        view = self.store.touch(caller, action_id)
        log.info("model action %d: edited by hand after it", action_id)
        return view


def _not_runnable(
    view: ModelActionView, step: str, why: str = "has no query to run"
) -> ActionError:
    return ActionError(
        "not_approved",
        f"Model action {view.id} {why}; '{step}' does not apply.",
        http_status=409,
        id=view.id,
        status=view.status,
    )


COMPARABLE: Final = ("proposed", "approved", "applied", "done", "limited")
"""Statuses of a record that may have a result to compare (design M10.1: an
answer waiting or applied, a chain that ended); its query decides."""


def _compared(view: ModelActionView) -> QueryObject:
    """A side's query to compare: there once it has a result, not while the
    model thinks or a chain waits or runs (409)."""
    if view.query is None:
        raise _not_runnable(view, "comparison", "has no result to compare yet")
    return view.query


def _names(
    features: set[tuple[str, int]],
    labels: Labels,
    view: DataBackend,
    limits: Callable[[], Limits],
) -> dict[tuple[str, int], str]:
    """The names of ``features`` (layer, id) from their layer's name attribute
    (``compare.name_attribute``), read through the caller's ``view``; a layer
    without one names none."""
    found = {}
    for layer in sorted({layer for layer, _ in features}):
        attribute = name_attribute(labels.layers.get(layer))
        if attribute is None:
            continue
        ids = [i for source, i in features if source == layer]
        for i, value in values_of(layer, attribute, ids, view, limits()).items():
            if value is not None:
                found[(layer, i)] = str(value)
    return found


def _stored(view: ModelActionView, step: str, *, chain: bool = False) -> QueryObject:
    """The query the record keeps. A chain's is its result, there once its run
    ended, and only ``adopt`` runs it (``chain``): its approval may cover the
    next step only, so neither ``execute`` nor the preview runs a chain."""
    if (view.approach == "chain") != chain:
        why = "is a tool chain: its steps run ('run')" if not chain else "is no tool chain"
        raise _not_runnable(view, step, why)
    if view.query is None:
        why = "has no complete result to adopt" if chain else "has no query of its own"
        raise _not_runnable(view, step, why)
    return view.query


def _edit_refused(refusal: Refusal) -> ActionError:
    """An edited plan refused (design M8.3): 422 with the check's code."""
    return ActionError(refusal.code, refusal.message, http_status=422, **refusal.details)


@dataclass
class _Runner:
    """One stretch of a chain's run (P4): from ``run`` to its end, a halt for
    approval, or a stop. Built from the record each time, so a run goes on
    after a halt as it would have: the steps and their views, the re-plans
    and the conversation are the record's. Every write is a compare-and-set
    on ``running``: a record closed meanwhile (given up at its deadline)
    ends the run with ``ActionError``."""

    flow: PromptFlow
    caller: Account
    action_id: int
    cancel: threading.Event
    """Set by ``abort``: the step that runs ends, no other starts."""
    view: ModelActionView
    context: ToolContext
    profile: ModelProfile
    level: Level
    state: ChainState
    stored: dict[int, ChainStep]
    """The steps by position as the record has them, kept as the run writes them."""
    run_ms: int
    started: float
    deadline: float

    @classmethod
    def start(
        cls, flow: PromptFlow, caller: Account, action_id: int, cancel: threading.Event
    ) -> None:
        chain = flow.store.chain(caller, action_id, "run")
        if chain.view.status != "running":
            return
        # The view and the profile as they are now: a step validates at run time.
        view, profile = profile_for(flow.backend, caller)
        context = ToolContext(view, flow.limits, flow.unsupported)
        prompt, level = flow._chain_prompt(caller, chain, profile)
        answer = chain.view.answer
        assert isinstance(answer, PlanAnswer)  # a chain's record keeps its plan
        steps = chain.steps
        ran = [s for s in steps if s.status in RAN]
        live = [s for s in steps if s.status in (*COMPLETE, "planned", "waiting")]
        seen = {}
        for step in ran:
            shown = restored(step.view)
            assert shown is not None  # a step that ran keeps its view
            seen[step.position] = (step.tool, shown)
        edits = None
        if chain.view.replans == 0:
            removed = [s.position for s in steps if s.status == "removed"]
            changed = [(s.position, s.arguments) for s in live if s.edited]
            edits = edits_message(removed, changed) if removed or changed else None
        turns, asked_with = restored_turns(chain.turns)
        state = ChainState(
            prompt,
            answer,
            [_checked(s) for s in live],
            seen=seen,
            completed=sum(1 for s in live if s.status in COMPLETE),
            replans=chain.view.replans,
            turns=turns,
            spent=len(ran),
            last=max((s.position for s in ran), default=0),
            edits=edits,
            profile_hash=profile.hash,
            asked_with=asked_with,
        )
        started = flow.monotonic()
        worked_ms = (chain.view.latency_ms or 0) + chain.run_ms
        runner = cls(
            flow,
            caller,
            action_id,
            cancel,
            chain.view,
            context,
            profile,
            level,
            state,
            {s.position: s for s in steps},
            chain.run_ms,
            started,
            started + CHAIN_TIME_LIMIT_S - worked_ms / 1000,
        )
        runner.go()

    @property
    def store(self) -> ModelActionStore:
        return self.flow.store

    def ms(self) -> int:
        """The run time so far, this stretch's included."""
        return self.run_ms + round((self.flow.monotonic() - self.started) * 1000)

    def late(self) -> bool:
        return self.flow.monotonic() >= self.deadline

    def go(self) -> None:
        state = self.state
        while (step := state.next) is not None:
            if self.cancel.is_set():
                return self.stop("aborted")
            if self.late():
                return self.stop("time_limit", self.too_late(step.position))
            stored = self.stored[step.position]
            # Only an auto step runs unasked; an off one never (D1).
            if stored.cell is not CellMode.AUTO and not stored.approved:
                return self.halt(step.position)
            if not self.run(step):
                return None
            after = state.ran(step, self.state_view(step.position))
            if after == "done":
                return self.finish()
            if after == "stopped":
                return self.stop("replan_limit")
            if after == "replan" and not self.replan():
                return None
        return self.finish()

    def state_view(self, position: int) -> ModelView:
        """What the model saw of the step, as the record keeps it."""
        shown = restored(self.stored[position].view)
        assert shown is not None
        return shown

    def run(self, step: CheckedStep) -> bool:
        """One step, counted; ``False`` when the run stopped at it."""
        position = step.position
        try:
            self.store.step_started(self.caller, self.action_id, position, run_ms=self.ms())
        except ActionError:
            self.stop("aborted")  # aborted meanwhile: the step does not start
            return False
        last = position == self.state.steps[-1].position
        run = run_step(step, self.context, self.profile, last=last)
        status: StepStatus = "error" if run.error else "empty" if run.count == 0 else "ok"
        shown = run.view.model_dump(mode="json", exclude_none=True)
        self.store.step_ran(
            self.caller,
            self.action_id,
            position,
            status=status,
            count=run.count,
            view=shown,
            duration_ms=run.duration_ms,
            run_ms=self.ms(),
        )
        self.stored[position] = replace(
            self.stored[position],
            status=status,
            count=run.count,
            view=shown,
            duration_ms=run.duration_ms,
        )
        log.info("model action %d: step %d %s", self.action_id, position, status)
        if isinstance(run.error, ResultTooLarge):
            limit = self.context.limits.max_features
            error = _error(
                "result_too_large",
                f"The result has more than {limit} features.",
                step=position,
                value=run.error.details.get("count"),
                max=limit,
            )
            self.stop("result_too_large", error)
            return False
        return True

    def too_late(self, position: int) -> dict[str, Any]:
        worked = (self.view.latency_ms or 0) / 1000 + self.ms() / 1000
        return _error(
            "time_limit",
            f"The chain ran longer than {CHAIN_TIME_LIMIT_S} s and was stopped.",
            step=position,
            value=round(worked),
            max=CHAIN_TIME_LIMIT_S,
        )

    def replan(self) -> bool:
        """A re-plan after an error or an empty step before the last (P4);
        ``True`` when the run goes on with its steps."""
        state = self.state
        if self.cancel.is_set():
            self.stop("aborted")
            return False
        if self.late():
            self.stop("time_limit", self.too_late(state.last + 1))
            return False
        found = self.flow._replan_endpoint(self.caller, self.view)
        if found is None:
            message = "The model connection of this chain is disabled or changed since its plan."
            error = _error("connection_not_available", message, reason="changed")
            self.stop("replan_limit", error)
            return False
        endpoint, state.context_length = found
        timeout_s = min(endpoint.timeout_s, MODEL_CALL_S)
        try:
            messages = state.replan_messages()
            deadline = min(self.deadline, self.flow.monotonic() + timeout_s)
            client = self.flow.client_factory(replace(endpoint, timeout_s=timeout_s))
            try:
                answer = ask(client, messages, state.prompt.schema, deadline)
            finally:
                client.close()
        except LLMError as exc:
            if self.late():
                self.stop("time_limit", self.too_late(state.last + 1))
            else:
                self.stop("replan_limit", _error(exc.code, exc.message, cause=exc.cause))
            return False
        except ActionError as exc:  # context_too_large, model_unreadable
            self.stop("replan_limit", _error(exc.code, exc.message, **exc.details))
            return False
        if self.cancel.is_set():
            self.stop("aborted")
            return False
        log.info("model action %d: re-planned (%d)", self.action_id, state.replans)
        if not isinstance(answer, PlanAnswer):
            self.stop("replan_limit")
            return False
        refused = state.revise(answer, self.context, self.profile)
        if refused is not None:
            if refused.code == "step_limit":
                details = refused.details
                error = _error(
                    "step_limit",
                    refused.message,
                    step=details["step"],
                    value=details["value"],
                    max=MAX_STEPS,
                )
                self.stop("step_limit", error)
            else:
                self.stop("replan_limit", _error(refused.code, refused.message, **refused.details))
            return False
        return self.revised()

    def revised(self) -> bool:
        """The re-plan's steps stored, governed by the level as it was, for the
        whole chain (the union of the classes of the steps that ran and the new
        ones, D1): a new step of an ``off`` class stops the run; approval is
        asked again where the level wants it (P4)."""
        state = self.state
        new = state.remaining
        ran = [s for s in self.stored.values() if s.status in RAN]
        classes = frozenset[OpClass]().union(*(s.classes for s in ran), *(s.classes for s in new))
        rules = governance(self.level, classes)
        if rules.off:
            off = rules.off[0]
            position = next(s.position for s in new if off in s.classes)
            message = f"Step {position} of the re-plan: the level does not allow '{off}'."
            self.stop("replan_limit", _error("class_not_allowed", message, part=off, step=position))
            return False
        steps = [new_step(self.level, s, revised=True) for s in new]
        try:
            self.store.revise(
                self.caller,
                self.action_id,
                after=state.last,
                steps=steps,
                governance=rules,
                replans=state.replans,
                turns=kept_turns(state),
                run_ms=self.ms(),
            )
        except ActionError:
            self.stop("aborted")  # aborted meanwhile: the re-plan's steps do not come in
            return False
        kept = {p: s for p, s in self.stored.items() if p <= state.last or s.status in RAN}
        self.stored = kept | {s.position: s for s in steps}
        # One approval for the whole plan as it now stands, as ``approve`` decides.
        plan = [s.cell for s in self.stored.values() if s.status != "removed"]
        if one_approval(plan):
            self.halt(None)
            return False
        return True

    def halt(self, waiting: int | None) -> None:
        """Wait for approval (P4, design M9.2): before ``waiting``, or the re-plan
        as a whole. An abort that came meanwhile stops the run instead."""
        try:
            self.store.halt(
                self.caller,
                self.action_id,
                waiting=waiting,
                run_ms=self.ms(),
                replans=self.state.replans,
                turns=kept_turns(self.state),
            )
        except ActionError:
            self.stop("aborted")
            return
        log.info("model action %d: halted for approval", self.action_id)

    def adopted(self) -> tuple[ChainStep | None, ResultStamp | None]:
        """The result to offer, stamped; nothing is stamped for a record that
        moved on meanwhile (given up at its deadline, closed at a restart)."""
        if self.store.chain(self.caller, self.action_id, "run").view.status != "running":
            raise ActionError(
                "not_approved",
                f"Model action {self.action_id} is no longer running.",
                http_status=409,
                id=self.action_id,
            )
        return _adopted([self.stored[p] for p in sorted(self.stored)], self.context, self.profile)

    def finish(self) -> None:
        result, stamp = self.adopted()
        self.store.finish(self.caller, self.action_id, stamp, result=result, run_ms=self.ms())
        log.info("model action %d: done", self.action_id)

    def stop(self, reason: StopReason, error: dict[str, Any] | None = None) -> None:
        result, stamp = self.adopted()
        self.store.stop(
            self.caller,
            self.action_id,
            reason,
            stamp,
            result=result,
            error=error,
            run_ms=self.ms(),
            replans=self.state.replans,
            turns=kept_turns(self.state),
        )
        log.info("model action %d: limited (%s)", self.action_id, reason)
