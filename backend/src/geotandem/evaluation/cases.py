"""Cases: the start set, the own cases, their data states and their checks
(plan E3, D1-D4, WP87).

The **start set** is the two files of ``schema/eval-cases`` (``Settings.
eval_cases_dir``), read once per process and never written: a start case is
read only, a copy of it becomes an own case. **Own cases** are the rows of
``CaseStore``; start and own cases together are at most ``MAX_CASES``, so an
export of both is still one case file. Ids are unique over both: an own case
cannot take a start id. Should a later start set bring an id an own case
already has, the start case wins on read, the list shows both, an edit or a
delete of the id reaches the own case, and an export with the start set
leaves the own case out; the start says so in its log (``check_start_set``),
naming the ids to rename.

A case runs on a **data state** (D1), here a ``World``: the backend it reads,
the layer profile the model gets over it and the checks of the model path.

- ``sample``: an isolated SpatiaLite database built from the packaged sample
  data as the harness builds it (``sample.build_sample``), once per process,
  then opened read-only, so the start set means the same whatever the live
  catalog holds;
- ``live``: the live catalog as the administrator sees it (D4), read-only.

A case is checked on its data state when it is created, edited or imported,
as a model's query is checked (``grade.check_reading``): a reference that
the application would refuse from a model cannot become the right answer.
A live case names exactly the layers it uses, each with the dataset version
it had when its reference was last checked: stamped on creation, and on an
edit of its readings, ``require`` or layers; an edit of tags, note or split
keeps them, and an imported file keeps its own. A named layer gone or
outside the administrator's model world makes it ``stale`` (D3), so a stale
case can only become stale, never be created. Its status is computed on
every read: ``stale``; ``invalid`` when its reference no longer passes the
checks or no longer runs (the list checks, the detail also counts);
``dataset_changed`` when a layer was re-imported since.

A case **from the log** (F-3.14, decision 2) is taken only from a model
action that ``not_eligible`` lets through: a direct query whose stored query
is what the user kept (see there). The draft route builds it (``Cases.draft``)
and ``POST`` and ``PUT`` with ``origin: log`` check the same rule, so a case
cannot be taken from a corrected answer by hand.

An imported case is ``origin: import``: an ``authored`` or ``log`` case of a
file becomes one, and its ``origin_action`` is dropped, since an action id of
another instance names nothing here.

Nothing here logs a case: prompts and references are the administrator's.
"""

from __future__ import annotations

import atexit
import json
import logging
import shutil
import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any, Final

from pydantic import ValidationError
from sqlalchemy import Engine

from geotandem.auth.accounts import Account
from geotandem.catalog import ModelProfile, dataset_versions, model_profile
from geotandem.config import Settings
from geotandem.data import DataBackend, Limits, Op
from geotandem.data.spatialite import SpatiaLiteBackend
from geotandem.data.view import LayerView
from geotandem.db.bootstrap import ConfigurationError
from geotandem.db.engine import make_engine
from geotandem.db.spatialite import reading
from geotandem.engine import QueryError, count_query
from geotandem.evaluation.diff import canonical
from geotandem.evaluation.grade import check_reading
from geotandem.evaluation.sample import build_sample
from geotandem.evaluation.schemas import (
    CASE_FILE_FORMAT,
    CASE_FILE_VERSION,
    MAX_CASES,
    CaseDraft,
    CaseFile,
    CaseLayer,
    CasePage,
    CaseStatus,
    CaseView,
    DataState,
    EvalCase,
    ImportProblem,
    ImportResult,
    Split,
)
from geotandem.evaluation.store import (
    CaseFilters,
    CaseIdTaken,
    CaseStore,
    StoredCase,
    TooManyCases,
    body_of,
)
from geotandem.model.errors import ActionError
from geotandem.model.record import ModelActionStore
from geotandem.model.represent import query_layers
from geotandem.model.schemas import ModelActionView, Refusal
from geotandem.model.service import profile_for
from geotandem.sample.load import dataset_version
from geotandem.tools import ToolContext
from geotandem_query import QueryObject, compact

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


