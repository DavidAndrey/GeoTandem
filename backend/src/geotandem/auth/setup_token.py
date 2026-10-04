"""The first administrator needs a token from the installation (security review #1).

Whoever reaches a fresh instance first must not become its administrator.
Setup therefore asks for a token only the installation knows: the one set in
``GEOTANDEM_SETUP_TOKEN``, or else one made at start and written to the log,
which only those who run the instance can read (``docker logs``). It lives in
memory only, a restart makes a new one, and it is void once an account exists.
"""

from __future__ import annotations

import logging
import secrets

from geotandem.config import Settings

log = logging.getLogger(__name__)

THROTTLE_KEY = "(setup)"
"""Wrong tokens count in the sign-in throttle under this name, which no username can be."""


def issue(settings: Settings) -> str:
    """The token for this start, and where to find it, in the log."""
    if settings.setup_token is not None:
        log.warning("No administrator yet. Setting up needs the token from GEOTANDEM_SETUP_TOKEN.")
        return settings.setup_token.get_secret_value()
    token = secrets.token_urlsafe(18)
    # Behind '#', the token never reaches a server: not this one's access log, not a proxy's.
    log.warning(
        "No administrator yet. Setup token: %s — open /einrichtung#token=%s on this "
        "instance, or run: geotandem user create <name> --role admin",
        token,
        token,
    )
    return token


def matches(expected: str | None, given: str) -> bool:
    if expected is None:
        return False
    return secrets.compare_digest(expected.encode(), given.encode())
