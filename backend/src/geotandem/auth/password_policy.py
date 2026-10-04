"""What a new password must be (security review #12).

Length over complexity, as NIST SP 800-63B and OWASP ASVS advise: at least
12 characters of any kind, no rules about digits or special characters, no
expiry. Instead the password must not be a common one, a keyboard row or a
repetition, nor contain the account's own name.

Common means: on one of the lists in ``data/`` (read offline), compared in
normalized form. Case, umlauts (ä → ae), separators, leetspeak (@ → a, 0 → o)
and digits or symbols at either end do not count, so ``P@ssw0rd2024!`` is
``password``. A phrase of words that are each common is fine: only the whole
core is compared.

Applies when a password is set (setup, change, command line), not to
passwords set before: they hold until their next change.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from functools import lru_cache
from importlib.resources import files

MIN_LENGTH = 12
MAX_LENGTH = 1024
"""Bounds the hashing work one request can ask for."""
MIN_DISTINCT = 5
"""Distinct characters: ``aaaaaaaaaaab`` and ``121212121212`` have fewer."""
MIN_NAME_PART = 4
"""Names and their parts shorter than this ("m", "max") are not looked for: they
would turn up inside ordinary words ("maximal")."""
PRODUCT = "geotandem"
LISTS = ("common-passwords.txt", "german-passwords.txt")

_UMLAUTS = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue"})  # ß: casefold makes it "ss"
_LEET = {"@": "a", "4": "a", "0": "o", "!": "i", "3": "e", "$": "s", "5": "s", "7": "t", "+": "t"}
_LEET_I = str.maketrans({**_LEET, "1": "i"})
_LEET_L = str.maketrans({**_LEET, "1": "l"})
_SEPARATORS = re.compile(r"[\s._\-]+")
_ENDS = re.compile(r"^[^a-z]+|[^a-z]+$")
_SEQUENCES = (
    "abcdefghijklmnopqrstuvwxyz",
    "01234567890123456789",
    "qwertzuiopueasdfghjkloeaeyxcvbnm",
    "qwertzuiopasdfghjklyxcvbnm",
    "qwertyuiopasdfghjklzxcvbnm",
    "1qay2wsx3edc4rfv5tgb6zhn7ujm8ik9ol0p",
    "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
)


def prepare(password: str) -> str:
    """The form that is hashed: the same "ü" from any keyboard is the same password."""
    return unicodedata.normalize("NFKC", password)


def violation(password: str, names: Iterable[str] = ()) -> tuple[str, str] | None:
    """The first rule ``password`` breaks, as ``(code, message)``; ``None`` if none.

    ``names``: the account's username and display name, which it must not contain.
    """
    prepared = prepare(password)
    if len(prepared) < MIN_LENGTH:
        return "password_too_short", f"The password needs at least {MIN_LENGTH} characters."
    if len(prepared) > MAX_LENGTH:
        return "password_too_long", f"The password may have at most {MAX_LENGTH} characters."
    folded = _fold(prepared)
    forms = _forms(folded)
    for part in _name_parts([*names, PRODUCT]):
        if any(part in form for form in forms):
            return (
                "password_contains_name",
                "The password must not contain the username, the display name "
                "or the application's name.",
            )
    if forms & _blocked():
        return "password_common", "This password is too common; it is among the first guesses."
    if _is_pattern(folded):
        return (
            "password_pattern",
            "The password is a keyboard row, a sequence or a repetition; it is easy to guess.",
        )
    return None


def _fold(text: str) -> str:
    """Case, umlauts and separators that do not make a password different."""
    return _SEPARATORS.sub("", unicodedata.normalize("NFKC", text).casefold().translate(_UMLAUTS))


def _forms(folded: str) -> set[str]:
    """``folded`` as typed, without digits and symbols at the ends, and in leetspeak undone."""
    forms = {folded, _ENDS.sub("", folded)}
    for form in list(forms):
        for leet in (_LEET_I, _LEET_L):
            undone = form.translate(leet)
            forms.update({undone, _ENDS.sub("", undone)})
    forms.discard("")
    return forms


@lru_cache(maxsize=1)
def _blocked() -> frozenset[str]:
    data = files("geotandem.auth").joinpath("data")
    entries = set()
    for name in LISTS:
        for line in data.joinpath(name).read_text(encoding="utf-8").splitlines():
            if line.strip():
                entries.update(_forms(_fold(line.strip())))
    return frozenset(entries)


def _name_parts(names: Iterable[str]) -> set[str]:
    parts = set()
    for name in names:
        folded = _fold(name)
        if len(folded) >= MIN_NAME_PART:
            parts.add(folded)
        parts.update(
            p
            for p in _SEPARATORS.split(unicodedata.normalize("NFKC", name).casefold())
            if len(p) >= MIN_NAME_PART
        )
    return {p.translate(_UMLAUTS) for p in parts}


def _is_pattern(folded: str) -> bool:
    """Few distinct characters; or, as typed or without the ends ("sommersommer!"),
    a repetition or a stretch of a keyboard row or the alphabet."""
    if len(set(folded)) < MIN_DISTINCT:
        return True
    for form in {folded, _ENDS.sub("", folded)}:
        if len(form) >= MIN_LENGTH // 2 and (_repeats(form) or _in_sequence(form)):
            return True
    return False


def _repeats(text: str) -> bool:
    n = len(text)
    return any(n % p == 0 and text == text[:p] * (n // p) for p in range(1, n // 2 + 1))


def _in_sequence(text: str) -> bool:
    return any(text in seq or text in seq[::-1] for seq in _SEQUENCES)
