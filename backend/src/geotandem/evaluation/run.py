"""The run engine of the evaluation (plan E3, D7, D8, D10, D12, WP90).

A run asks every selected case at every measuring point, repeated with the
seeds of one or two blocks, and grades each answer with the shared grader
(``stages.assess``). It is a measurement, not use: it writes no model action
and does not count against a connection's daily request limit (D8, D12).

**Before the start**, in the request (``Evaluation.start``): one run at a time
for the instance (``run_busy``), every external connection confirmed in this
request (``external_not_confirmed``, F-9.4), the cases selected on the data
state of the request (D1) with their status (D3): stale and invalid ones are
listed in the run but not asked; none left is ``no_cases``. The run's label
(F-3.18) and its points (H7) are written once; a later edit of a connection,
a level or a case changes no run.

**In the background**, in a thread of its own (as a chain runs, E2 P4): the
readings of each case once (``grade.reading_ids``); a case whose reading no
longer passes the checks or no longer runs is the case's problem, marked
``invalid`` in the run and skipped, never an answer's fault. Then the points:
those on different connections at the same time, those on one connection one
after another (D8). Each question is built as operation builds it
(``_prompt_for``: the level, an edited copy of its system prompt for this run
only (D10), the layer profile of the data state, the starting
administrator's for a live run (D4)), sent through ``LLMClient`` with the
connection's endpoint, temperature and timeout and the repeat's seed, read
and checked as ``DirectQuery.ask`` does, graded under the operating limits
while holding one of the instance's query slots (security review #42). An
abort stops before the next question; an answer that arrives after it is
dropped. Once every question is answered the run is ``done`` and its figures
are computed (``figures.py``, none while it runs: design review 5).

A ``running`` run found at start-up has no thread left: it ends
``interrupted``, its answers kept (``close_interrupted``). A shutdown stops the
thread before its next question and leaves the run to that check.

Logs carry ids and codes only, never a prompt, an answer or a key (C15).

Hooks for the work packages built beside this one: ``prompt_profile_of`` and
``_prompt_for`` (WP91, the connection's prompt profile and the builder's
options), ``price_of`` (WP91, prices on the connection), ``profile_summary_for``
(WP94, the completeness summary of the layer profile).
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import statistics
import threading
import time
from collections import defaultdict
from collections.abc import Callable, Iterable, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any, Final

from sqlalchemy import Engine

from geotandem.auth.accounts import Account
from geotandem.config import Settings
from geotandem.connections import ConnectionInfo, ConnectionProblem, Connections
from geotandem.data import DataBackend, Limits, Op
from geotandem.engine import QueryError
from geotandem.evaluation.cases import Cases, World, assess_case, sample_version
from geotandem.evaluation.figures import (
    Price,
    Scored,
    by_currency,
    cells,
    comparisons,
    confirm_ids,
    cost,
    passes,
    point_figures,
)
from geotandem.evaluation.grade import ReadingRefused, reading_ids
from geotandem.evaluation.run_store import NewRun, RunStore, StoredRun
from geotandem.evaluation.schemas import (
    BLOCK,
    GRADING_VERSION,
    AnswerView,
    CompareRequest,
    ConnectionEstimate,
    CostEstimate,
    EvalCase,
    LayerGaps,
    MeasuringPoint,
    Money,
    PointLabel,
    PointView,
    ProfileSummary,
    RunCase,
    RunComparison,
    RunComparisonRow,
    RunExport,
    RunLabel,
    RunPage,
    RunRequest,
    RunSummary,
    RunView,
)
from geotandem.evaluation.stages import Assessment, assess, unanswered
from geotandem.evaluation.stats import compare
from geotandem.levels import Level, load_levels
from geotandem.llm import (
    ClientFactory,
    Completion,
    Endpoint,
    LLMClient,
    LLMError,
    Message,
    ToolSpec,
)
from geotandem.model.direct import DirectAnswer, DirectQuery, direct_prompt
from geotandem.model.errors import ActionError
from geotandem.model.prompt import ANSWER_TOKENS, Prompt
from geotandem.model.record.store import text_hash, utc_now
from geotandem.model.schemas import PromptProfile
from geotandem.model.service import QueryGate
from geotandem.vault import CredentialsUnreadable
from geotandem_query import SCHEMA_VERSION

log = logging.getLogger(__name__)

RUNNABLE: Final = frozenset({"ok", "dataset_changed"})
"""Case statuses a run asks (D3); ``stale`` and ``invalid`` are left out."""
DEFAULT_LATENCY_S: Final = 10
"""The duration estimate's latency per request for a connection that has
neither a run nor a connection test with a latency (D12)."""
ANSWER_ESTIMATE: Final = 100
"""Tokens of one answer for the estimate: the testplans' direct answers run at
about 40 to 100 (the prompt's own estimate reserves ``ANSWER_TOKENS`` as room,
not as use)."""
MAX_RAW: Final = 20_000
"""Characters kept of the verbatim text of an unreadable answer (V7.4)."""
SHUTDOWN_WAIT_S: Final = 5


class RunError(Exception):
    """A rule about runs was violated; ``code`` is stable for the interface."""

    def __init__(self, status: int, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def _not_found(run_id: int) -> RunError:
    return RunError(404, "not_found", f"There is no run {run_id}.", run=run_id)


# --- hooks of the work packages beside this one -------------------------------------


def prompt_profile_of(connection: ConnectionInfo) -> PromptProfile:
    """The connection's own prompt profile (D9). Until WP91 stores one on the
    connection, every connection has today's prompt."""
    return PromptProfile()


