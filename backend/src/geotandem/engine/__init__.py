"""Execution engine: the only component that runs query objects (E1.2)."""

from geotandem.engine.errors import QueryError
from geotandem.engine.execute import count_query, run_query, validate_query
from geotandem.engine.result import Feature, QueryResult, ResultMeta

__all__ = [
    "Feature",
    "QueryError",
    "QueryResult",
    "ResultMeta",
    "count_query",
    "run_query",
    "validate_query",
]