def _problem(case_id: str | None, error: CaseError) -> ImportProblem:
    """A refusal as one problem of an import, with the details its error body has."""
    details = {k: v for k, v in error.details.items() if k != "case_id"}
    return ImportProblem(case_id=case_id, code=error.code, message=error.message, details=details)


def _read_only(case_id: str) -> CaseError:
    return CaseError(
        409,
        "case_read_only",
        f"The case '{case_id}' belongs to the start set; copy it into an own case.",
        case_id=case_id,
    )


def _not_found(case_id: str) -> CaseError:
    return CaseError(404, "not_found", f"There is no case '{case_id}'.", case_id=case_id)


def _taken(case_id: str | None) -> CaseError:
    if case_id is None:
        message = "An id of the file was taken meanwhile by another request."
    else:
        message = f"A case '{case_id}' exists already."
    return CaseError(409, "case_id_taken", message, case_id=case_id)


def _too_many(held: int, at_most: int) -> CaseError:
    return _invalid(
        None,
        f"An instance keeps at most {at_most} own cases beside the start set; it has {held}.",
        reason="too_many",
        max=at_most,
    )


# --- the start set -----------------------------------------------------------------


def cases_dir(settings: Settings) -> Path:
    return settings.eval_cases_dir or REPO_CASES


@cache
def start_set(directory: Path = REPO_CASES) -> tuple[EvalCase, ...]:
    """The start set of ``directory``, tuning first, read once per process: the
    one reader of the start set, for the application and the harness
    (``evals/casefiles.py``); ``ConfigurationError`` if it is missing or
    invalid."""
    try:
        texts = [(directory / name).read_text("utf-8") for name in START_FILES.values()]
    except OSError as exc:
        raise ConfigurationError(
            f"The start set of the evaluation is missing in {directory} "
            f"(GEOTANDEM_EVAL_CASES_DIR): {exc.strerror}."
        ) from None
    try:
        return tuple(case for text in texts for case in CaseFile.model_validate_json(text).cases)
    except ValidationError as exc:
        raise ConfigurationError(
            f"The start set of the evaluation in {directory} is no valid case file: "
            f"{exc.error_count()} errors."
        ) from None


def start_cases(settings: Settings) -> tuple[EvalCase, ...]:
    """Both files of the start set, tuning first, each case as its file writes
    it; ``ConfigurationError`` if they are missing or invalid."""
    return start_set(cases_dir(settings).resolve())


def sample_version() -> str:
    """The version of the packaged sample data, which a sample run's label names
    (``RunLabel.sample_version``)."""
    return dataset_version()


def check_start_set(settings: Settings, engine: Engine) -> None:
    """At start: the start set must be readable (the routes need it), and an
    own case whose id a new start set brings is named in the log."""
    ids = {case.id for case in start_cases(settings)}
    if clash := sorted(ids & CaseStore(engine).ids()):
        log.warning(
            "own evaluation cases share their id with a start case, which wins on "
            "read and in an export with the start set; rename them: %s",
            ", ".join(clash),
        )


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

    def attributes(self, layer: str) -> frozenset[str]:
        """The attributes of ``layer`` the model knows."""
        return frozenset(
            a.name for p in self.profile.layers if p.name == layer for a in p.attributes
        )

    def check(self, reading: dict[str, Any], schema_version: str) -> QueryObject | Refusal:
        """A reference as the harness stores it, checked as a model's query."""
        return check_reading(reading, schema_version, self.context, self.profile)

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
    versions = dataset_versions(view.engine, view.layer_names())
    context = ToolContext(view, limits, frozenset(unsupported))
    return World(data_state, context, profile, versions)


_sample_lock = threading.Lock()
_samples: dict[tuple[int, str], SpatiaLiteBackend] = {}


