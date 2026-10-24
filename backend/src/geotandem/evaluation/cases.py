"""Cases: the start set, the own cases, their data states and their checks
(plan E3, D1-D4, WP87).

The **start set** is the two files of ``schema/eval-cases`` (``Settings.
eval_cases_dir``), read once per process and never written: a start case is
read only, a copy of it becomes an own case. **Own cases** are the rows of
``CaseStore``.

A case runs on a **data state** (D1), here a ``World``: the backend it reads,
the layer profile the model gets over it and the checks of the model path.

- ``sample``: an isolated SpatiaLite database built from the packaged sample
  data, as the harness builds it (``evals/run.py``), once per process and only
  read, so the start set means the same whatever the live catalog holds;
- ``live``: the live catalog as the administrator sees it (D4), read-only.

A case is checked on its data state when it is created, edited or imported,
as a model's query is checked (``validate_model_query``): a reference that
the application would refuse from a model cannot become the right answer.
A live case names the layers it uses; one of them gone or outside the
administrator's model world makes it ``stale`` (D3), so a stale case can
only become stale, never be created. Its status is computed on every read:
``stale``, or ``dataset_changed`` when a layer was re-imported since.

Nothing here logs a case: prompts and references are the administrator's.
"""

from __future__ import annotations

import atexit
import logging
import shutil
import tempfile
import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any, Final

from geotandem.auth.accounts import Account
from geotandem.catalog import ModelProfile, list_layers, model_profile
from geotandem.config import Settings
from geotandem.data import DataBackend, Limits, Op
from geotandem.data.spatialite import SpatiaLiteBackend
from geotandem.data.view import LayerView
from geotandem.db.bootstrap import bootstrap
from geotandem.engine import QueryError, count_query
from geotandem.evaluation.schemas import (
    CASE_FILE_FORMAT,
    CASE_FILE_VERSION,
    MAX_CASES,
    CaseFile,
    CasePage,
    CaseStatus,
    CaseView,
    DataState,
    EvalCase,
    ImportProblem,
    ImportResult,
    Split,
)
from geotandem.evaluation.store import CaseFilters, CaseIdTaken, CaseStore, StoredCase
from geotandem.model.represent import query_layers
from geotandem.model.schemas import Refusal
from geotandem.model.service import profile_for
from geotandem.model.validate import Validated, validate_model_query
from geotandem.sample.load import load_sample
from geotandem.tools import ToolContext
from geotandem_query import QueryObject

log = logging.getLogger(__name__)

START_FILES: Final[dict[Split, str]] = {
    "tuning": "start-tuning.json",
    "confirm": "start-confirm.json",
}
"""The start set (D2), in the order the list shows it."""

REPO_CASES: Final = Path(__file__).resolve().parents[4] / "schema" / "eval-cases"
"""Where the start set lies in the repository; the image names its copy
(``GEOTANDEM_EVAL_CASES_DIR``)."""


