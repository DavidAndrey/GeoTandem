"""Errors of the execution engine, with codes stable enough for UI and model (F-5.9)."""

from typing import Any


class QueryError(Exception):
    """A query that is schema-valid but cannot run as written."""

    status = 400
    code = "invalid_query"

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class UnknownLayer(QueryError):
    code = "unknown_layer"


class UnknownAttribute(QueryError):
    code = "unknown_attribute"


class UnsupportedOperation(QueryError):
    code = "unsupported_operation"


class ResultTooLarge(QueryError):
    status = 413
    code = "result_too_large"


class QueryTimedOut(QueryError):
    status = 504
    code = "query_timeout"
