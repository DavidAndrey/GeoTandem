"""Administration interface (F-3.1): import and layer management (E1.3).

Every route that changes geodata, the catalog or accounts lives here, under
one router, so a single dependency guards all of them (E1.4, plan D5). What a
user writes for themselves — their password, their sessions (E1.7) — lives
with the user's own routes.
"""

import re
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from geotandem import __version__, audit
from geotandem.api.auth import require_admin
from geotandem.api.errors import ErrorBody, NotFound, Problem
from geotandem.api.state import AppState, get_state
from geotandem.auth import accounts, visibility
from geotandem.auth.accounts import Account, AccountUpdate
from geotandem.auth.visibility import VisibilityRow
from geotandem.catalog import (
    AttributeInfo,
    AttributeUpdate,
    LayerInfo,
    LayerProfile,
    LayerUpdate,
    get_layer,
    list_layers,
    profile,
    update_attribute,
    update_layer,
)
from geotandem.data import LayerExists, Op
from geotandem.db.orm import Role
from geotandem.importing import Message, Preview, ReadOptions, SourceError
from geotandem.importing import log as import_log
from geotandem.importing.log import ImportRunInfo, ImportRunSummary, ImportStatus
from geotandem.importing.run import ImportDecisions, abort, preview_file, run_import
from geotandem.importing.staging import TooManyPending, UnknownUpload, UploadTooLarge
from geotandem.sample.load import dataset_version
from geotandem_query import SCHEMA_VERSION

# One guard for every route below (plan D5): signed in, start password changed, admin.
router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])
State = Annotated[AppState, Depends(get_state)]

ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorBody} for status in (400, 401, 403, 404, 413, 422)
}


class TooLarge(Problem):
    status = 413
    code = "upload_too_large"


class PendingImports(Problem):
    status = 409
    code = "too_many_pending_imports"


class SourceProblem(Problem):
    """A file that cannot be read as given (design D11); ``details.code`` says why."""

    code = "unreadable_source"


def actor(account: Annotated[Account, Depends(require_admin)]) -> str:
    """The account behind a change, for the import log."""
    return account.username


Actor = Annotated[str, Depends(actor)]


def _fields(body: BaseModel) -> list[str]:
    """Which fields a change set, for the security log; their values may be long texts."""
    return sorted(body.model_dump(exclude_unset=True))


# --- system ---------------------------------------------------------------------


class Capabilities(BaseModel):
    supported: list[Op]
    missing: dict[Op, list[str]]


class SystemStatus(BaseModel):
    """What the instance runs on; for administrators only (security review #10)."""

    status: Literal["ok", "degraded"]
    version: str
    backend: str
    internal_crs: int
    schema_version: str
    sample_dataset_version: str
    capabilities: Capabilities


@router.get("/system")
def system(state: State) -> SystemStatus:
    missing = state.unsupported
    return SystemStatus(
        status="degraded" if missing else "ok",
        version=__version__,
        backend=state.backend.name,
        internal_crs=state.backend.internal_srid,
        schema_version=SCHEMA_VERSION,
        sample_dataset_version=dataset_version(),
        capabilities=Capabilities(
            supported=[op for op in Op if op not in missing], missing=missing
        ),
    )


# --- layers -------------------------------------------------------------------


class AdminLayerInfo(LayerInfo):
    last_import: ImportRunSummary | None


@router.get("/layers")
def layers(state: State) -> list[AdminLayerInfo]:
    """The data catalog (design D2)."""
    last = import_log.last_per_layer(state.backend.engine)
    return [
        AdminLayerInfo(**info.model_dump(), last_import=last.get(info.name))
        for info in list_layers(state.backend.engine)
    ]


def _layer(state: AppState, name: str) -> LayerInfo:
    info = get_layer(state.backend.engine, name)
    if info is None:
        raise NotFound(f"Unknown layer '{name}'.", layer=name)
    return info


@router.patch("/layers/{name}", responses=ERRORS)
def patch_layer(name: str, body: LayerUpdate, state: State, user: Actor) -> LayerInfo:
    """Rename (title only, the identifier stays) and describe a layer (F-2.7, F-2.8)."""
    info = update_layer(state.backend.engine, name, body)
    if info is None:
        raise NotFound(f"Unknown layer '{name}'.", layer=name)
    audit.event("layer_updated", username=user, layer=name, fields=_fields(body))
    return info


@router.patch("/layers/{name}/attributes/{attribute}", responses=ERRORS)
def patch_attribute(
    name: str, attribute: str, body: AttributeUpdate, state: State, user: Actor
) -> AttributeInfo:
    """Attribute metadata (F-2.8)."""
    info = update_attribute(state.backend.engine, name, attribute, body)
    if info is None:
        raise NotFound(f"Unknown attribute '{name}.{attribute}'.", layer=name, attribute=attribute)
    audit.event(
        "attribute_updated", username=user, layer=name, attribute=attribute, fields=_fields(body)
    )
    return info


