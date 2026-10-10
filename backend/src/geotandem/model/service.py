"""The prompt flow of the direct query, proposal-only (plan E2.3-E2.6, WP65).

``POST /api/model/prompt`` in steps, everything that can refuse the request
first, so a refused request leaves no record and reaches no model:

1. level and connection are the account's, resolved here on every request
   (H6, C17); no connection ⇒ ``connection_not_available``;
2. the connection's request limit, when the administrator switched it on
   (P5): the requests of the current calendar day (the server's time zone)
   are counted from the action table, over all accounts ⇒ ``quota_exceeded``;
3. the account's layer profile, built once: the record keeps its hash (S4) and
   the model gets exactly it;
4. the prompt's size against the connection's context length ⇒
   ``context_too_large`` (400, no record, as the contract fixture says);
5. the record, ``thinking``, created with ``proposal_only``: in E2.3 every
   level only proposes (P1). Creating it closes the account's open proposal.

The model call then runs after the answer (P7), in ``Asked.run``: the route
hands it to FastAPI's background tasks, which run it in the worker threads of
the one uvicorn process once the 202 has left. Its outcome is stored as one
edge out of ``thinking``: ``refused``, ``answered``, ``proposed``, or ``failed``
with the seam's ``llm_*`` code or ``model_unreadable``. The store writes it as
a compare-and-set, so an answer arriving after an abort finds the record moved
on and is dropped. The HTTP call itself is not cancelled: it ends with its
own timeout, and nothing of it is kept.

A follow-up (P6) is linked to its parent, which must be the caller's own
record (404 otherwise). Its turns and the derived reference arrive with WP81;
until then the model gets no follow-up context and ``reference`` stays
``none``, and the sent ``analysis`` is not used.

Logs carry ids and codes only, never the prompt or the answer (C15).
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
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
from geotandem.db.spatialite import reading
from geotandem.levels import Level, active_level
from geotandem.llm import ClientFactory, Endpoint, LLMError
from geotandem.model.direct import DirectAnswer, DirectQuery
from geotandem.model.errors import ActionError
from geotandem.model.prompt import build_prompt
from geotandem.model.record import (
    ModelActionStore,
    NewAction,
    connection_snapshot,
    level_snapshot,
)
from geotandem.model.schemas import DecideRequest, ModelActionView, PromptRequest, QueryAnswer
from geotandem.tools import ToolContext

log = logging.getLogger(__name__)

MODEL_CALL_S: Final = 120
"""The model call's time limit (plan 1, fixture ``limits.model_call_s``): a
record still ``thinking`` after it has lost its answer."""


def utc_now() -> datetime:
    """Naive UTC, as every time the record holds (the store's convention)."""
    return datetime.now(UTC).replace(tzinfo=None)


def day_start(now: datetime, tz: tzinfo | None = None) -> datetime:
    """Midnight of ``now``'s calendar day in ``tz`` (``None``: the server's time
    zone), as naive UTC like ``now`` (P5)."""
    local = now.replace(tzinfo=UTC).astimezone(tz)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    # The offset at midnight, which differs from now's on a day the clocks change.
    aware = midnight.astimezone() if tz is None else midnight.replace(tzinfo=tz)
    return aware.astimezone(UTC).replace(tzinfo=None)


def close_stale(engine: Engine, clock: Callable[[], datetime] = utc_now) -> list[int]:
    """The start-up check (P7): records older than the model call's time limit
    that no request will finish any more; ``thinking`` ends ``failed``."""
    return ModelActionStore(engine, clock).close_stale(clock() - timedelta(seconds=MODEL_CALL_S))


def _error(code: str, message: str, **details: Any) -> dict[str, Any]:
    """The record's ``error`` (design M14): the same shape as an error body."""
    return {"code": code, "message": message, "details": details}


@dataclass(frozen=True)
class _Call:
    """What the call after the answer needs, resolved while the request was checked."""

    endpoint: Endpoint = field(repr=False)
    context: ToolContext
    level: Level
    context_length: int | None
    text: str = field(repr=False)
    profile: ModelProfile = field(repr=False)


@dataclass(frozen=True)
class Asked:
    """A prompt the application accepted: the record as it is now, ``thinking``,
    and the model call to run after the answer has left (P7)."""

    action: ModelActionView
    run: Callable[[], None] = field(repr=False)


@dataclass(frozen=True)
class PromptFlow:
    backend: DataBackend
    connections: Connections
    client_factory: ClientFactory
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

    def prompt(self, caller: Account, request: PromptRequest) -> Asked:
        """Check, record ``thinking``, and hand back the call to run."""
        if request.approach != "direct":
            raise ValueError("the tool chain arrives with WP75")
        engine = self.backend.engine
        level = active_level(engine, caller.id, admin=caller.role == "admin")
        connection = self.connections.active(caller.id)
        if connection is None:
            raise ConnectionProblem(
                409,
                "connection_not_available",
                "No model connection is set up for this account.",
                reason="none",
            )
        self._check_request_limit(connection)
        view = view_for(self.backend, caller)
        profile = model_profile(engine, view.layer_names())
        # Too large to send: refused before the record, so it is no request (P5).
        build_prompt(
            request.text,
            approach="direct",
            level=level,
            profile=profile,
            context_length=connection.context_length,
        )
        endpoint = self.connections.endpoint(connection.id)
        action = self.store.create(
            caller,
            NewAction(
                prompt=request.text,
                approach="direct",
                level=level_snapshot(level),
                connection=connection_snapshot(connection),
                profile_hash=profile.hash,
                parent_action_id=request.parent_action_id,
                proposal_only=True,  # P1: every level only proposes in E2.3
            ),
        )
        log.info(
            "model action %d asked: connection %d, level %d, profile %s",
            action.id,
            connection.id,
            action.level.id,
            profile.hash[:12],
        )
        call = _Call(
            endpoint=endpoint,
            context=ToolContext(view, self.limits, self.unsupported),
            level=level,
            context_length=connection.context_length,
            text=request.text,
            profile=profile,
        )
        return Asked(action, partial(self._answer, caller, action.id, call))

    def _check_request_limit(self, connection: ConnectionInfo) -> None:
        """Off: no counting at all. On: refused once the day's requests reach it (P5)."""
        if not connection.request_limit_enabled:
            return
        limit = connection.request_limit_per_day
        if limit is None:  # the connection rules and the table's check keep it set
            raise RuntimeError(f"connection {connection.id} has a request limit without number")
        if self.requests_today(connection.id) >= limit:
            raise ActionError(
                "quota_exceeded",
                f"The {limit} requests per day of the connection '{connection.name}' are "
                "used up; an administrator sets the limit.",
                http_status=429,
                limit=limit,
                connection=connection.name,
            )

    def requests_today(self, connection_id: int) -> int:
        """Requests of the current calendar day that reached the model call, over
        all accounts (P5): every record is one, since a request refused before
        the call leaves none."""
        since = day_start(self.clock(), self.tz)
        with Session(reading(self.backend.engine)) as db:
            count = db.scalar(
                select(func.count())
                .select_from(ModelAction)
                .where(ModelAction.connection_id == connection_id, ModelAction.created_at >= since)
            )
        return count or 0

    # --- the call, after the answer (P7) -----------------------------------------

    def _answer(self, caller: Account, action_id: int, call: _Call) -> None:
        """Ask the model and store what came of it. Never raises: whatever goes
        wrong ends the record ``failed``, and the start-up check closes one this
        process could not write any more."""
        store = self.store
        try:
            client = self.client_factory(call.endpoint)
            try:
                direct = DirectQuery(client, call.context, call.level, call.context_length)
                found = direct.run(call.text, profile=call.profile)
            finally:
                client.close()
        except LLMError as exc:
            error = _error(exc.code, exc.message, cause=exc.cause)
            self._settle(action_id, lambda: store.fail(caller, action_id, error))
            return
        except ActionError as exc:  # model_unreadable; its cause names no text
            error = _error(exc.code, exc.message, **exc.details)
            self._settle(action_id, lambda: store.fail(caller, action_id, error))
            return
        except Exception as exc:
            # The type only: an exception's text may quote the prompt (C15).
            log.error("model action %d: the call failed (%s)", action_id, type(exc).__name__)
            error = _error("internal_error", "The model call stopped unexpectedly.")
            self._settle(action_id, lambda: store.fail(caller, action_id, error))
            return
        self._settle(action_id, lambda: self._keep(store, caller, action_id, found))

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
        except Exception as exc:
            log.error(
                "model action %d: storing the outcome failed (%s)", action_id, type(exc).__name__
            )
            return
        code = (view.refusal.code if view.refusal else None) or (view.error or {}).get("code")
        log.info("model action %d: %s%s", action_id, view.status, f" ({code})" if code else "")

    # --- the record (D4, P1) -----------------------------------------------------

    def get(self, caller: Account, action_id: int) -> ModelActionView:
        """Own records, an administrator's every record (D4); polled (P7)."""
        return self.store.get(caller, action_id)

    def decide(self, caller: Account, action_id: int, request: DecideRequest) -> ModelActionView:
        """The hand-over (P1): applied by hand, or edited and applied through Modus A
        with the query the user applied instead (``adjusted``, logged, never run)."""
        if request.decision == "adjusted" and request.query is None:
            raise ActionError(
                "bad_request",
                "An adjusted decision names the query the user applied.",
                decision=request.decision,
            )
        if request.decision == "proposal_only" and request.query is not None:
            raise ActionError(
                "bad_request",
                "A proposal applied as proposed has no query of the user's.",
                decision=request.decision,
            )
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
        """While the model thinks (M2.1): ``aborted``. The call runs on to its own
        end; its answer is dropped by the store's compare-and-set."""
        view = self.store.abort(caller, action_id)
        log.info("model action %d: aborted", action_id)
        return view
