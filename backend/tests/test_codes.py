"""Every code the application sends is registered, and the interface has the list (E1.9)."""

import re
from pathlib import Path

from geotandem.codes import CODES, export

SOURCE = Path(__file__).parents[1] / "src" / "geotandem"

# Where codes are written: a class attribute, a keyword, or a code literal
# followed by its English message (constructors, tuples, rejections).
PATTERNS = [
    re.compile(r'\bcode = "([a-z_]+)"'),
    re.compile(r'\bcode="([a-z_]+)"'),
    re.compile(r'"([a-z][a-z_]*)",\s*f?"[A-Z\'{]'),
    # Why an import row was rejected.
    re.compile(r'\bNone, "([a-z_]+)"'),
]


# Pairs that look like a code and a message but are a type and its note.
NOT_CODES = {"integer", "real"}


def raised_codes() -> dict[str, str]:
    found: dict[str, str] = {}
    for path in SOURCE.rglob("*.py"):
        if path.name == "codes.py":
            continue
        text = path.read_text(encoding="utf-8")
        for pattern in PATTERNS:
            for match in pattern.finditer(text):
                if match.group(1) not in NOT_CODES:
                    found.setdefault(match.group(1), path.name)
    return found


def test_every_code_raised_is_registered() -> None:
    missing = {code: where for code, where in raised_codes().items() if code not in CODES}
    assert missing == {}


def test_every_registered_code_is_raised() -> None:
    source = "\n".join(
        p.read_text(encoding="utf-8") for p in SOURCE.rglob("*.py") if p.name != "codes.py"
    )
    unused = [code for code in CODES if f'"{code}"' not in source]
    assert unused == []


def test_committed_codes_match() -> None:
    """``make gen`` writes it; the interface checks it has a message for each."""
    committed = Path(__file__).parents[2] / "frontend" / "error-codes.json"
    assert committed.read_text(encoding="utf-8") == export()