@router.delete("/layers/{name}", status_code=204, responses=ERRORS)
def delete_layer(name: str, state: State, user: Actor) -> Response:
    """Delete a layer and its data for good (F-2.7; no archive, plan D2)."""
    _layer(state, name)
    state.backend.drop_layer(name)
    audit.event("layer_deleted", username=user, layer=name)
    return Response(status_code=204)


IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
"""A layer name as the data core stores it (importing.names)."""


class Duplicate(BaseModel):
    name: str | None = None
    """Identifier of the copy; "<name>_kopie" (numbered if taken) when empty."""
    title: str | None = None
    """Defaults to "<title> (Kopie)"."""


class InvalidLayerName(Problem):
    code = "invalid_layer_name"


class LayerNameTaken(Problem):
    status = 409
    code = "layer_exists"


@router.post("/layers/{name}/duplicate", status_code=201, responses={**ERRORS, 409: ERRORS[400]})
def duplicate_layer(name: str, body: Duplicate, state: State, user: Actor) -> LayerInfo:
    """A copy of a layer: data, metadata and visibility (design D2), logged like an import."""
    source = _layer(state, name)
    engine = state.backend.engine
    taken = set(state.backend.layer_names())
    target = body.name or next(
        (
            n
            for n in (f"{name[:57]}_kopie", *(f"{name[:55]}_kopie{i}" for i in range(2, 100)))
            if n not in taken
        ),
        None,
    )
    if target is None:
        raise LayerNameTaken(f"Every copy name of '{name}' is taken; please give one.", layer=name)
    if not IDENTIFIER.match(target):
        raise InvalidLayerName(f"'{target}' is not a valid layer name.", name=target)
    run_id = import_log.start(
        engine,
        source_name=name,
        source_format="layer",
        mode="duplicate",
        layer_name=target,
        actor=user,
    )
    try:
        count = state.backend.duplicate_layer(name, target, body.title or f"{source.title} (Kopie)")
    except LayerExists:
        import_log.finish(
            engine,
            run_id,
            status="failed",
            errors=[Message(code="layer_exists", message=f"Layer '{target}' exists already.")],
        )
        raise LayerNameTaken(f"Layer '{target}' exists already.", layer=target) from None
    except Exception:
        # The entry must not stay "running"; the error goes on to the server log.
        import_log.finish(
            engine,
            run_id,
            status="failed",
            errors=[Message(code="internal_error", message="The copy stopped unexpectedly.")],
        )
        raise
    visibility.copy_visibility(engine, name, target)
    import_log.finish(engine, run_id, status="ok", read_count=count, imported_count=count)
    audit.event("layer_duplicated", username=user, layer=name, copy=target)
    return _layer(state, target)


@router.get("/layers/{name}/profile", responses=ERRORS)
def layer_profile(name: str, state: State) -> LayerProfile | None:
    """The layer profile as the model will see it (F-2.9); ``null`` if not for the model."""
    return profile(_layer(state, name))


# --- import wizard (design D6) ------------------------------------------------


class Upload(BaseModel):
    import_id: str
    preview: Preview


def _source_problem(exc: SourceError) -> SourceProblem:
    return SourceProblem(exc.message, reason=exc.code, **exc.details)


def _staged(state: AppState, import_id: str) -> Any:
    try:
        return state.staging.path(import_id)
    except UnknownUpload:
        raise NotFound(f"Unknown import '{import_id}'.", import_id=import_id) from None


@router.post("/imports", responses=ERRORS)
async def upload(state: State, file: Annotated[UploadFile, File()], user: Actor) -> Upload:
    """Step 1: stage the file and preview it with detected options (F-2.4)."""
    max_bytes = state.settings.max_import_mb * 1024 * 1024
    try:
        import_id = await run_in_threadpool(
            state.staging.save, file.filename or "upload", file.file, max_bytes
        )
    except UploadTooLarge:
        raise TooLarge(
            f"The file exceeds {state.settings.max_import_mb} MB.",
            max_mb=state.settings.max_import_mb,
        ) from None
    except TooManyPending as exc:
        raise PendingImports(
            f"{exc.args[0]} uploads are waiting for their import already; "
            "import or cancel one first.",
            max=exc.args[0],
        ) from None
    audit.event("import_uploaded", username=user, file=file.filename, import_id=import_id)
    path = state.staging.path(import_id)
    try:
        preview = await run_in_threadpool(
            preview_file, path, path.name, ReadOptions(), state.backend, state.read_limits
        )
    except SourceError as exc:
        state.staging.delete(import_id)
        raise _source_problem(exc) from None
    return Upload(import_id=import_id, preview=preview)


@router.post("/imports/{import_id}/preview", responses=ERRORS)
def repreview(import_id: str, body: ReadOptions, state: State) -> Preview:
    """Read again with other options: encoding, delimiter, sheet or layer (design D11)."""
    path = _staged(state, import_id)
    try:
        return preview_file(path, path.name, body, state.backend, state.read_limits)
    except SourceError as exc:
        raise _source_problem(exc) from None


