"""Validate and run query objects under server-side limits (F-5.9, F-9.6)."""

import hashlib
import json
import time
from collections.abc import Iterable
from typing import Any

from sqlalchemy import func, literal, select

from geotandem.catalog import get_layer
from geotandem.data import DataBackend, Limits, Op, QueryTimeout
from geotandem.engine.compile import FID, GEOJSON, Compiled, compile_query
from geotandem.engine.errors import QueryTimedOut, ResultTooLarge, UnknownLayer
from geotandem.engine.result import Feature, QueryResult, ResultMeta, ResultStamp
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
    rows = _execute(backend, compiled.stmt, limits)
    if len(rows) > limits.max_features:
        raise ResultTooLarge(
            f"The result exceeds {limits.max_features} features. Narrow the query or set 'limit'.",
            max_features=limits.max_features,
        )
    features = [_feature(row) for row in rows]
    versions = _versions(compiled, backend)
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
    result = _execute(backend, select(func.count()).select_from(rows), limits)
    return int(next(iter(result[0].values())))


def stamp_query(
    query: QueryObject, backend: DataBackend, limits: Limits, unsupported: Iterable[Op] = ()
) -> ResultStamp:
    """The result's stamp: count, hash of the sorted ids, provenance (F-8.9).

    Like counting, not capped by the result-size limit: only ids are read, and
    none leave the server. The query's own ordering stays, so a ``limit``
    picks the same features as ``run_query``.
    """
    compiled = compile_query(query, backend, COUNT_CAP, unsupported)
    return _stamp(_ids(compiled, backend, limits), query, _versions(compiled, backend))


def stamped_ids(
    query: QueryObject, backend: DataBackend, limits: Limits, unsupported: Iterable[Op] = ()
) -> tuple[list[int], ResultStamp]:
    """The ids of ``ids_query`` and the stamp of ``stamp_query``, from one run,
    within the result-size limit: for a comparison of two results by their
    features (design M10). At most one id beyond the limit is read, so an
    oversized result is refused without loading it."""
    compiled = compile_query(query, backend, COUNT_CAP, unsupported)
    ids = _ids(compiled, backend, limits, cap=limits.max_features)
    if len(ids) > limits.max_features:
        raise ResultTooLarge(
            f"The result exceeds {limits.max_features} features.",
            max_features=limits.max_features,
        )
    return ids, _stamp(ids, query, _versions(compiled, backend))


IN_CHUNK = 900
"""Ids per ``IN`` list: under SQLite's oldest limit of bound variables (999)."""


def values_of(
    layer: str, attribute: str, ids: Iterable[int], backend: DataBackend, limits: Limits
) -> dict[int, Any]:
    """The value of one attribute of the features ``ids`` of ``layer``, by id,
    read ``IN_CHUNK`` ids at a time; a layer outside ``backend`` (a view) is
    ``unknown_layer``, as for a query."""
    try:
        table = backend.layer_table(layer)
    except KeyError:
        raise UnknownLayer(f"Unknown layer '{layer}'.", layer=layer) from None
    wanted = sorted(set(ids))
    found: dict[int, Any] = {}
    for start in range(0, len(wanted), IN_CHUNK):
        chunk = wanted[start : start + IN_CHUNK]
        stmt = select(table.c[FID], table.c[attribute]).where(table.c[FID].in_(chunk))
        found |= {int(row[FID]): row[attribute] for row in _execute(backend, stmt, limits)}
    return found


def stamp_of(result: QueryResult) -> ResultStamp:
    """The stamp of a result already run: what ``stamp_query`` gives for its
    query on the same data, without running it again."""
    ids = sorted(feature.id for feature in result.features)
    return _stamp(ids, result.query, result.meta.data_versions)


def _stamp(ids: list[int], query: QueryObject, versions: dict[str, str | None]) -> ResultStamp:
    """``ids`` sorted."""
    return ResultStamp(
        count=len(ids),
        ids_hash=hashlib.sha256(",".join(map(str, ids)).encode()).hexdigest(),
        query_hash=query_hash(query),
        data_versions=versions,
    )


def ids_query(
    query: QueryObject, backend: DataBackend, limits: Limits, unsupported: Iterable[Op] = ()
) -> list[int]:
    """The ids of the features ``query`` returns, sorted (design B9: the hits on the map).

    Like counting, not capped by the result-size limit: no geometry or
    attribute leaves the server, so a large hit set is still marked.
    """
    return _ids(compile_query(query, backend, COUNT_CAP, unsupported), backend, limits)


def _ids(
    compiled: Compiled, backend: DataBackend, limits: Limits, cap: int | None = None
) -> list[int]:
    """Sorted; with ``cap``, at most ``cap + 1`` of them."""
    # The query's own ordering stays inside, so a ``limit`` picks what run_query does.
    found = compiled.stmt.with_only_columns(compiled.stmt.selected_columns[FID]).subquery()
    stmt = select(found.c[FID]).order_by(found.c[FID])
    if cap is not None:
        stmt = stmt.limit(cap + 1)
    return [int(row[FID]) for row in _execute(backend, stmt, limits)]


def _execute(backend: DataBackend, stmt: Any, limits: Limits) -> list[dict[str, Any]]:
    """``backend.execute`` with its time limit as the engine's error."""
    try:
        return backend.execute(stmt, limits)
    except QueryTimeout:
        raise QueryTimedOut(
            f"The query took longer than {limits.timeout_s:g} s and was stopped.",
            timeout_s=limits.timeout_s,
        ) from None


def _versions(compiled: Compiled, backend: DataBackend) -> dict[str, str | None]:
    """Dataset version of every layer the query touched."""
    versions: dict[str, str | None] = {}
    for name in compiled.layers:
        info = get_layer(backend.engine, name)
        versions[name] = info.dataset_version if info else None
    return versions


def _feature(row: dict[str, Any]) -> Feature:
    geojson = row.pop(GEOJSON, None)
    fid = row.pop(FID)
    return Feature(id=fid, properties=row, geometry=json.loads(geojson) if geojson else None)
