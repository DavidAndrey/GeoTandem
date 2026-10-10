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
cancelled: it ends by its deadline, and until then the account's next prompt
waits (409).

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
from geotandem.auth.visibility import view_for
from geotandem.catalog import ModelProfile, model_profile
from geotandem.connections import ConnectionInfo, ConnectionProblem, Connections
from geotandem.data import DataBackend, Limits, Op
from geotandem.db.orm import ModelAction
from geotandem.engine import count_query, ids_query, run_query, stamp_of
from geotandem.engine.errors import QueryTimedOut
from geotandem.levels import Level, active_level
from geotandem.llm import ClientFactory, Endpoint, LLMError
from geotandem.model.direct import DirectAnswer, DirectQuery, direct_prompt
from geotandem.model.errors import ActionError
from geotandem.model.prompt import FollowUp, Prompt, Turn
from geotandem.model.record import (
    ModelActionStore,
    NewAction,
    connection_snapshot,
    level_snapshot,
    utc_now,
)
from geotandem.model.schemas import (
    MAX_TURNS,
    ActionPreview,
    DecideRequest,
    ExecuteResponse,
    ModelActionView,
    PromptRequest,
    QueryAnswer,
    RejectRequest,
)
from geotandem.tools import ToolContext
from geotandem_query import QueryObject

log = logging.getLogger(__name__)

MODEL_CALL_S: Final = 120
"""The model call's time limit (plan 1, fixture ``limits.model_call_s``); also
how long an ``auto`` answer waits to be executed before the start-up check
closes it. The frontend's timer repeats it (``panel/state.ts``); a test on
each side holds it to the fixture."""
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


def close_stale(engine: Engine, clock: Callable[[], datetime] = utc_now) -> list[int]:
    """The start-up check (P7): nothing in flight survives a restart of the one
    process, so every ``thinking`` record ends ``failed``; an unexecuted ``auto``
    answer older than ``MODEL_CALL_S`` is closed too."""
    return ModelActionStore(engine, clock).close_stale(clock() - timedelta(seconds=MODEL_CALL_S))


def profile_for(backend: DataBackend, account: Account) -> tuple[DataBackend, ModelProfile]:
    """The account's view and the layer profile its model gets over it (S3):
    what it sees and the administrator released for the model."""
    view = view_for(backend, account)
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
    has ended. One per application (``AppState``)."""

    def __init__(self, size: int) -> None:
        self.admission = threading.Lock()
        """Held around the checks of a new record and its creation, so two
        prompts never both pass (P5, one prompt at a time per account)."""
        self._executor = ThreadPoolExecutor(max_workers=size, thread_name_prefix="model-call")
        self._slots = threading.BoundedSemaphore(size)
        self._lock = threading.Lock()
        self._cancel: dict[int, threading.Event] = {}
        self._accounts: dict[int, int] = {}
        """Account id → the action whose call it has in flight."""
        self._running: set[Future[None]] = set()

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
        self, account_id: int, action_id: int, call: Callable[[threading.Event], None]
    ) -> None:
        """Run ``call`` with the action's cancel event; it calls ``finish``."""
        cancel = threading.Event()
        with self._lock:
            self._cancel[action_id] = cancel
            self._accounts[account_id] = action_id
        try:
            future = self._executor.submit(call, cancel)
        except BaseException:
            self._forget(account_id, action_id)
            raise
        with self._lock:
            self._running.add(future)
        future.add_done_callback(self._done)

    def _done(self, future: Future[None]) -> None:
        with self._lock:
            self._running.discard(future)

    def _forget(self, account_id: int, action_id: int) -> None:
        with self._lock:
            self._cancel.pop(action_id, None)
            if self._accounts.get(account_id) == action_id:
                del self._accounts[account_id]

    def finish(self, account_id: int, action_id: int) -> None:
        """The call of ``action_id`` ended: forget it, give its slot back."""
        self._forget(account_id, action_id)
        self.give_back()

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
        self._executor.shutdown(wait=False, cancel_futures=True)