def _build_sample(settings: Settings) -> SpatiaLiteBackend:
    """The sample as ``build_sample`` builds it, then opened again read-only;
    removed at exit, or at once if building fails. Its own URL, so a
    configured ``database_url`` is never touched."""
    built = build_sample(settings)
    built.engine.dispose()
    engine: Engine | None = None
    try:
        read_only = built.settings.model_copy(
            update={"database_url": f"sqlite:///file:{built.path}?mode=ro&uri=true"}
        )
        engine = reading(make_engine(read_only))
        backend = SpatiaLiteBackend(engine, settings.internal_crs)
        backend.layer_names()  # fails here, not in the first request, if it cannot be read
    except BaseException:
        if engine is not None:
            engine.dispose()
        shutil.rmtree(built.directory, ignore_errors=True)
        raise
    atexit.register(shutil.rmtree, built.directory, ignore_errors=True)
    log.info("sample data state built for the evaluation")
    return backend


def sample_backend(settings: Settings) -> DataBackend:
    """The isolated sample database (D1), built on first use and kept for the
    process; read through a ``LayerView`` over a read-only connection."""
    key = (settings.internal_crs, settings.spatialite_library)
    with _sample_lock:
        if key not in _samples:
            _samples[key] = _build_sample(settings)
        backend = _samples[key]
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


def _gone(case: EvalCase, world: World) -> list[str]:
    """The named layers of a live case outside the model's world (D3)."""
    if case.data_state != "live":
        return []
    return [layer.name for layer in case.layers if layer.name not in world.known]


def _changed(case: EvalCase, world: World) -> list[str]:
    """The layers of a live case with another dataset version than when its
    reference was last checked (D3)."""
    if case.data_state != "live":
        return []
    return [
        layer.name
        for layer in case.layers
        if world.versions.get(layer.name) != layer.dataset_version
    ]


def _check_require(case: EvalCase, world: World) -> set[str]:
    """The layers a ``require`` names, each in the model's world, and every
    attribute a condition names on one of them; the conditions are a flat list,
    so an attribute may belong to the source or to a layer a condition names."""
    if case.require is None:
        return set()
    named = {case.require.source} | {
        c.layer for c in case.require.conditions if c.layer is not None
    }
    for layer in sorted(named):
        if layer not in world.known:
            raise _invalid(
                case.id,
                f"The case '{case.id}' requires the layer '{layer}', which it cannot use.",
                reason="unknown_layer",
                layer=layer,
            )
    attributes = frozenset().union(*(world.attributes(layer) for layer in named))
    for condition in case.require.conditions:
        attr = condition.attr
        if attr is not None and attr not in attributes:
            raise _invalid(
                case.id,
                f"The case '{case.id}' requires the attribute '{attr}', which it cannot use.",
                reason="unknown_attribute",
                attribute=attr,
            )
    return named


def _checked(case: EvalCase, world: World) -> tuple[list[QueryObject], set[str]]:
    """Each reading checked as a model's query, no two of one canonical form
    (stage 1, ``diff.canonical``), and what a ``require`` names known: the
    readings as they run and the layers the reference uses; ``case_invalid``
    otherwise (the refusal's code is the reason)."""
    queries: list[QueryObject] = []
    used: set[str] = set()
    seen: dict[str, int] = {}
    for index, doc in enumerate(case.readings()):
        found = world.check(doc, case.schema_version)
        if isinstance(found, Refusal):
            # The refusal's details (attribute, layer, limit …) name what failed;
            # ``reason``, ``reading`` and ``case_id`` are the case's own and win.
            named = {
                k: v for k, v in found.details.items() if k not in ("reason", "reading", "case_id")
            }
            raise _invalid(
                case.id,
                f"Reading {index} of the case '{case.id}' fails the checks: {found.message}",
                reason=found.code,
                reading=index,
                **named,
            )
        key = json.dumps(canonical(found), sort_keys=True)
        if key in seen:
            raise _invalid(
                case.id,
                f"Readings {seen[key]} and {index} of the case '{case.id}' are the same query.",
                reason="duplicate_reading",
                reading=index,
                same_as=seen[key],
            )
        seen[key] = index
        queries.append(found)
        used |= query_layers(found)
    used |= _check_require(case, world)
    return queries, used


