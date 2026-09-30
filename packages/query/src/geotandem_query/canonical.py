"""Canonical form and hash of a query object (F-8.9).

Two documents that differ only in key order, omitted defaults or ``5`` vs
``5.0`` get the same hash. Deeper semantic normalisation (e.g. reordering
``and`` arguments) is left to the evaluation in E3.2.
"""

import hashlib
import json
from typing import Any

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
