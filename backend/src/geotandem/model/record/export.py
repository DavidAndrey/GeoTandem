"""The log of model actions as CSV (design M16.1 "CSV", plan WP73).

One row per record, newest first, for an administrator (D4: prompt text
included). The columns are what the log page and the entry page show, as
machine-readable names: times are naive UTC as the record holds them (the
column names say so), hashes in full, codes as codes. The query, the answer and
the steps are left out: they are JSON trees the entry page and its "Technisch"
JSON show, and a spreadsheet cell would not.

The file is written for the spreadsheet of its readers, Excel with Swiss
German settings: ``;`` between cells, every cell quoted, a byte order mark so
the umlauts read as UTF-8, CRLF line ends.

A spreadsheet runs a cell that starts with ``=``, ``+``, ``-`` or ``@`` as a
formula (CSV injection, security review E2.4), and one that opens a file with
the wrong separator splits a cell wherever ``;``, ``,``, a tab or a line
break stands, so a formula can start in the middle of a cell too. Prompts,
names and every other text come from people, so every text cell gets a ``'``
before a formula character that follows such a separator (spaces between
allowed), and before one at its start, judged after NFKC normalisation and
leading white space, which catches a leading space or line break and the
fullwidth forms of the four characters.
"""

import csv
import io
import re
import unicodedata
from collections.abc import Callable, Iterable, Iterator
from datetime import datetime
from typing import Any

from geotandem.model.schemas import ModelActionView

BOM = "\ufeff"
DELIMITER = ";"
FORMULA_START = ("=", "+", "-", "@")
"""What a spreadsheet reads as the start of a formula (after NFKC normalisation)."""
_AFTER_SEPARATOR = re.compile(r"([;,\t\r\n]\s*)([=+\-@\uff1d\uff0b\uff0d\uff20])")
"""A formula character after a separator a spreadsheet might split the cell on."""


def _matrix(view: ModelActionView) -> str:
    return " ".join(f"{op}={cell}" for op, cell in view.level.matrix.items())


COLUMNS: list[tuple[str, Callable[[ModelActionView], Any]]] = [
    ("id", lambda v: v.id),
    ("created_at_utc", lambda v: v.created_at),
    ("account", lambda v: v.account),
    ("approach", lambda v: v.approach),
    ("level_id", lambda v: v.level.id),
    ("level_name", lambda v: v.level.name),
    ("level_matrix", _matrix),
    ("level_prompt_hash", lambda v: v.level.prompt_hash),
    ("connection_id", lambda v: v.connection.id),
    ("connection_name", lambda v: v.connection.name),
    ("connection_model", lambda v: v.connection.model),
    ("connection_host", lambda v: v.connection.host),
    ("locality", lambda v: v.connection.locality),
    ("status", lambda v: v.status),
    ("decision", lambda v: v.decision),
    ("decided_at_utc", lambda v: v.decided_at),
    ("reject_reason", lambda v: v.reject_reason),
    ("applied_by_hand", lambda v: v.applied_by_hand),
    ("undone_at_utc", lambda v: v.undone_at),
    ("previewed_at_utc", lambda v: v.previewed_at),
    ("refusal_code", lambda v: v.refusal.code if v.refusal else None),
    ("error_code", lambda v: (v.error or {}).get("code")),
    ("hits", lambda v: v.stamp.count if v.stamp else None),
    ("latency_ms", lambda v: v.latency_ms),
    ("parent_action_id", lambda v: v.parent_action_id),
    ("reference", lambda v: v.reference),
    ("compare_of", lambda v: v.compare_of),
    ("profile_hash", lambda v: v.profile_hash),
    ("prompt_hash", lambda v: v.prompt_hash),
    ("prompt", lambda v: v.prompt),
]
"""Name and value of every column, in order; the prompt last, as the longest."""


def safe_cell(value: Any) -> str:
    """One value as a cell: empty for none, ``true``/``false``, numbers as they
    are, times in ISO form, and text with a ``'`` before every place a
    spreadsheet could start a formula."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    text = _AFTER_SEPARATOR.sub(r"\1'\2", str(value))
    start = unicodedata.normalize("NFKC", text).lstrip()
    if start.startswith(FORMULA_START) or text.startswith(("\t", "\r")):
        return f"'{text}"
    return text


def _line(cells: Iterable[str]) -> str:
    out = io.StringIO()
    csv.writer(out, delimiter=DELIMITER, quoting=csv.QUOTE_ALL).writerow(cells)
    return out.getvalue()


def csv_lines(views: Iterable[ModelActionView]) -> Iterator[str]:
    """The byte order mark and the header line, then one line per record as it
    is read: a long log is never held whole."""
    yield BOM + _line(name for name, _ in COLUMNS)
    for view in views:
        yield _line(safe_cell(value(view)) for _, value in COLUMNS)
