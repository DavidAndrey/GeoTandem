"""Type inference for tabular sources (CSV, Excel), F-2.4.

Cells arrive as text (CSV) or as Python values (Excel). Inference is our own,
not a library's, because two cases matter for geo-referencing and libraries
get them wrong: area keys with leading zeros ("0999") must stay text, and
German-style decimal commas ("3,5") must become numbers.
"""

import re
from collections.abc import Sequence
from datetime import date, datetime, time
from typing import Any

from geotandem.data.interface import AttributeType

_INTEGER = re.compile(r"^[+-]?(0|[1-9]\d*)$")
_REAL_DOT = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_REAL_COMMA = re.compile(r"^[+-]?\d+(,\d+)?$")
_ZERO_PADDED = re.compile(r"^[+-]?0\d+$")
_BOOLEAN = {"true": True, "false": False}
_DATE_ISO = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_DATE_CH = re.compile(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$")
_INT64 = 2**63


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _is_int(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) < _INT64
    return isinstance(value, str) and bool(_INTEGER.match(value)) and abs(int(value)) < _INT64


def _is_code(value: Any) -> bool:
    """Digits that are an identifier, not a number: "0999", or too long for 64 bits."""
    if not isinstance(value, str):
        return False
    return bool(_ZERO_PADDED.match(value)) or (
        bool(_INTEGER.match(value)) and abs(int(value)) >= _INT64
    )


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def as_date(value: Any) -> date | None:
    """A calendar date, or ``None`` if ``value`` is none (plan E1.8, G3, G4).

    Dates, datetimes at midnight (Excel stores dates that way), ISO text
    "2024-03-01" and Swiss "1.3.2024". A time of day is not a date.
    """
    if isinstance(value, datetime):
        return value.date() if value.time() == time(0) and value.tzinfo is None else None
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        iso = _DATE_ISO.match(value)
        swiss = _DATE_CH.match(value)
        try:
            if iso:
                return date(int(iso[1]), int(iso[2]), int(iso[3]))
            if swiss:
                return date(int(swiss[3]), int(swiss[2]), int(swiss[1]))
        except ValueError:  # e.g. 31.02.2024
            return None
    return None


def infer(values: Sequence[Any]) -> tuple[AttributeType, list[Any], bool]:
    """Column type, the values converted to it, and whether times of day became text."""
    cells = [v.strip() if isinstance(v, str) else v for v in values]
    present = [v for v in cells if not _blank(v)]

    def convert(fn: Any) -> list[Any]:
        return [None if _blank(v) else fn(v) for v in cells]

    if not present:
        return "text", [None] * len(cells), False
    if all(as_date(v) is not None for v in present):
        return "date", convert(as_date), False
    if any(isinstance(v, datetime | date | time) for v in present):
        return "text", convert(_as_text), True
    if all(isinstance(v, bool) or (isinstance(v, str) and v.lower() in _BOOLEAN) for v in present):
        return (
            "boolean",
            convert(lambda v: v if isinstance(v, bool) else _BOOLEAN[v.lower()]),
            False,
        )
    if any(_is_code(v) for v in present):
        return "text", convert(_as_text), False
    if all(_is_int(v) for v in present):
        return "integer", convert(int), False
    if all(_is_number(v) or (isinstance(v, str) and _REAL_DOT.match(v)) for v in present):
        return "real", convert(float), False
    if all(_is_number(v) or (isinstance(v, str) and _REAL_COMMA.match(v)) for v in present):
        return (
            "real",
            convert(lambda v: float(v.replace(",", ".") if isinstance(v, str) else v)),
            False,
        )
    return "text", convert(_as_text), False


def _as_text(value: Any) -> str:
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _as_boolean(value: Any) -> bool:
    return value if isinstance(value, bool) else _BOOLEAN[value.lower()]


def _comma_decimal(value: Any) -> float:
    return float(value.replace(",", ".") if isinstance(value, str) else value)