def price_of(connection: ConnectionInfo) -> Price | None:
    """The connection's prices per million tokens (D12, O4); ``None`` until
    WP91 adds them to the connection."""
    return None


def profile_summary_for(world: World) -> ProfileSummary:
    """How complete the layer profile of ``world`` is (D11), from the profile
    the model gets: labels other than the column name, text attributes with a
    confirmed code list (the profile carries a code list only once confirmed,
    S2), descriptions of layers and attributes. WP94 builds the summary of
    the profile page; this is the one place a run takes it from."""
    attributes = labelled = texts = with_codes = described = 0
    gaps: list[LayerGaps] = []
    for layer in world.profile.layers:
        text = [a for a in layer.attributes if a.type == "text"]
        unconfirmed = [a.name for a in text if not a.codes]
        unlabelled = [a.name for a in layer.attributes if a.label == a.name]
        undescribed = ([""] if not layer.description else []) + [
            a.name for a in layer.attributes if not a.description
        ]
        attributes += len(layer.attributes)
        labelled += len(layer.attributes) - len(unlabelled)
        texts += len(text)
        with_codes += len(text) - len(unconfirmed)
        described += 1 + len(layer.attributes) - len(undescribed)
        if unconfirmed or unlabelled or undescribed:
            gaps.append(
                LayerGaps(
                    layer=layer.name,
                    title=layer.title,
                    attributes=len(layer.attributes),
                    text_attributes=len(text),
                    unconfirmed_codes=unconfirmed,
                    unlabelled=unlabelled,
                    undescribed=undescribed,
                )
            )
    return ProfileSummary(
        profile_hash=world.profile.hash,
        layers=len(world.profile.layers),
        attributes=attributes,
        labelled=labelled,
        text_attributes=texts,
        text_with_codes=with_codes,
        described=described,
        gaps=gaps,
    )


@dataclass(frozen=True)
class Point:
    """A measuring point resolved at the start: its connection, endpoint and
    level as they were (H7). The endpoint holds the decrypted key in memory
    for the run, never in a row or a view."""

    index: int
    connection: ConnectionInfo
    level: Level
    """With the edited system prompt copy of this run (D10), if any."""
    label: PointLabel
    price: Price | None
    endpoint: Endpoint | None = field(default=None, repr=False)


def _prompt_for(point: Point, case: EvalCase, world: World) -> Prompt:
    """The question of ``case`` as operation would send it at ``point`` (the
    one place a run builds a prompt): the level and its system prompt, the
    layer profile of the data state, the connection's context length
    (``context_too_large``). WP91 adds ``point.label.prompt_profile``."""
    return direct_prompt(
        case.prompt,
        level=point.level,
        profile=world.profile,
        context_length=point.connection.context_length,
    )


def _check_prompt_profile(point: Point) -> None:
    """Until the builder knows prompt profiles (WP91), a point measures today's
    prompt only: a label naming another profile would claim what was not sent.
    WP91 removes this check when ``_prompt_for`` passes the profile on."""
    if point.label.prompt_profile != PromptProfile():
        raise RunError(
            400,
            "bad_request",
            "Prompt profiles other than the default are not built yet (WP91).",
            point=point.index,
        )


