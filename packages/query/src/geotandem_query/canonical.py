"""Canonical form and hash of a query object (F-8.9).

Two documents that differ only in key order, omitted defaults or ``5`` vs
``5.0`` get the same hash. Deeper semantic normalisation (e.g. reordering
``and`` arguments) is left to the evaluation in E3.2.
"""

import hashlib
import json
from typing import Any

from pydantic import BaseModel

from geotandem_query.models import QueryObject


def _normalise(value: Any) -> Any:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _normalise(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalise(v) for v in value]
    return value


def canonical_json(query: QueryObject) -> str:
    data = _normalise(query.model_dump(mode="json", by_alias=True))
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def query_hash(query: QueryObject) -> str:
    return hashlib.sha256(canonical_json(query).encode()).hexdigest()


def compact(query: QueryObject) -> dict[str, Any]:
    """The query as a client writes it: no field that is unset (``None``) or an
    empty list or mapping by default, and ``5`` for ``5.0``. Every other field,
    defaults included (``schema_version``, ``output``, ``mode``), stays. Reads
    back as the same query object; ``select: []`` stays, it is not the default."""
    data: dict[str, Any] = _normalise(_compact(query, query.model_dump(mode="json", by_alias=True)))
    return data


def _compact(value: Any, dumped: Any) -> Any:
    """``dumped`` (the JSON dump of ``value``) without the fields ``compact`` drops."""
    if isinstance(value, BaseModel):
        kept: dict[str, Any] = {}
        for name, info in type(value).model_fields.items():
            key = info.serialization_alias or info.alias or name
            inner = getattr(value, name)
            if key not in dumped or inner is None:
                continue
            if info.default_factory is not None and isinstance(inner, list | dict) and not inner:
                continue
            kept[key] = _compact(inner, dumped[key])
        return kept
    if isinstance(value, list | tuple):
        return [_compact(v, d) for v, d in zip(value, dumped, strict=True)]
    if isinstance(value, dict):
        return {k: _compact(v, dumped[k]) for k, v in value.items()}
    return dumped
