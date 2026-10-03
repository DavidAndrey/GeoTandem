"""HTTP interface v0 (E1.2). Contract for the frontend; types are generated from it."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from geotandem import __version__
from geotandem.api.auth import CurrentAccount
from geotandem.api.errors import ErrorBody
from geotandem.api.state import AppState, get_state
from geotandem.auth.visibility import view_for
from geotandem.catalog import LayerInfo, get_layer, list_layers
from geotandem.data import DataBackend, Op
from geotandem.engine import QueryError, QueryResult, count_query, run_query, validate_query
from geotandem.engine.errors import UnknownLayer
from geotandem.sample.load import dataset_version
from geotandem.tools import ToolDescription
from geotandem_query import SCHEMA_VERSION, QueryObject
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


class Capabilities(BaseModel):
    supported: list[Op]
    missing: dict[Op, list[str]]


class Health(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    backend: str
    internal_crs: int
    schema_version: str
    sample_dataset_version: str
    capabilities: Capabilities


class Validation(BaseModel):
    valid: Literal[True] = True
    layers: list[str]
    operations: list[Op]


@router.get("/health")
def health(state: State) -> Health:
    missing = state.unsupported
    return Health(
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
    in ``details.index``.
    """
    counts = []
    for index, query in enumerate(body.queries):
        try:
            counts.append(count_query(query, backend, state.limits, state.unsupported))
        except QueryError as exc:
            exc.details["index"] = index
            raise
    return Counts(counts=counts)


@router.post("/query/validate", responses=ERRORS)
def validate(body: QueryObject, state: State, backend: Visible) -> Validation:
    """Check a query against schema and data core without running it (F-5.9)."""
    compiled = validate_query(body, backend, state.limits, state.unsupported)
    return Validation(layers=compiled.layers, operations=sorted(compiled.ops))


@router.get("/schema/query-object")
def query_object_schema() -> dict[str, Any]:
    """The versioned query-object JSON schema (F-10.3)."""
    return json_schema()


@router.get("/tools")
def tools(state: State, _: CurrentAccount) -> list[ToolDescription]:
    return state.tools.describe()
