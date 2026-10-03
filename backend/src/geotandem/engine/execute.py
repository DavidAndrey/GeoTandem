"""Validate and run query objects under server-side limits (F-5.9, F-9.6)."""

import json
import time
from collections.abc import Iterable
from typing import Any

from sqlalchemy import func, literal, select

from geotandem.catalog import get_layer
from geotandem.data import DataBackend, Limits, Op, QueryTimeout
from geotandem.engine.compile import FID, GEOJSON, Compiled, compile_query
from geotandem.engine.errors import QueryTimedOut, ResultTooLarge
from geotandem.engine.result import Feature, QueryResult, ResultMeta
from geotandem_query import QueryObject, query_hash


def validate_query(
    query: QueryObject, backend: DataBackend, limits: Limits, unsupported: Iterable[Op] = ()
) -> Compiled:
    """Check a schema-valid query against the data core without running it."""
    return compile_query(query, backend, limits.max_features, unsupported)


def run_query(
    query: QueryObject, backend: DataBackend, limits: Limits, unsupported: Iterable[Op] = ()
) -> QueryResult:
    started = time.perf_counter()
    compiled = validate_query(query, backend, limits, unsupported)
    try:
        rows = backend.execute(compiled.stmt, limits)
    except QueryTimeout:
        raise QueryTimedOut(
            f"The query took longer than {limits.timeout_s:g} s and was stopped.",
            timeout_s=limits.timeout_s,
        ) from None
    if len(rows) > limits.max_features:
        raise ResultTooLarge(
            f"The result exceeds {limits.max_features} features. Narrow the query or set 'limit'.",
            max_features=limits.max_features,
        )
    features = [_feature(row) for row in rows]
    versions: dict[str, str | None] = {}
    for name in compiled.layers:
        info = get_layer(backend.engine, name)
        versions[name] = info.dataset_version if info else None
    return QueryResult(
        features=features,
        query=query,
        meta=ResultMeta(
            schema_version=query.schema_version,
            query_hash=query_hash(query),
            data_versions=versions,
            backend=backend.name,
            feature_count=len(features),
            elapsed_ms=round((time.perf_counter() - started) * 1000, 1),
        ),
    )


COUNT_CAP = 10**9
"""Counting needs no result-size cap: no features leave the server."""


def count_query(
    query: QueryObject, backend: DataBackend, limits: Limits, unsupported: Iterable[Op] = ()
) -> int:
    """How many features ``query`` returns, without building them (B1 "7 von 39").

    Same compiler and the same view as ``run_query``; only the select list is
    replaced, so no geometry is serialised. Runs under the same time limit.
    """
    compiled = compile_query(query, backend, COUNT_CAP, unsupported)
    rows = compiled.stmt.with_only_columns(literal(1)).order_by(None).subquery()
    try:
        result = backend.execute(select(func.count()).select_from(rows), limits)
    except QueryTimeout:
        raise QueryTimedOut(
            f"The query took longer than {limits.timeout_s:g} s and was stopped.",
            timeout_s=limits.timeout_s,
        ) from None
    return int(next(iter(result[0].values())))


def _feature(row: dict[str, Any]) -> Feature:
    geojson = row.pop(GEOJSON, None)
    fid = row.pop(FID)
    return Feature(id=fid, properties=row, geometry=json.loads(geojson) if geojson else None)
