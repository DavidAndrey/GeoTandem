"""A browser that has signed in to an account before (security review #27).

Guesses at one username from many addresses are paced (``auth/throttle.py``).
So that flooding a username slows the guessing down and not its owner, a
browser that has signed in to the account gets a cookie saying so, and is not
paced for that username. OWASP calls these device cookies.

The cookie holds a random nonce and an HMAC over it and the username; it says
nothing about the account to whoever reads it. The key lives in memory, like
the throttle's counts: after a restart, a browser is paced again until its
next sign-in.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

COOKIE = "geotandem_device"
SECURE_COOKIE = f"__Host-{COOKIE}"
"""The name over HTTPS, as for the login cookie (security review #18)."""
MAX_AGE_S = 180 * 24 * 3600


def cookie_name(secure: bool) -> str:
    return SECURE_COOKIE if secure else COOKIE


class Devices:
    def __init__(self, key: bytes | None = None) -> None:
        self._key = key or secrets.token_bytes(32)

    def issue(self, username: str) -> str:
        """The cookie value for a browser that has just signed in as ``username``."""
        nonce = secrets.token_urlsafe(12)
        return f"{nonce}.{self._mac(nonce, username)}"

    def knows(self, cookie: str | None, username: str) -> bool:
        """Whether ``cookie`` was issued for ``username`` (as accounts normalise it)."""
        if not cookie:
            return False
        nonce, _, mac = cookie.partition(".")
        return bool(nonce) and hmac.compare_digest(mac, self._mac(nonce, username))

    def _mac(self, nonce: str, username: str) -> str:
        message = f"{nonce}\0{username.strip().lower()}".encode()
        return hmac.new(self._key, message, hashlib.sha256).hexdigest()
