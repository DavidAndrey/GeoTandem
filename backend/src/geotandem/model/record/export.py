"""The log of model actions as CSV (design M16.1 "CSV", plan WP73).

One row per record, newest first, for an administrator (D4: prompt text
included). The columns are what the log page and the entry page show, as
machine-readable names: times are naive UTC as the record holds them (the
column names say so), hashes in full, codes as codes. The query, the answer and
the steps are left out: they are JSON trees the entry page and its "Technisch"
JSON show, and a spreadsheet cell would not.

A spreadsheet runs a cell that starts with ``=``, ``+``, ``-`` or ``@`` as a
formula, and one that starts with a tab or a carriage return can be read as
one too (CSV injection, security review E2.4). Prompts, names and every other
text come from people, so every text cell that starts with one of them gets a
leading ``'``, which spreadsheets show as text. Quoting is the ``csv``
module's: a cell with a comma, a quote or a line break is quoted, quotes
doubled.
"""

import csv
import io
from collections.abc import Callable, Iterable
from datetime import datetime
from typing import Any

from geotandem.model.schemas import ModelActionView

FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
"""What a spreadsheet may read as the start of a formula."""


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
    are, times in ISO form, and text with a leading ``'`` where a spreadsheet
    would read a formula."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    text = str(value)
    return f"'{text}" if text.startswith(FORMULA_START) else text


def to_csv(views: Iterable[ModelActionView]) -> str:
    """The rows under a header line, lines ended with CRLF (RFC 4180)."""
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(name for name, _ in COLUMNS)
    for view in views:
        writer.writerow(safe_cell(value(view)) for _, value in COLUMNS)
    return out.getvalue()