def assess_case(
    case: EvalCase, world: World, *, count: bool
) -> tuple[CaseStatus, list[str], list[int] | None]:
    """D3 on read: the status, the layers behind it, and with ``count`` the
    features of each reading (V2.3). ``stale``: a named layer is outside the
    model's world; ``invalid``: the reference no longer passes the checks (or,
    counted, a reading no longer runs); ``dataset_changed``: a layer was
    re-imported since. Hits are ``None`` for a case without readings, a stale
    or an invalid one, and without ``count``."""
    if gone := _gone(case, world):
        return "stale", gone, None
    try:
        queries, _ = _checked(case, world)
    except CaseError:
        return "invalid", [], None
    hits: list[int] | None = None
    if count and queries:
        counted = [world.count(query) for query in queries]
        if any(n is None for n in counted):
            return "invalid", [], None
        hits = [n for n in counted if n is not None]
    if changed := _changed(case, world):
        return "dataset_changed", changed, hits
    return "ok", [], hits


def check_case(case: EvalCase, world: World, *, stamp: bool) -> EvalCase:
    """The rules an own case meets before it is stored; the case as stored.

    ``case_invalid``: a start case's origin, a reading the model path would
    refuse (the refusal's code is the reason), two readings of one canonical
    form (``duplicate_reading``), a required layer or attribute the model does
    not know, a live case whose named layers are not the layers it uses;
    ``case_stale``: a named layer is not in the model's world. With ``stamp``,
    a live case's layers get their dataset versions of now."""
    if case.origin == "start":
        raise _invalid(case.id, "Only the start set says origin 'start'.", reason="origin_start")
    if layers := _gone(case, world):
        raise CaseError(
            409,
            "case_stale",
            f"The case '{case.id}' uses the layer '{layers[0]}', which is gone or hidden.",
            case_id=case.id,
            layer=layers[0],
            layers=layers,
        )
    _, used = _checked(case, world)
    if case.data_state != "live":
        return case
    listed = {layer.name for layer in case.layers}
    if unlisted := sorted(used - listed):
        raise _invalid(
            case.id,
            f"The case '{case.id}' uses the layer '{unlisted[0]}' without naming it.",
            reason="layer_not_listed",
            layer=unlisted[0],
        )
    if unused := sorted(listed - used):
        raise _invalid(
            case.id,
            f"The case '{case.id}' names the layer '{unused[0]}', which it does not use.",
            reason="layer_not_used",
            layer=unused[0],
        )
    if not stamp:
        return case
    current = [
        CaseLayer(name=layer.name, dataset_version=world.versions[layer.name])
        for layer in case.layers
    ]
    return case.model_copy(update={"layers": current})


def reference_changed(old: EvalCase, new: EvalCase) -> bool:
    """Whether an edit touches what the reference demands (its readings,
    ``require``, layers, data state or schema version): only then are a live
    case's dataset versions stamped again (D3), so *Datenstand geändert* means
    "since the reference was last checked"."""
    return (
        old.readings() != new.readings()
        or old.require != new.require
        or [layer.name for layer in old.layers] != [layer.name for layer in new.layers]
        or old.data_state != new.data_state
        or old.schema_version != new.schema_version
    )


def as_imported(case: EvalCase) -> EvalCase:
    """A file's ``authored`` or ``log`` case as this instance keeps it: ``import``,
    without the action id of another instance. Other fields stay as written."""
    if case.origin not in ("authored", "log"):
        return case
    body = body_of(case)
    body.pop("origin_action", None)
    return EvalCase.model_validate({**body, "origin": "import"})


# --- a case from the log (F-3.14) ------------------------------------------------

LOG_DECISIONS: Final = frozenset({"accepted", "auto"})
"""The decisions of a model action a case may be taken from: the user approved
the model's query, or the level let it run unasked."""
RENDER_HINTS: Final = ("schema_version", "output", "symbology")
"""Keys of a query object a case's reference leaves out: the case names the
schema version beside it, the others only draw (as the harness writes it)."""


