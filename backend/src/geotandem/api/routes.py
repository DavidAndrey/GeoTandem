"""HTTP interface v0 (E1.2). Contract for the frontend; types are generated from it."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from geotandem import __version__
from geotandem.api.errors import ErrorBody
from geotandem.api.state import AppState, get_state
from geotandem.catalog import LayerInfo, get_layer, list_layers
from geotandem.data import Op
from geotandem.engine import QueryResult, run_query, validate_query
from geotandem.engine.errors import UnknownLayer
from geotandem.sample.load import dataset_version
from geotandem.tools import ToolDescription
from geotandem_query import SCHEMA_VERSION, QueryObject
from geotandem_query.export import json_schema

router = APIRouter(prefix="/api")
State = Annotated[AppState, Depends(get_state)]

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
def layers(state: State) -> list[LayerInfo]:
    return list_layers(state.backend.engine)


@router.get("/layers/{name}", responses=ERRORS)
def layer(name: str, state: State) -> LayerInfo:
    info = get_layer(state.backend.engine, name)
    if info is None:
        raise LayerNotFound(f"Unknown layer '{name}'.", layer=name)
    return info


@router.post("/query", responses=ERRORS)
def query(body: QueryObject, state: State) -> QueryResult:
    """Run a query object (F-8.9); the result carries its query and provenance."""
    return run_query(body, state.backend, state.limits, state.unsupported)


@router.post("/query/validate", responses=ERRORS)
def validate(body: QueryObject, state: State) -> Validation:
    """Check a query against schema and data core without running it (F-5.9)."""
    compiled = validate_query(body, state.backend, state.limits, state.unsupported)
    return Validation(layers=compiled.layers, operations=sorted(compiled.ops))


@router.get("/schema/query-object")
def query_object_schema() -> dict[str, Any]:
    """The versioned query-object JSON schema (F-10.3)."""
    return json_schema()


@router.get("/tools")
def tools(state: State) -> list[ToolDescription]:
    return state.tools.describe()