@dataclass(frozen=True)
class _Call:
    """What the call needs, resolved while the request was checked."""

    endpoint: Endpoint = field(repr=False)
    deadline: float
    """``time.monotonic()`` by which the call ends, retries included."""
    context: ToolContext
    level: Level
    prompt: Prompt = field(repr=False)
    profile: ModelProfile = field(repr=False)


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

    @property
    def store(self) -> ModelActionStore:
        return ModelActionStore(self.backend.engine, self.clock)

    # --- the prompt (P7) ---------------------------------------------------------

    def prompt(self, caller: Account, request: PromptRequest) -> ModelActionView:
        """Check, record ``thinking``, start the call; the record as it is now."""
        if request.approach != "direct":
            raise ValueError("the tool chain arrives with WP75")
        level = active_level(self.backend.engine, caller.id, admin=caller.role == "admin")
        connection = self.connections.active(caller.id)
        if connection is None:
            raise ConnectionProblem(
                409,
                "connection_not_available",
                "No model connection is set up for this account.",
                reason="none",
            )
        view, profile = profile_for(self.backend, caller)
        follow_up = None
        if request.parent_action_id is not None:
            # Own records only, 404 otherwise; reference and analysis arrive with WP81.
            thread = self.store.thread(caller, request.parent_action_id, MAX_TURNS)
            follow_up = FollowUp(turns=turns_of(thread))
        prompt = direct_prompt(
            request.text,
            level=level,
            profile=profile,
            follow_up=follow_up,
            context_length=connection.context_length,
        )
        endpoint = self.connections.endpoint(connection.id)
        timeout_s = min(endpoint.timeout_s, MODEL_CALL_S)
        call = _Call(
            endpoint=replace(endpoint, timeout_s=timeout_s),
            deadline=time.monotonic() + timeout_s,
            context=ToolContext(view, self.limits, self.unsupported),
            level=level,
            prompt=prompt,
            profile=profile,
        )
        new = NewAction(
            prompt=request.text,
            approach="direct",
            level=level_snapshot(level),
            connection=connection_snapshot(connection),
            profile_hash=profile.hash,
            parent_action_id=request.parent_action_id,
        )
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
                    caller, new, admit=partial(self._admit, caller=caller, connection=connection)
                )
                answer = partial(self._answer, caller, action.id, call)
                self.calls.start(caller.id, action.id, answer)
        except BaseException:
            self.calls.give_back()
            raise
        log.info(
            "model action %d asked: connection %d, level %d, profile %s",
            action.id,
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
        try:
            client = self.client_factory(call.endpoint)
            try:
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

    @staticmethod
    def _keep(
        store: ModelActionStore, caller: Account, action_id: int, found: DirectAnswer
    ) -> ModelActionView:
        answer, latency = found.answer, found.latency_ms
        if found.refusal is not None:
            return store.refuse(caller, action_id, found.refusal, answer=answer, latency_ms=latency)
        if isinstance(answer, QueryAnswer):
            assert found.governance is not None  # a validated query has its governance
            return store.propose(
                caller,
                action_id,
                answer,
                query=found.query,
                governance=found.governance,
                latency_ms=latency,
            )
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
        """The hand-over (P1); the store keeps its rules."""
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
        dropped, and holds the account's next prompt until then."""
        view = self.store.abort(caller, action_id)
        self.calls.cancel(action_id)
        log.info("model action %d: aborted", action_id)
        return view

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
        ``accepted``. A refused step runs nothing; a replay is ``already_decided``."""
        ready = self.store.ready(caller, action_id, "execute", ["approved"])
        query = _stored(ready, "execute")
        result = run_query(query, view_for(self.backend, caller), self.limits, self.unsupported)
        view = self.store.execute(caller, action_id, stamp_of(result))
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
        view = view_for(self.backend, caller)
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


def _stored(view: ModelActionView, step: str) -> QueryObject:
    """The query the record keeps; a chain's result has its own steps (WP75)."""
    if view.query is None:
        raise ActionError(
            "not_approved",
            f"Model action {view.id} has no query of its own; '{step}' does not apply.",
            http_status=409,
            id=view.id,
            status=view.status,
        )
    return view.query
