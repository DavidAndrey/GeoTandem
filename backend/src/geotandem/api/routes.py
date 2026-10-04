"""HTTP interface v0 (E1.2). Contract for the frontend; types are generated from it."""

import time
from dataclasses import replace
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from geotandem.api.auth import CurrentAccount
from geotandem.api.errors import ErrorBody
from geotandem.api.state import AppState, get_state
from geotandem.auth.visibility import view_for
from geotandem.basemap import Basemap, resolve
from geotandem.catalog import LayerInfo, get_layer, list_layers
from geotandem.data import DataBackend, Op
from geotandem.engine import (
    QueryError,
    QueryResult,
    count_query,
    ids_query,
    run_query,
    validate_query,
)
from geotandem.engine.errors import QueryTimedOut, UnknownLayer
from geotandem.tools import ToolDescription
from geotandem_query import QueryObject
from geotandem_query.export import json_schema

router = APIRouter(prefix="/api")
State = Annotated[AppState, Depends(get_state)]


def visible_backend(state: State, account: CurrentAccount) -> DataBackend:
    """The data core restricted to the layers this account may see (F-2.7)."""
    return view_for(state.backend, account)


Visible = Annotated[DataBackend, Depends(visible_backend)]

ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorBody} for status in (400, 404, 413, 422, 504)
}


class LayerNotFound(UnknownLayer):
    status = 404


class Health(BaseModel):
    """For the container's health check and monitors: nothing else, as anyone may ask
    (security review #10). Version, backend and capabilities are the administrators'
    (``/api/admin/system``)."""

    status: Literal["ok", "degraded"]


class Validation(BaseModel):
    valid: Literal[True] = True
    layers: list[str]
    operations: list[Op]


@router.get("/health")
def health(state: State) -> Health:
    return Health(status="degraded" if state.unsupported else "ok")


@router.get("/layers")
def layers(backend: Visible) -> list[LayerInfo]:
    return list_layers(backend.engine, only=backend.layer_names())


@router.get("/layers/{name}", responses=ERRORS)
def layer(name: str, backend: Visible) -> LayerInfo:
    info = get_layer(backend.engine, name) if name in backend.layer_names() else None
    if info is None:
        raise LayerNotFound(f"Unknown layer '{name}'.", layer=name)
    return info


@router.post("/query", responses=ERRORS)
def query(body: QueryObject, state: State, backend: Visible) -> QueryResult:
    """Run a query object (F-8.9); the result carries its query and provenance."""
    return run_query(body, backend, state.limits, state.unsupported)


MAX_COUNT_QUERIES = 50


class CountRequest(BaseModel):
    queries: list[QueryObject] = Field(min_length=1, max_length=MAX_COUNT_QUERIES)


class Counts(BaseModel):
    counts: list[int]
    """In the order of ``queries``."""


@router.post("/query/count", responses=ERRORS)
def count(body: CountRequest, state: State, backend: Visible) -> Counts:
    """Count the features of several queries at once, e.g. one per condition (design B2).

    Nothing but numbers leaves the server. A rejected query names its position
    in ``details.index``. All of them share one time limit, as one query would:
    a request of many slow counts must not hold a worker many times as long.
    """
    budget = state.limits.timeout_s
    deadline = time.monotonic() + budget
    counts = []
    for index, query in enumerate(body.queries):
        left = deadline - time.monotonic()
        try:
            if left <= 0:
                raise QueryTimedOut("", timeout_s=budget)
            limits = replace(state.limits, timeout_s=left)
            counts.append(count_query(query, backend, limits, state.unsupported))
        except QueryTimedOut as exc:
            raise QueryTimedOut(
                f"Counting took longer than {budget:g} s and was stopped.",
                timeout_s=budget,
                index=index,
            ) from exc
        except QueryError as exc:
            exc.details["index"] = index
            raise
    return Counts(counts=counts)


class Ids(BaseModel):
    ids: list[int]
    """Sorted."""


@router.post("/query/ids", responses=ERRORS)
def ids(body: QueryObject, state: State, backend: Visible) -> Ids:
    """The ids of the features a query returns, for marking hits (design B9).

    No geometry or attribute is sent, so the result-size limit does not apply.
    """
    return Ids(ids=ids_query(body, backend, state.limits, state.unsupported))


@router.post("/query/validate", responses=ERRORS)
def validate(body: QueryObject, state: State, backend: Visible) -> Validation:
    """Check a query against schema and data core without running it (F-5.9)."""
    compiled = validate_query(body, backend, state.limits, state.unsupported)
    return Validation(layers=compiled.layers, operations=sorted(compiled.ops))


class MapConfig(BaseModel):
    basemap: Basemap | None
    """``None``: no background map (the default, F-9.1)."""
    extent_wgs84: list[float] | None
    """Bounding box of the layers this account may see, for the initial view."""
    max_features: int
    """Result-size limit (F-9.6): larger layers are fetched by the current view (plan D5)."""


@router.get("/config/map")
def map_config(state: State, backend: Visible) -> MapConfig:
    boxes = [
        layer.bbox_wgs84
        for layer in list_layers(backend.engine, only=backend.layer_names())
        if layer.bbox_wgs84
    ]
    extent = None
    if boxes:
        columns = list(zip(*boxes, strict=True))
        extent = [min(columns[0]), min(columns[1]), max(columns[2]), max(columns[3])]
    basemap = resolve(state.settings.basemap, state.settings.basemap_attribution)
    return MapConfig(basemap=basemap, extent_wgs84=extent, max_features=state.settings.max_features)


@router.get("/schema/query-object")
def query_object_schema() -> dict[str, Any]:
    """The versioned query-object JSON schema (F-10.3)."""
    return json_schema()


@router.get("/tools")
def tools(state: State, _: CurrentAccount) -> list[ToolDescription]:
    return state.tools.describe()