class CaseError(Exception):
    """A rule about cases was violated; ``code`` is stable for the interface."""

    def __init__(self, status: int, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def _invalid(case_id: str | None, message: str, *, reason: str, **details: Any) -> CaseError:
    """``reason``: the refusal's code for a reading, else what the rule is."""
    return CaseError(400, "case_invalid", message, case_id=case_id, reason=reason, **details)


def _read_only(case_id: str) -> CaseError:
    return CaseError(
        409,
        "case_read_only",
        f"The case '{case_id}' belongs to the start set; copy it into an own case.",
        case_id=case_id,
    )


def _not_found(case_id: str) -> CaseError:
    return CaseError(404, "not_found", f"There is no case '{case_id}'.", case_id=case_id)


def _taken(case_id: str) -> CaseError:
    return CaseError(409, "case_id_taken", f"A case '{case_id}' exists already.", case_id=case_id)


# --- the start set -----------------------------------------------------------------


def cases_dir(settings: Settings) -> Path:
    return settings.eval_cases_dir or REPO_CASES


@cache
def _start_set(directory: Path) -> tuple[EvalCase, ...]:
    return tuple(
        case
        for name in START_FILES.values()
        for case in CaseFile.model_validate_json((directory / name).read_text("utf-8")).cases
    )


def start_cases(settings: Settings) -> tuple[EvalCase, ...]:
    """Both files of the start set, tuning first, each case as its file writes it."""
    return _start_set(cases_dir(settings).resolve())


# --- data states (D1) -----------------------------------------------------------------


@dataclass(frozen=True)
class World:
    """A data state as a case meets it: what the reference is counted on and
    checked against, with the layers the model knows there and their dataset
    versions (D3)."""

    data_state: DataState
    context: ToolContext
    """A read-only view and the operating limits."""
    profile: ModelProfile
    versions: dict[str, str | None] = field(default_factory=dict)

    @property
    def known(self) -> frozenset[str]:
        """The layers of the model's world (``ModelWorld``): visible and released."""
        return frozenset(layer.name for layer in self.profile.layers)

    def check(self, reading: dict[str, Any], schema_version: str) -> Validated | Refusal:
        """A reference as the harness stores it, checked as a model's query."""
        raw = {"schema_version": schema_version, "output": "map", **reading}
        return validate_model_query(raw, self.context, self.profile)

    def count(self, query: QueryObject) -> int | None:
        """Features of ``query`` under the operating limits; ``None`` if it cannot run."""
        try:
            return count_query(
                query, self.context.backend, self.context.limits, self.context.unsupported
            )
        except QueryError:
            return None


def _world(
    data_state: DataState,
    view: DataBackend,
    profile: ModelProfile,
    limits: Limits,
    unsupported: Iterable[Op],
) -> World:
    versions = {
        info.name: info.dataset_version
        for info in list_layers(view.engine, only=view.layer_names())
    }
    context = ToolContext(view, limits, frozenset(unsupported))
    return World(data_state, context, profile, versions)


_sample_lock = threading.Lock()
_samples: dict[tuple[int, str], SpatiaLiteBackend] = {}


def sample_backend(settings: Settings) -> DataBackend:
    """The isolated sample database (D1), built on first use and kept for the
    process: a temporary SpatiaLite file, migrated and loaded with the packaged
    sample, removed at exit. Only ever read, through a ``LayerView``. Its own
    URL, so a configured ``database_url`` is never touched."""
    key = (settings.internal_crs, settings.spatialite_library)
    with _sample_lock:
        backend = _samples.get(key)
        if backend is None:
            directory = Path(tempfile.mkdtemp(prefix="geotandem-eval-sample-"))
            atexit.register(shutil.rmtree, directory, ignore_errors=True)
            own = Settings(
                data_dir=directory,
                database_url=f"sqlite:///{directory / 'sample.sqlite'}",
                spatialite_library=settings.spatialite_library,
                internal_crs=settings.internal_crs,
            )
            backend = SpatiaLiteBackend(bootstrap(own), own.internal_crs)
            load_sample(backend)
            _samples[key] = backend
            log.info("sample data state built for the evaluation")
    return LayerView(backend, backend.layer_names())


def sample_world(settings: Settings, limits: Limits) -> World:
    """All sample layers (D4), under the operating limits."""
    view = sample_backend(settings)
    profile = model_profile(view.engine, view.layer_names())
    return _world("sample", view, profile, limits, view.missing_functions())


def live_world(
    backend: DataBackend, account: Account, limits: Limits, unsupported: Iterable[Op]
) -> World:
    """The live catalog as ``account`` sees it, read-only (D4): its view and the
    layer profile its model gets (``profile_for``)."""
    view, profile = profile_for(backend, account)
    return _world("live", view, profile, limits, unsupported)


# --- a case on its data state ------------------------------------------------------


def readings(case: EvalCase) -> list[dict[str, Any]]:
    """The reference query, or the fair readings; empty for other cases."""
    return case.gold_any or ([case.gold] if case.gold is not None else [])


def status_of(case: EvalCase, world: World) -> tuple[CaseStatus, list[str]]:
    """D3: a live case with a layer outside the model's world is ``stale``; one
    whose layer has another dataset version than when it was made is
    ``dataset_changed``; with the layers behind it."""
    if case.data_state != "live":
        return "ok", []
    gone = [layer.name for layer in case.layers if layer.name not in world.known]
    if gone:
        return "stale", gone
    changed = [
        layer.name
        for layer in case.layers
        if world.versions.get(layer.name) != layer.dataset_version
    ]
    if changed:
        return "dataset_changed", changed
    return "ok", []


def check_case(case: EvalCase, world: World) -> list[QueryObject]:
    """The rules an own case meets before it is stored; its readings as checked.

    ``case_invalid``: a start case's origin, a reading the model path would
    refuse (the refusal's code is the reason), a layer the reference uses that
    a live case does not name; ``case_stale``: a layer the case names is not
    in the model's world."""
    if case.origin == "start":
        raise _invalid(case.id, "Only the start set says origin 'start'.", reason="origin_start")
    status, layers = status_of(case, world)
    if status == "stale":
        raise CaseError(
            409,
            "case_stale",
            f"The case '{case.id}' uses the layer '{layers[0]}', which is gone or hidden.",
            case_id=case.id,
            layer=layers[0],
            layers=layers,
        )
    listed = {layer.name for layer in case.layers}
    checked: list[QueryObject] = []
    for index, reading in enumerate(readings(case)):
        found = world.check(reading, case.schema_version)
        if isinstance(found, Refusal):
            raise _invalid(
                case.id,
                f"Reading {index} of the case '{case.id}' fails the checks: {found.message}",
                reason=found.code,
                reading=index,
            )
        checked.append(found.query)
        if case.data_state == "live":
            unlisted = sorted(query_layers(found.query) - listed)
            if unlisted:
                raise _invalid(
                    case.id,
                    f"The case '{case.id}' uses the layer '{unlisted[0]}' without naming it.",
                    reason="layer_not_listed",
                    reading=index,
                    layer=unlisted[0],
                )
    if case.require is not None:
        source = case.require.source
        if source not in world.known or (case.data_state == "live" and source not in listed):
            raise _invalid(
                case.id,
                f"The case '{case.id}' requires the source '{source}', which it cannot use.",
                reason="unknown_layer",
                layer=source,
            )
    return checked


def reference_hits(case: EvalCase, world: World) -> list[int] | None:
    """Features of each reading on the case's data state (V2.3); ``None`` for a
    case without readings, a stale one, or one whose reading no longer runs."""
    if not readings(case) or status_of(case, world)[0] == "stale":
        return None
    hits = []
    for reading in readings(case):
        found = world.check(reading, case.schema_version)
        if isinstance(found, Refusal):
            return None
        count = world.count(found.query)
        if count is None:
            return None
        hits.append(count)
    return hits


# --- the cases of one administrator's request ----------------------------------


class Cases:
    """The start set and the own cases as one administrator works on them: a
    live world is that administrator's (D4). Worlds are made on first need, so
    a list of start cases builds no sample database."""

    def __init__(
        self,
        settings: Settings,
        backend: DataBackend,
        account: Account,
        limits: Limits,
        unsupported: Iterable[Op],
    ) -> None:
        self.settings = settings
        self.backend = backend
        self.account = account
        self.limits = limits
        self.unsupported = frozenset(unsupported)
        self.store = CaseStore(backend.engine)
        self.start = start_cases(settings)
        self._start_ids = {case.id: case for case in self.start}
        self._worlds: dict[DataState, World] = {}

    def world(self, data_state: DataState) -> World:
        if data_state not in self._worlds:
            self._worlds[data_state] = (
                sample_world(self.settings, self.limits)
                if data_state == "sample"
                else live_world(self.backend, self.account, self.limits, self.unsupported)
            )
        return self._worlds[data_state]

    def _view(self, stored: StoredCase | EvalCase, *, hits: bool) -> CaseView:
        if isinstance(stored, EvalCase):
            case, times, read_only = stored, {}, True
        else:
            case, read_only = stored.case, False
            times = {"created_at": stored.created_at, "updated_at": stored.updated_at}
        status: CaseStatus = "ok"
        layers: list[str] = []
        found: list[int] | None = None
        if case.data_state == "live" or hits:
            world = self.world(case.data_state)
            status, layers = status_of(case, world)
            if hits:
                found = reference_hits(case, world)
        return CaseView(
            case=case,
            status=status,
            status_layers=layers,
            read_only=read_only,
            reference_hits=found,
            **times,
        )

    def page(self, filters: CaseFilters, offset: int, limit: int) -> CasePage:
        """Start cases first, then the own ones oldest first (V1.1); each with
        its status, none with its hits."""
        start: list[StoredCase | EvalCase] = [c for c in self.start if filters.admits(c)]
        chosen = start + list(self.store.cases(filters))
        return CasePage(
            items=[self._view(c, hits=False) for c in chosen[offset : offset + limit]],
            total=len(chosen),
        )

    def get(self, case_id: str) -> CaseView:
        if case_id in self._start_ids:
            return self._view(self._start_ids[case_id], hits=True)
        stored = self.store.get(case_id)
        if stored is None:
            raise _not_found(case_id)
        return self._view(stored, hits=True)

    def _check_id(self, case_id: str) -> None:
        if case_id in self._start_ids:
            raise _taken(case_id)

    def _room(self, adding: int) -> None:
        held = self.store.count()
        if held + adding > MAX_CASES:
            raise _invalid(
                None,
                f"An instance keeps at most {MAX_CASES} own cases; it has {held}.",
                reason="too_many",
                max=MAX_CASES,
            )

    def create(self, case: EvalCase) -> CaseView:
        self._check_id(case.id)
        check_case(case, self.world(case.data_state))
        self._room(1)
        try:
            (stored,) = self.store.add([case])
        except CaseIdTaken:
            raise _taken(case.id) from None
        return self._view(stored, hits=True)

    def update(self, case_id: str, case: EvalCase) -> CaseView:
        """Editing a stale case so that it passes makes it run again (D3); the id
        may change to one that is free."""
        if case_id in self._start_ids:
            raise _read_only(case_id)
        if self.store.get(case_id) is None:
            raise _not_found(case_id)
        if case.id != case_id:
            self._check_id(case.id)
        check_case(case, self.world(case.data_state))
        try:
            stored = self.store.replace(case_id, case)
        except CaseIdTaken:
            raise _taken(case.id) from None
        if stored is None:
            raise _not_found(case_id)
        return self._view(stored, hits=True)

    def delete(self, case_id: str) -> None:
        if case_id in self._start_ids:
            raise _read_only(case_id)
        if not self.store.delete(case_id):
            raise _not_found(case_id)

    def export(self, *, start: bool) -> CaseFile:
        """The own cases as stored, with ``start`` the start set before them.
        ``format`` and ``version`` are set, so a file without ``null`` and unset
        fields still names itself."""
        own = [stored.case for stored in self.store.cases()]
        return CaseFile(
            format=CASE_FILE_FORMAT,
            version=CASE_FILE_VERSION,
            cases=[*(self.start if start else ()), *own],
        )

    def import_file(self, file: CaseFile) -> ImportResult:
        """All or nothing (V1.3): every case is checked as on creation, and one
        problem stores none. Cases keep their origin as the file writes it."""
        problems: list[ImportProblem] = []
        own = self.store.ids()
        for case in file.cases:
            try:
                if case.id in self._start_ids or case.id in own:
                    raise _taken(case.id)
                check_case(case, self.world(case.data_state))
            except CaseError as exc:
                problems.append(ImportProblem(case_id=case.id, code=exc.code, message=exc.message))
        if not problems:
            try:
                self._room(len(file.cases))
            except CaseError as exc:
                problems.append(ImportProblem(case_id=None, code=exc.code, message=exc.message))
        if problems:
            return ImportResult(imported=0, problems=problems)
        try:
            stored = self.store.add(file.cases)
        except CaseIdTaken as exc:
            # Another request stored one of the ids in the meantime.
            problem = _taken(str(exc.args[0]))
            return ImportResult(
                imported=0,
                problems=[
                    ImportProblem(
                        case_id=str(exc.args[0]) or None, code=problem.code, message=problem.message
                    )
                ],
            )
        return ImportResult(imported=len(stored))
