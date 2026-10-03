"""How text compares, on every backend (F-2.14, F-10.7; plan E1.8, P1 + T1).

One definition for case-insensitive search and for text order. The SpatiaLite
adapter registers these functions in SQLite; a PostGIS adapter must give the
same results (``lower()`` on a UTF-8 database, an ICU collation), and the
backend-neutral corpus in ``backend/tests/test_text.py`` is the judge.

- **Case-insensitive** means Python's ``str.lower``: Unicode-aware ("Ä" → "ä"),
  and like PostgreSQL's ``lower()`` it keeps "ß". Accents still count:
  "Munsingen" does not find "Münsingen" (that would be option T2).
- **Text order** follows German and French rules in the way ICU's default
  does: first by base letters (accents and case ignored, so "Ägerten" sorts
  with A), then by accents, then lower case before upper case, and finally by
  the exact characters, so the order is total and the same every time.
"""

import unicodedata
from functools import lru_cache

LOWER = "gt_lower"
"""Name of the case-folding function a backend provides."""

COLLATION = "gt_text"
"""Name of the text collation a backend provides."""

BUFFER_QUADRANT_SEGMENTS = 30
"""Segments per quarter circle of a buffer: SpatiaLite's default, set explicitly
everywhere because PostGIS defaults to 8 and would draw different shapes."""


def lower(value: str | None) -> str | None:
    return None if value is None else value.lower()


@lru_cache(maxsize=65_536)
def sort_key(value: str) -> tuple[str, str, tuple[bool, ...], str]:
    decomposed = unicodedata.normalize("NFD", value)
    base = "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()
    accents = decomposed.casefold()
    # One flag per folded character, so "ß" (folds to "ss") lines up with "ss".
    case = tuple(flag for c in value for flag in [c.isupper()] * len(c.casefold()))
    return base, accents, case, value


def compare(a: str, b: str) -> int:
    """SQLite collation callback: negative, zero or positive."""
    ka, kb = sort_key(a), sort_key(b)
    return (ka > kb) - (ka < kb)