def not_eligible(action: ModelActionView) -> str | None:
    """Why ``action`` cannot become a case, or ``None`` if it can (decision 2).
    The first reason that holds, in this order:

    - ``approach``: a chain (the direct query first, plan E3 section 0);
    - ``follow_up``: a follow-up (``parent_action_id``): its prompt depends on
      the earlier answer or analysis, which a case does not carry, and one on
      a hand-edited analysis is the hand-corrected lineage decision 2 excludes;
    - ``decision``: neither ``accepted`` nor ``auto``: refused, answered, open,
      rejected, superseded, proposal only, or ``adjusted`` (the user applied
      another query than the model's);
    - ``undone``: taken back (``undone_at``; the decision stays for the log);
    - ``touched``: the analysis was edited by hand after the action was
      applied (``touched_at``), so what the user kept is no longer only the
      model's query;
    - ``no_query``: no stored query to be the reference.
    """
    if action.approach != "direct":
        return "approach"
    if action.parent_action_id is not None:
        return "follow_up"
    if action.decision not in LOG_DECISIONS:
        return "decision"
    if action.undone_at is not None:
        return "undone"
    if action.touched_at is not None:
        return "touched"
    if action.query is None:
        return "no_query"
    return None


def _check_eligible(action: ModelActionView, case_id: str | None = None) -> None:
    """``action_not_eligible`` (409, as the other refusals of a state) unless
    ``not_eligible`` lets ``action`` through."""
    if (reason := not_eligible(action)) is None:
        return
    raise CaseError(
        409,
        "action_not_eligible",
        f"The model action {action.id} cannot become a case ({reason}).",
        case_id=case_id,
        action_id=action.id,
        decision=action.decision,
        reason=reason,
    )


def draft_of(action: ModelActionView) -> CaseDraft:
    """The case ``action`` gives, for the administrator to complete (V2
    prefilled): its prompt, its stored query as the reference as a case stores
    it, on the live data with the layers it uses; the save stamps their dataset
    versions (D3). ``action_not_eligible`` unless ``not_eligible`` lets it through."""
    _check_eligible(action)
    query = action.query
    assert query is not None
    doc = {k: v for k, v in compact(query).items() if k not in RENDER_HINTS}
    return CaseDraft(
        prompt=action.prompt,
        data_state="live",
        origin="log",
        origin_action=action.id,
        schema_version=query.schema_version,
        gold=doc,
        layers=[CaseLayer(name=name) for name in sorted(query_layers(query))],
    )


# --- the cases of one administrator's request ----------------------------------