@router.post("/imports/{import_id}/commit", responses=ERRORS)
def commit(import_id: str, body: ImportDecisions, state: State, user: Actor) -> ImportRunInfo:
    """Import with the wizard's decisions. The outcome, also a failed one, is in ``status``.

    A successful import removes the staged file; after a failed one it stays,
    so the decisions can be corrected and committed again.
    """
    path = _staged(state, import_id)
    run = run_import(path, path.name, body, state.backend, actor=user, limits=state.read_limits)
    audit.event(
        "import_committed",
        username=user,
        import_id=import_id,
        layer=run.layer_name,
        replaced=body.replace,
        status=run.status,
    )
    if run.status in ("ok", "warning"):
        state.staging.delete(import_id)
        if body.replace is None and run.layer_name:
            # A replaced layer keeps its visibility; a new one follows the setting (D10).
            visibility.apply_default(state.backend.engine, run.layer_name)
    return run


@router.delete("/imports/{import_id}", responses=ERRORS)
def cancel(import_id: str, state: State, user: Actor) -> ImportRunInfo:
    """Close the wizard without importing; logged as aborted (design D7)."""
    path = _staged(state, import_id)
    run = abort(state.backend.engine, path.name, actor=user)
    state.staging.delete(import_id)
    audit.event("import_cancelled", username=user, import_id=import_id)
    return run


# --- import log (F-2.10, design D7/D8) ----------------------------------------


@router.get("/import-log")
def import_runs(
    state: State,
    status: ImportStatus | None = None,
    layer: str | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> list[ImportRunSummary]:
    return import_log.recent(state.backend.engine, status=status, layer_name=layer, limit=limit)


@router.get("/import-log/{run_id}", responses=ERRORS)
def import_run(run_id: int, state: State) -> ImportRunInfo:
    run = import_log.get(state.backend.engine, run_id)
    if run is None:
        raise NotFound(f"Unknown import run {run_id}.", run_id=run_id)
    return run


# --- accounts (F-3.12, design D9) ---------------------------------------------


class NewAccount(BaseModel):
    username: str
    display_name: str = ""
    role: Role = "user"


class StartPassword(BaseModel):
    """Shown once to the administrator; the user must change it at first sign-in."""

    account: Account
    start_password: str


@router.get("/users")
def users(state: State) -> list[Account]:
    return accounts.list_accounts(state.backend.engine)


@router.post("/users", status_code=201, responses=ERRORS)
def create_user(body: NewAccount, state: State, user: Actor) -> StartPassword:
    password = accounts.generate_password()
    account = accounts.create(
        state.backend.engine,
        body.username,
        password,
        body.role,
        display_name=body.display_name,
        must_change_password=True,
    )
    audit.event("account_created", username=user, account=account.username, role=account.role)
    return StartPassword(account=account, start_password=password)


@router.patch("/users/{username}", responses=ERRORS)
def update_user(username: str, body: AccountUpdate, state: State, user: Actor) -> Account:
    """Change role, lock or unlock, rename; never the last active administrator away."""
    account = accounts.update(state.backend.engine, username, body)
    changes = body.model_dump(exclude_unset=True)
    audit.event("account_updated", username=user, account=account.username, changes=changes)
    return account


@router.post("/users/{username}/reset-password", responses=ERRORS)
def reset_password(username: str, state: State, user: Actor) -> StartPassword:
    account, password = accounts.reset_password(state.backend.engine, username)
    audit.event("account_password_reset", username=user, account=account.username)
    return StartPassword(account=account, start_password=password)


@router.delete("/users/{username}", status_code=204, responses=ERRORS)
def delete_user(username: str, state: State, user: Actor) -> Response:
    accounts.delete(state.backend.engine, username)
    audit.event("account_deleted", username=user, account=username.strip().lower())
    return Response(status_code=204)


# --- visibility (F-2.7, design D10) -------------------------------------------


class VisibilityChange(BaseModel):
    layer: str
    role: Literal["user"]
    visible: bool


@router.get("/visibility")
def visibility_matrix(state: State) -> list[VisibilityRow]:
    """Layer by role; administrators always see every layer. New imports start hidden."""
    return visibility.matrix(state.backend.engine)


class VisibilityDefault(BaseModel):
    new_layers_visible: bool
    """New layers released for users at once; otherwise they wait for release (D10)."""


@router.get("/visibility/default")
def visibility_default(state: State) -> VisibilityDefault:
    return VisibilityDefault(new_layers_visible=visibility.new_layers_visible(state.backend.engine))


@router.put("/visibility/default")
def set_visibility_default(body: VisibilityDefault, state: State, user: Actor) -> VisibilityDefault:
    visibility.set_new_layers_visible(state.backend.engine, body.new_layers_visible)
    audit.event(
        "visibility_default_changed", username=user, new_layers_visible=body.new_layers_visible
    )
    return body


@router.put("/visibility", responses=ERRORS)
def set_visibility(body: VisibilityChange, state: State, user: Actor) -> list[VisibilityRow]:
    if not visibility.set_visible(state.backend.engine, body.layer, body.role, body.visible):
        raise NotFound(f"Unknown layer '{body.layer}'.", layer=body.layer)
    audit.event(
        "visibility_changed",
        username=user,
        layer=body.layer,
        role=body.role,
        visible=body.visible,
    )
    return visibility.matrix(state.backend.engine)