# --- the run's background thread -------------------------------------------------


class Runs:
    """The run in flight (D8): at most one for the instance, in a thread of its
    own, with its cancel event. One per application (``AppState``)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._run: int | None = None
        self._thread: threading.Thread | None = None
        self._cancel = threading.Event()
        self._stopping = False

    @contextmanager
    def admission(self) -> Iterator[Callable[[], int | None]]:
        """Held around the checks and the creation of a run, so two starts never
        both pass; yields what runs now (a run id, or ``None``)."""
        with self._lock:
            yield self._busy

    def _busy(self) -> int | None:
        if self._thread is not None and self._thread.is_alive():
            return self._run
        return None

    def launch(self, run_id: int, work: Callable[[threading.Event], None]) -> None:
        """Start ``work`` for ``run_id``; inside ``admission``."""
        if self._stopping:
            raise RuntimeError("the application is stopping")
        cancel = threading.Event()
        thread = threading.Thread(
            target=work, args=(cancel,), name=f"eval-run-{run_id}", daemon=True
        )
        self._run, self._thread, self._cancel = run_id, thread, cancel
        thread.start()

    def cancel(self, run_id: int) -> None:
        with self._lock:
            if self._run == run_id:
                self._cancel.set()

    def wait(self, timeout: float | None = None) -> None:
        """Until the run in flight has ended (tests)."""
        with self._lock:
            thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def shutdown(self) -> None:
        """The run stops before its next question and stays ``running`` for the
        start-up check, which closes it ``interrupted``."""
        with self._lock:
            self._stopping = True
            self._cancel.set()
            thread = self._thread
        if thread is not None:
            thread.join(SHUTDOWN_WAIT_S)


class _Recording:
    """The client of one question, keeping its last completion: the tokens and
    latency of an answer that does not read, and its verbatim text (V7.4)."""

    def __init__(self, client: LLMClient) -> None:
        self.client = client
        self.last: Completion | None = None

    def complete(
        self,
        messages: Sequence[Message],
        *,
        schema: dict[str, Any] | None = None,
        schema_name: str = "answer",
        tools: Sequence[ToolSpec] = (),
        deadline: float | None = None,
    ) -> Completion:
        self.last = self.client.complete(
            messages, schema=schema, schema_name=schema_name, tools=tools, deadline=deadline
        )
        return self.last

    def models(self) -> Any:
        return self.client.models()

    def server_version(self) -> str | None:
        return self.client.server_version()

    def close(self) -> None:
        self.client.close()


def seeds_of(request: RunRequest) -> list[int]:
    """Two blocks of ``BLOCK`` seeds, or one for a quick test (D7, O2): the
    harness's ``--seed-start 1`` and ``--seed-start 6``."""
    blocks = 2 if request.scope == "full" else 1
    return list(range(1, blocks * BLOCK + 1))


def block_of(seed: int) -> int:
    """1 for the first block, 2 for the second."""
    return (seed - 1) // BLOCK + 1


def case_set_hash(cases: Iterable[EvalCase]) -> str:
    """Over what a case asks and demands, its tags and note left out: two runs
    with the same hash asked the same questions with the same references and
    splits (V5.1)."""
    body = [
        c.model_dump(mode="json", exclude={"tags", "note"}, exclude_none=True)
        for c in sorted(cases, key=lambda c: c.id)
    ]
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode()).hexdigest()