class Cases:
    """The start set and the own cases as one administrator works on them: a
    live world is that administrator's (D4). Worlds are made on first need; the
    sample's database is built once per process (``sample_backend``)."""

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

    @property
    def room(self) -> int:
        """Own cases the instance may hold: start and own fit one case file."""
        return MAX_CASES - len(self.start)

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
        status, layers, found = assess_case(case, self.world(case.data_state), count=hits)
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
        chosen = start + self.store.cases(filters)
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

    def _action(self, action_id: int) -> ModelActionView | None:
        """The model action as this administrator reads it (any account's), or ``None``."""
        try:
            return ModelActionStore(self.backend.engine).get(self.account, action_id)
        except ActionError:
            return None

    def draft(self, action_id: int) -> CaseDraft:
        """A case from a model action, not stored (F-3.14): ``not_found`` for an
        unknown action, ``action_not_eligible`` for one ``not_eligible`` stops."""
        action = self._action(action_id)
        if action is None:
            raise CaseError(
                404, "not_found", f"There is no model action {action_id}.", action_id=action_id
            )
        return draft_of(action)

    def _check_origin(self, case: EvalCase, before: EvalCase | None = None) -> None:
        """A ``log`` case names a model action of this instance (F-3.14) that may
        become a case (``not_eligible``). An edit that keeps the stored case's
        action is not checked again: what became of the action after the case
        was taken (an undo, a later hand edit) does not lock the case."""
        if case.origin != "log" or case.origin_action is None:
            return
        if before is not None and before.origin_action == case.origin_action:
            return
        action = self._action(case.origin_action)
        if action is None:
            raise _invalid(
                case.id,
                f"The case '{case.id}' names the model action {case.origin_action}, "
                "which does not exist.",
                reason="origin_action",
                origin_action=case.origin_action,
            )
        _check_eligible(action, case.id)

    def create(self, case: EvalCase) -> CaseView:
        if case.id in self._start_ids:
            raise _taken(case.id)
        self._check_origin(case)
        case = check_case(case, self.world(case.data_state), stamp=True)
        try:
            (stored,) = self.store.add([case], at_most=self.room)
        except CaseIdTaken:
            raise _taken(case.id) from None
        except TooManyCases as exc:
            raise _too_many(*exc.args) from None
        return self._view(stored, hits=True)

    def update(self, case_id: str, case: EvalCase) -> CaseView:
        """Editing a stale or invalid case so that it passes makes it run again
        (D3); the id may change to one that is free. An own case behind a start
        id is reached here; the start case stays read-only. A live case's
        dataset versions are stamped again only when its reference changes
        (``reference_changed``)."""
        old = self.store.get(case_id)
        if old is None:
            raise _read_only(case_id) if case_id in self._start_ids else _not_found(case_id)
        if case.id != case_id and case.id in self._start_ids:
            raise _taken(case.id)
        self._check_origin(case, old.case)
        restamp = reference_changed(old.case, case)
        case = check_case(case, self.world(case.data_state), stamp=restamp)
        if not restamp and case.data_state == "live":
            case = case.model_copy(update={"layers": old.case.layers})
        try:
            stored = self.store.replace(case_id, case)
        except CaseIdTaken:
            raise _taken(case.id) from None
        if stored is None:
            raise _not_found(case_id)
        return self._view(stored, hits=True)

    def delete(self, case_id: str) -> None:
        """An own case behind a start id is reached here; the start case stays."""
        if self.store.delete(case_id):
            return
        raise _read_only(case_id) if case_id in self._start_ids else _not_found(case_id)

    def export(self, *, start: bool) -> CaseFile:
        """The own cases as stored, with ``start`` the start set before them;
        then an own case behind a start id is left out (one file, unique ids)
        and named in the log. ``format`` and ``version`` are set, so a file
        without ``null`` and unset fields still names itself."""
        own = [stored.case for stored in self.store.cases()]
        if start and (hidden := [c.id for c in own if c.id in self._start_ids]):
            log.warning(
                "export with the start set leaves out own cases behind a start id: %s",
                ", ".join(hidden),
            )
            own = [c for c in own if c.id not in self._start_ids]
        return CaseFile(
            format=CASE_FILE_FORMAT,
            version=CASE_FILE_VERSION,
            cases=[*(self.start if start else ()), *own],
        )

    def import_file(self, file: CaseFile) -> ImportResult:
        """All or nothing (V1.3): every case is checked as on creation, but keeps
        the dataset versions the file gives; one problem stores none."""
        problems: list[ImportProblem] = []
        own = self.store.ids()
        taken: list[EvalCase] = []
        for case in file.cases:
            try:
                if case.id in self._start_ids or case.id in own:
                    raise _taken(case.id)
                check_case(case, self.world(case.data_state), stamp=False)
                taken.append(as_imported(case))
            except CaseError as exc:
                problems.append(_problem(case.id, exc))
        if problems:
            return ImportResult(imported=0, problems=problems)
        try:
            stored = self.store.add(taken, at_most=self.room)
        except (CaseIdTaken, TooManyCases) as exc:
            error = _taken(exc.args[0]) if isinstance(exc, CaseIdTaken) else _too_many(*exc.args)
            return ImportResult(imported=0, problems=[_problem(error.details["case_id"], error)])
        return ImportResult(imported=len(stored))
