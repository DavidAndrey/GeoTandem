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


# Causes the interface can run into, each with its own code so the interface
# and the model can tell them apart (plan E1.9, L6).


class InvalidQueryGeometry(QueryError):
    """A geometry in the query (a drawn area) is malformed or invalid."""

    code = "invalid_query_geometry"


class NameClash(QueryError):
    """A joined, computed or aggregated attribute takes a name already used."""

    code = "name_clash"


class KeyTypeMismatch(QueryError):
    """Join keys of different types."""

    code = "key_type_mismatch"


class AttributeNotText(QueryError):
    code = "attribute_not_text"


class AttributeNotNumeric(QueryError):
    code = "attribute_not_numeric"


class WrongValueType(QueryError):
    """A condition's value does not fit the attribute's type."""

    code = "wrong_value_type"
