"""The examples of docs/filters.md, run against the sample dataset.

Each "### Beispiel" section holds one query object as JSON and its count as
"**hits von total**"; total is the same query without ``where``. A changed
example or sample dataset fails here until the document is brought up to date.
"""

import json
import re
from pathlib import Path
from typing import Any

import pytest

from geotandem.data import DataBackend, Limits
from geotandem.engine import count_query
from geotandem_query import QueryObject

DOC = Path(__file__).parents[2] / "docs" / "filters.md"
LIMITS = Limits(max_features=1000, timeout_s=10)

_SECTION = re.compile(r"^### (Beispiel \d+)\b.*?(?=^#{2,3} |\Z)", re.M | re.S)
_COUNT = re.compile(r"\*\*(\d+) von (\d+)\*\*")
_JSON = re.compile(r"```json\n(.*?)\n```", re.S)


def examples() -> list[Any]:
    found = []
    for section in _SECTION.finditer(DOC.read_text("utf-8")):
        text = section.group(0)
        count, query = _COUNT.search(text), _JSON.search(text)
        assert count and query, f"{section.group(1)} needs one count and one JSON block"
        found.append(
            pytest.param(
                json.loads(query.group(1)),
                int(count.group(1)),
                int(count.group(2)),
                id=section.group(1),
            )
        )
    return found


def count(backend: DataBackend, query: dict[str, Any]) -> int:
    return count_query(QueryObject.model_validate(query), backend, LIMITS)


def test_the_document_has_examples() -> None:
    assert len(examples()) == 8


@pytest.mark.parametrize(("query", "hits", "total"), examples())
def test_example(sample: DataBackend, query: dict[str, Any], hits: int, total: int) -> None:
    without_conditions = {k: v for k, v in query.items() if k != "where"}
    assert (count(sample, query), count(sample, without_conditions)) == (hits, total)