@dataclass
class Evaluation:
    """The runs as one administrator works on them (D4): a live run uses the
    administrator's view and profile. Built per request."""

    settings: Settings
    backend: DataBackend
    connections: Connections
    client_factory: ClientFactory
    runs: Runs
    admin: Account
    limits: Limits
    unsupported: Iterable[Op] = ()
    gate: QueryGate | None = None
    clock: Callable[[], datetime] = utc_now
    monotonic: Callable[[], float] = time.monotonic

    @property
    def engine(self) -> Engine:
        return self.backend.engine

    @property
    def store(self) -> RunStore:
        return RunStore(self.engine, self.clock)

    def _cases(self) -> Cases:
        return Cases(self.settings, self.backend, self.admin, self.limits, self.unsupported)

    # --- what a run asks -------------------------------------------------------

    @staticmethod
    def _select(request: RunRequest, cases: Cases) -> list[EvalCase]:
        """The cases of the request on its data state: the start set and the own
        cases of the chosen origins, of the split, with any of the tags. An own
        case behind a start id is left out when the start set runs too."""
        chosen = request.cases
        start = [c for c in cases.start if "start" in chosen.origins]
        taken = {c.id for c in start}
        own = [
            stored.case
            for stored in cases.store.cases()
            if stored.case.origin in chosen.origins and stored.case.id not in taken
        ]
        return [
            c
            for c in start + own
            if c.data_state == request.data_state
            and (chosen.split is None or c.split == chosen.split)
            and (not chosen.tags or set(c.tags) & set(chosen.tags))
        ]

    def _run_cases(self, request: RunRequest) -> tuple[list[RunCase], World]:
        """The selected cases with their status (D3); ``no_cases`` when none can run."""
        cases = self._cases()
        world = cases.world(request.data_state)
        found = [
            RunCase(case=c, status=assess_case(c, world, count=False)[0])
            for c in self._select(request, cases)
        ]
        if not any(rc.status in RUNNABLE for rc in found):
            raise RunError(
                400,
                "no_cases",
                "No case of the selection can run: none matches, or all are stale or invalid.",
                selected=len(found),
            )
        return found, world

    def _points(self, request: RunRequest, *, endpoints: bool) -> list[Point]:
        """Each measuring point with its connection and level as they are now;
        with ``endpoints`` the endpoint too, its key decrypted (C8)."""
        levels = {level.id: level for level in load_levels(self.engine)}
        found = []
        for index, wanted in enumerate(request.points):
            connection = self.connections.get(wanted.connection_id)
            if connection is None:
                raise ConnectionProblem(
                    404, "not_found", "Unknown connection.", id=wanted.connection_id
                )
            level = levels.get(wanted.level_id)
            if level is None:
                raise RunError(404, "not_found", "Unknown level.", level=wanted.level_id)
            endpoint = None
            if endpoints:
                endpoint, unreadable = self.connections.for_test(connection.id)
                if unreadable:
                    raise CredentialsUnreadable
            point = self._point(index, wanted, connection, level, endpoint)
            _check_prompt_profile(point)
            found.append(point)
        return found

    @staticmethod
    def _point(
        index: int,
        wanted: MeasuringPoint,
        connection: ConnectionInfo,
        level: Level,
        endpoint: Endpoint | None,
    ) -> Point:
        if wanted.system_prompt is not None:
            level = level.model_copy(update={"system_prompt": wanted.system_prompt})
        assert level.id is not None  # stored levels only
        label = PointLabel(
            connection_id=connection.id,
            connection_name=connection.name,
            model=connection.model,
            host=connection.host,
            locality=connection.locality,
            temperature=connection.temperature,
            reasoning_effort=connection.reasoning_effort,
            prompt_profile=wanted.prompt_profile or prompt_profile_of(connection),
            level_id=level.id,
            level_name=level.name,
            system_prompt_hash=text_hash(level.system_prompt),
            system_prompt=wanted.system_prompt,
        )
        return Point(index, connection, level, label, price_of(connection), endpoint)

    # --- the estimate (D12) --------------------------------------------------------

    def _latency_ms(self, connection: ConnectionInfo) -> float:
        """The median latency of the connection's last run, else of its
        connection test's answer, else ``DEFAULT_LATENCY_S``."""
        if latencies := self.store.last_latencies(connection.id):
            return float(statistics.median(latencies))
        test = connection.last_test
        for step in test.steps if test else ():
            latency = step.details.get("latency_ms")
            if step.name == "json_schema" and isinstance(latency, int | float):
                return float(latency)
        return DEFAULT_LATENCY_S * 1000

    def estimate(self, request: RunRequest) -> CostEstimate:
        """Requests, tokens, cost and duration per connection before the start;
        no model call. Points on one connection run one after another, the
        connections at the same time (D8)."""
        run_cases, world = self._run_cases(request)
        asked = [rc.case for rc in run_cases if rc.status in RUNNABLE]
        repeats = len(seeds_of(request))
        per: dict[int, list[Point]] = defaultdict(list)
        for point in self._points(request, endpoints=False):
            per[point.connection.id].append(point)
        estimates = []
        for points in per.values():
            connection = points[0].connection
            requests = len(asked) * repeats * len(points)
            prompt_tokens = repeats * sum(
                _prompt_tokens(point, case, world) for point in points for case in asked
            )
            answer_tokens = requests * ANSWER_ESTIMATE
            estimates.append(
                ConnectionEstimate(
                    connection_id=connection.id,
                    name=connection.name,
                    host=connection.host,
                    locality=connection.locality,
                    points=len(points),
                    requests=requests,
                    tokens=prompt_tokens + answer_tokens,
                    cost=cost(points[0].price, prompt_tokens, answer_tokens),
                    duration_s=math.ceil(requests * self._latency_ms(connection) / 1000),
                )
            )
        return CostEstimate(
            cases=len(asked),
            connections=estimates,
            requests=sum(e.requests for e in estimates),
            tokens=sum(e.tokens for e in estimates),
            cost=by_currency(e.cost for e in estimates),
            duration_s=max(e.duration_s for e in estimates),
            external_hosts=sorted({e.host for e in estimates if e.locality == "external"}),
        )

    # --- the start (D8) ------------------------------------------------------------

    def _label(
        self, request: RunRequest, run_cases: Sequence[RunCase], world: World, now: datetime
    ) -> RunLabel:
        asked = [rc.case for rc in run_cases if rc.status in RUNNABLE]
        layers = sorted({layer.name for case in asked for layer in case.layers})
        live = request.data_state == "live"
        return RunLabel(
            query_schema=SCHEMA_VERSION,
            grading_version=GRADING_VERSION,
            data_state=request.data_state,
            sample_version=None if live else sample_version(),
            dataset_versions={name: world.versions.get(name) for name in layers} if live else {},
            profile=profile_summary_for(world),
            account=self.admin.username,
            scope=request.scope,
            seeds=seeds_of(request),
            cases=len(asked),
            case_set_hash=case_set_hash(asked),
            started_at=now,
            started_by=self.admin.username,
        )

    def start(self, request: RunRequest) -> RunView:
        """Check, record ``running``, start the thread; the run as it is now."""
        with self.runs.admission() as busy:
            if (running := busy()) is not None:
                raise RunError(409, "run_busy", f"The run {running} is still running.", run=running)
            points = self._points(request, endpoints=True)
            for point in points:
                connection = point.connection
                if connection.locality == "external" and connection.id not in set(
                    request.confirm_external
                ):
                    raise RunError(
                        400,
                        "external_not_confirmed",
                        f"The run would send to '{connection.host}' without confirmation.",
                        connection=connection.name,
                        connection_id=connection.id,
                        host=connection.host,
                    )
            run_cases, world = self._run_cases(request)
            now = self.clock()
            label = self._label(request, run_cases, world, now)
            seeds = seeds_of(request)
            new = NewRun(
                request=request,
                label=label,
                cases=run_cases,
                points=[PointView(label=p.label, figures=None, comparison=None) for p in points],
                prices=[p.price for p in points],
                total=label.cases * len(seeds) * len(points),
            )
            run_id = self.store.create(new, started_by=self.admin.username, started_at=now)
            work = _Work(self, run_id, request, points, run_cases, world, seeds)
            self.runs.launch(run_id, work)
        log.info(
            "evaluation run %d started: %d points, %d cases, %s, %s",
            run_id,
            len(points),
            label.cases,
            request.data_state,
            request.scope,
        )
        return self.view(run_id)

    def abort(self, run_id: int) -> RunView:
        """Stops before the next question; the answers so far stay. A run that
        is not running is returned as it is."""
        if self.store.get(run_id) is None:
            raise _not_found(run_id)
        if self.store.finish(run_id, "aborted"):
            log.info("evaluation run %d aborted", run_id)
        self.runs.cancel(run_id)
        return self.view(run_id)

    # --- views ----------------------------------------------------------------------

    def _get(self, run_id: int) -> StoredRun:
        stored = self.store.get(run_id)
        if stored is None:
            raise _not_found(run_id)
        return stored

    @staticmethod
    def _cost(stored: StoredRun, tokens: dict[int, tuple[int, int]]) -> list[Money]:
        return by_currency(
            cost(stored.prices[point], *spent)
            for point, spent in tokens.items()
            if point < len(stored.prices)
        )

    def view(self, run_id: int) -> RunView:
        stored = self._get(run_id)
        scored = self.store.scored(run_id)
        tokens = self.store.tokens([run_id]).get(run_id, {})
        return RunView(
            id=stored.id,
            status=stored.status,
            request=stored.request,
            label=stored.label,
            cases=stored.cases,
            points=stored.points,
            reference=stored.reference,
            progress=stored.progress,
            cost_so_far=self._cost(stored, tokens),
            cells=cells(scored, [rc.case.id for rc in stored.cases]),
            error=stored.error,
            finished_at=stored.finished_at,
        )

    def page(self, connection_id: int | None, offset: int, limit: int) -> RunPage:
        found, total = self.store.page(connection_id, offset, limit)
        tokens = self.store.tokens([s.id for s in found])
        items = []
        for stored in found:
            figures = stored.points[stored.reference].figures
            items.append(
                RunSummary(
                    id=stored.id,
                    status=stored.status,
                    scope=stored.label.scope,
                    data_state=stored.label.data_state,
                    started_at=stored.label.started_at,
                    started_by=stored.label.started_by,
                    points=len(stored.points),
                    connection_ids=stored.connection_ids,
                    cases=stored.label.cases,
                    case_set_hash=stored.label.case_set_hash,
                    reference_rate=figures.rate_tuning if figures else None,
                    cost=self._cost(stored, tokens.get(stored.id, {})),
                )
            )
        return RunPage(items=items, total=total)

    def answers(self, run_id: int, case_id: str, point: int) -> list[AnswerView]:
        """The repeats of one case at one point (V7); ``not_found`` for a case or
        a point the run does not have."""
        stored = self._get(run_id)
        if case_id not in {rc.case.id for rc in stored.cases}:
            raise RunError(
                404, "not_found", f"The run {run_id} has no case '{case_id}'.", case_id=case_id
            )
        if point >= len(stored.points):
            raise RunError(404, "not_found", f"The run {run_id} has no point {point}.", point=point)
        return self.store.answers(run_id, case_id, point)

    def export(self, run_id: int) -> RunExport:
        """The run with every answer (V6.2 *Exportieren*)."""
        return RunExport(run=self.view(run_id), answers=self.store.answers(run_id))

    def compare(self, body: CompareRequest) -> RunComparison:
        """``run`` against ``against`` (V6.6): both ``done``, the same cases
        (``case_set_hash``), else ``runs_not_comparable``. Points are matched by
        connection, prompt profile, level and system prompt; the comparison
        words only when both are full runs with confirmation cases (D7)."""
        run, against = self._get(body.run), self._get(body.against)
        if (
            run.status != "done"
            or against.status != "done"
            or run.label.case_set_hash != against.label.case_set_hash
        ):
            raise RunError(
                409,
                "runs_not_comparable",
                "The runs differ in their cases, or one is not complete.",
                run=run.id,
                against=against.id,
                statuses=[run.status, against.status],
            )
        ids = confirm_ids(rc.case for rc in run.cases if rc.status in RUNNABLE)
        full = run.label.scope == against.label.scope == "full"
        mine, theirs = (
            _by_point(self.store.scored(run.id)),
            _by_point(self.store.scored(against.id)),
        )
        rows = []
        for index, point in enumerate(run.points):
            other = next(
                (i for i, p in enumerate(against.points) if _same_point(p.label, point.label)),
                None,
            )
            if other is None:
                continue
            comparison = None
            if full and ids:
                base = passes(theirs.get(other, ()), ids)
                found = passes(mine.get(index, ()), ids)
                comparison = compare(base, found) if base and found else None
            figures, figures_against = point.figures, against.points[other].figures
            rows.append(
                RunComparisonRow(
                    label=point.label,
                    rate=figures.rate_tuning if figures else None,
                    rate_against=figures_against.rate_tuning if figures_against else None,
                    comparison=comparison,
                )
            )
        return RunComparison(run=run.id, against=against.id, points=rows)


