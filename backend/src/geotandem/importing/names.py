"""Identifiers for layers and attributes from arbitrary source names.

Imported names reach SQL as table and column names, so they pass through here
first: lower-case ASCII letters, digits and underscores, no leading digit,
at most 63 characters, unique, and never one of the reserved column names.
"""

import re
import unicodedata
from collections.abc import Iterable, Sequence

MAX_LENGTH = 63
RESERVED = frozenset({"fid", "geom"})

_GERMAN = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})
_INVALID = re.compile(r"[^a-z0-9]+")


def identifier(text: str, fallback: str = "feld") -> str:
    """``"Einwohner (2024)"`` → ``"einwohner_2024"``; ``"Höhe ü. M."`` → ``"hoehe_ue_m"``."""
    ascii_text = (
        unicodedata.normalize("NFKD", text.strip().lower().translate(_GERMAN))
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    name = _INVALID.sub("_", ascii_text).strip("_")
    if not name:
        name = fallback
    if name[0].isdigit():
        name = f"{fallback}_{name}"
    return name[:MAX_LENGTH].rstrip("_")


def unique_identifiers(
    names: Sequence[str], taken: Iterable[str] = RESERVED, fallback: str = "feld"
) -> list[str]:
    """Identifiers for ``names`` in order, distinct from each other and from ``taken``."""
    used = set(taken)
    result = []
    for name in names:
        base = identifier(name, fallback)
        candidate, n = base, 1
        while candidate in used:
            n += 1
            suffix = f"_{n}"
            candidate = base[: MAX_LENGTH - len(suffix)] + suffix
        used.add(candidate)
        result.append(candidate)
    return result
