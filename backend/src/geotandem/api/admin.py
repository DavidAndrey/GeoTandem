"""Administration interface (F-3.1): import and layer management (E1.3).

Every route that changes data lives here, under one router, so a single
dependency guards all of them once accounts exist (E1.4, plan D5).
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from geotandem.api.errors import ErrorBody, NotFound, Problem
from geotandem.api.state import AppState, get_state
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
from geotandem.importing import Preview, ReadOptions, SourceError
from geotandem.importing import log as import_log
from geotandem.importing.log import ImportRunInfo, ImportRunSummary, ImportStatus
from geotandem.importing.run import ImportDecisions, abort, preview_file, run_import
from geotandem.importing.staging import UnknownUpload, UploadTooLarge

router = APIRouter(prefix="/api/admin", tags=["admin"])
State = Annotated[AppState, Depends(get_state)]

ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorBody} for status in (400, 404, 413, 422)
}


class TooLarge(Problem):
    status = 413
    code = "upload_too_large"


class SourceProblem(Problem):
    """A file that cannot be read as given (design D11); ``details.code`` says why."""

    code = "unreadable_source"


def actor(state: State) -> str | None:
    """The account behind a change; E1.4 replaces this with the signed-in user."""
    return None


Actor = Annotated[str | None, Depends(actor)]


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
def patch_layer(name: str, body: LayerUpdate, state: State) -> LayerInfo:
    """Rename (title only, the identifier stays) and describe a layer (F-2.7, F-2.8)."""
    info = update_layer(state.backend.engine, name, body)
    if info is None:
        raise NotFound(f"Unknown layer '{name}'.", layer=name)
    return info


@router.patch("/layers/{name}/attributes/{attribute}", responses=ERRORS)
def patch_attribute(
    name: str, attribute: str, body: AttributeUpdate, state: State
) -> AttributeInfo:
    """Attribute metadata (F-2.8)."""
    info = update_attribute(state.backend.engine, name, attribute, body)
    if info is None:
        raise NotFound(f"Unknown attribute '{name}.{attribute}'.", layer=name, attribute=attribute)
    return info


@router.delete("/layers/{name}", status_code=204, responses=ERRORS)
def delete_layer(name: str, state: State) -> Response:
    """Delete a layer and its data for good (F-2.7; no archive, plan D2)."""
    _layer(state, name)
    state.backend.drop_layer(name)
    return Response(status_code=204)


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
async def upload(state: State, file: Annotated[UploadFile, File()]) -> Upload:
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
    path = state.staging.path(import_id)
    try:
        preview = await run_in_threadpool(
            preview_file, path, path.name, ReadOptions(), state.backend
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
        return preview_file(path, path.name, body, state.backend)
    except SourceError as exc:
        raise _source_problem(exc) from None


@router.post("/imports/{import_id}/commit", responses=ERRORS)
def commit(import_id: str, body: ImportDecisions, state: State, user: Actor) -> ImportRunInfo:
    """Import with the wizard's decisions. The outcome, also a failed one, is in ``status``.

    A successful import removes the staged file; after a failed one it stays,
    so the decisions can be corrected and committed again.
    """
    path = _staged(state, import_id)
    run = run_import(path, path.name, body, state.backend, actor=user)
    if run.status in ("ok", "warning"):
        state.staging.delete(import_id)
    return run


@router.delete("/imports/{import_id}", responses=ERRORS)
def cancel(import_id: str, state: State, user: Actor) -> ImportRunInfo:
    """Close the wizard without importing; logged as aborted (design D7)."""
    path = _staged(state, import_id)
    run = abort(state.backend.engine, path.name, actor=user)
    state.staging.delete(import_id)
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