def _same_point(a: PointLabel, b: PointLabel) -> bool:
    return (a.connection_id, a.prompt_profile, a.level_id, a.system_prompt_hash) == (
        b.connection_id,
        b.prompt_profile,
        b.level_id,
        b.system_prompt_hash,
    )


def _by_point(scored: Iterable[Scored]) -> dict[int, list[Scored]]:
    found: dict[int, list[Scored]] = defaultdict(list)
    for answer in scored:
        found[answer.point].append(answer)
    return found


def _prompt_tokens(point: Point, case: EvalCase, world: World) -> int:
    """The size estimate of the question's messages (S5), without the answer's room."""
    try:
        prompt = _prompt_for(point, case, world)
    except ActionError:  # context_too_large: never sent, so it costs nothing
        return 0
    return prompt.tokens_estimate - ANSWER_TOKENS


def close_interrupted(engine: Engine, clock: Callable[[], datetime] = utc_now) -> list[int]:
    """The start-up check (D8): no run survives a restart of the one process."""
    return RunStore(engine, clock).close_running()


# --- one run, in its thread -------------------------------------------------------


@dataclass
class _Work:
    """What the thread of one run does (module docstring)."""

    flow: Evaluation
    run_id: int
    request: RunRequest
    points: list[Point]
    cases: list[RunCase]
    world: World
    seeds: list[int]
    readings: dict[str, list[list[int]] | None] = field(default_factory=dict)

    @property
    def store(self) -> RunStore:
        return self.flow.store

    def __call__(self, cancel: threading.Event) -> None:
        """Never raises: whatever goes wrong ends the run ``failed``."""
        try:
            if not self._read(cancel):
                return
            groups: dict[int, list[Point]] = defaultdict(list)
            for point in self.points:
                groups[point.connection.id].append(point)
            with ThreadPoolExecutor(
                max_workers=len(groups), thread_name_prefix=f"eval-run-{self.run_id}"
            ) as pool:
                asking = [pool.submit(self._ask_all, group, cancel) for group in groups.values()]
                for done in asking:
                    done.result()
            if cancel.is_set():
                return  # aborted (the route closed it) or stopping (the start-up check will)
            self._finish()
        except Exception as exc:
            # The type only: an exception's text may quote a prompt (C15).
            log.error("evaluation run %d failed (%s)", self.run_id, type(exc).__name__)
            try:
                self.store.finish(self.run_id, "failed", error="internal_error")
            except Exception as again:
                log.error("evaluation run %d: not closed (%s)", self.run_id, type(again).__name__)

    @contextmanager
    def _slot(self, cancel: threading.Event) -> Iterator[bool]:
        """One of the instance's query slots, waited for until the run is
        cancelled (review #42); ``False`` then."""
        gate = self.flow.gate
        if gate is None:
            yield True
            return
        got = False
        while not got and not cancel.is_set():
            got = gate.take_thread(self.flow.settings.query_timeout_s, cancel.is_set)
        try:
            yield got
        finally:
            if got:
                gate.give_back_thread()

    def _read(self, cancel: threading.Event) -> bool:
        """The readings of every case once (``reading_ids``); a reading that fails
        is the case's problem: ``invalid`` in the run, not asked. ``False`` when
        the run stops here."""
        context, profile = self.world.context, self.world.profile
        kept: list[RunCase] = []
        for run_case in self.cases:
            case = run_case.case
            if run_case.status not in RUNNABLE:
                kept.append(run_case)
                continue
            with self._slot(cancel) as got:
                if not got:
                    return False
                try:
                    self.readings[case.id] = reading_ids(case, context, profile)
                except (ReadingRefused, QueryError) as exc:
                    code = exc.refusal.code if isinstance(exc, ReadingRefused) else exc.code
                    log.warning(
                        "evaluation run %d: case %s left out, its reading fails (%s)",
                        self.run_id,
                        case.id,
                        code,
                    )
                    run_case = run_case.model_copy(update={"status": "invalid"})
            kept.append(run_case)
        if len(kept) != len(self.cases) or any(
            a.status != b.status for a, b in zip(kept, self.cases, strict=True)
        ):
            self.cases = kept
            asked = sum(rc.status in RUNNABLE for rc in kept)
            self.store.set_cases(self.run_id, kept, asked * len(self.seeds) * len(self.points))
        if not self.readings:
            self.store.finish(self.run_id, "failed", error="no_cases")
            return False
        return True

    def _ask_all(self, points: Sequence[Point], cancel: threading.Event) -> None:
        """The points of one connection, one after another (D8). A failure stops
        the other connections too: the run ends ``failed``."""
        try:
            self._ask_points(points, cancel)
        except BaseException:
            cancel.set()
            raise

    def _ask_points(self, points: Sequence[Point], cancel: threading.Event) -> None:
        for point in points:
            for run_case in self.cases:
                if run_case.case.id not in self.readings:
                    continue
                for seed in self.seeds:
                    if cancel.is_set():
                        return
                    view = self._answer(point, run_case.case, seed, cancel)
                    if view is None:
                        return
                    if not self.store.add_answer(self.run_id, point.connection.id, view):
                        cancel.set()  # aborted meanwhile: the answer is dropped
                        return

    def _answer(
        self, point: Point, case: EvalCase, seed: int, cancel: threading.Event
    ) -> AnswerView | None:
        """Ask one question and grade the answer; ``None`` when the run was
        cancelled while the answer waited for a query slot."""
        assert point.endpoint is not None
        base = {"case_id": case.id, "point": point.index, "block": block_of(seed), "seed": seed}
        try:
            prompt = _prompt_for(point, case, self.world)
        except ActionError as exc:  # context_too_large: never sent
            return _view(base, unanswered(exc.code))
        endpoint = replace(point.endpoint, seed=seed)
        client = _Recording(self.flow.client_factory(endpoint))
        found: DirectAnswer | None = None
        assessment: Assessment
        try:
            direct = DirectQuery(client, self.world.context, point.level)
            found = direct.ask(
                prompt,
                profile=self.world.profile,
                deadline=self.flow.monotonic() + endpoint.timeout_s,
            )
        except LLMError as exc:
            assessment = unanswered(exc.code)
        except ActionError as exc:  # model_unreadable, model_truncated
            assessment = unanswered(exc.code)
        finally:
            client.close()
        if found is None:
            # An answer that came but did not read keeps its text, time and tokens.
            last = client.last
            if last is None:
                return _view(base, assessment)
            return _view(
                base,
                assessment,
                raw=last.text[:MAX_RAW],
                latency_ms=last.latency_ms,
                tokens=(last.prompt_tokens, last.completion_tokens),
            )
        with self._slot(cancel) as got:
            if not got:
                return None
            assessment = assess(
                case,
                found.answer,
                found.refusal,
                found.query,
                self.world.context.backend,
                self.world.context.limits,
                readings=self.readings[case.id],
            )
        return _view(
            base,
            assessment,
            answer=found.answer.model_dump(mode="json"),
            refusal=found.refusal.model_dump(mode="json") if found.refusal else None,
            latency_ms=found.latency_ms,
            tokens=(found.tokens.prompt, found.tokens.completion),
        )

    def _finish(self) -> None:
        """``done``, with each point's figures and its comparison (D7)."""
        asked = {rc.case.id: rc.case for rc in self.cases if rc.case.id in self.readings}
        by_point = _by_point(self.store.scored(self.run_id))
        words = comparisons(
            list(asked.values()),
            by_point,
            len(self.points),
            self.request.reference,
            self.request.scope,
        )
        views = [
            PointView(
                label=point.label,
                figures=point_figures(asked, by_point.get(point.index, ()), point.price),
                comparison=words[point.index],
            )
            for point in self.points
        ]
        if self.store.finish(self.run_id, "done", points=views):
            reference = views[self.request.reference].figures
            assert reference is not None
            log.info(
                "evaluation run %d done: reference point %d/%d passed",
                self.run_id,
                reference.passed,
                reference.answers,
            )


def _view(
    base: dict[str, Any],
    assessment: Assessment,
    *,
    answer: Any = None,
    refusal: Any = None,
    raw: str | None = None,
    latency_ms: int | None = None,
    tokens: tuple[int | None, int | None] = (None, None),
) -> AnswerView:
    return AnswerView.model_validate(
        {
            **base,
            **assessment.view_fields(),
            "answer": answer,
            "refusal": refusal,
            "raw": raw,
            "latency_ms": latency_ms,
            "prompt_tokens": tokens[0],
            "completion_tokens": tokens[1],
        }
    )


__all__ = [
    "Evaluation",
    "Point",
    "Price",
    "RunError",
    "Runs",
    "close_interrupted",
    "price_of",
    "profile_summary_for",
    "prompt_profile_of",
]
