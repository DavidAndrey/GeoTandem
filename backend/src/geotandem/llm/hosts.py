"""Local or external, from the host alone (plan E2.1, C5).

Compared literally and never resolved: whether data leaves the house must
not hinge on a DNS answer or a checkbox (F-9.1, F-9.4).
"""

from collections.abc import Iterable
from typing import Literal
from urllib.parse import urlsplit

from geotandem.llm.client import LLMError

Locality = Literal["local", "external"]

LOCAL_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "host.docker.internal"})
"""Always local; ``GEOTANDEM_LLM_LOCAL_HOSTS`` adds more."""


def host_of(base_url: str) -> str:
    """The host of an http(s) base URL, lower-case; refuses anything else."""
    try:
        parts = urlsplit(base_url.strip())
        if parts.port == 0:  # reading the port also refuses a malformed one
            raise ValueError("port 0")
    except ValueError as exc:
        raise LLMError("llm_invalid_url", "The base URL is malformed.", cause=str(exc)) from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise LLMError(
            "llm_invalid_url",
            "The base URL must be http:// or https:// with a host.",
            cause=f"scheme '{parts.scheme}'",
        )
    if parts.username is not None or parts.password is not None:
        # A key belongs in the key field, encrypted; never in a URL that is shown and logged.
        raise LLMError("llm_invalid_url", "The base URL must not contain credentials.")
    if parts.query or parts.fragment:
        raise LLMError("llm_invalid_url", "The base URL must not have a query or fragment.")
    return parts.hostname.lower()


def classify_host(base_url: str, extra_local: Iterable[str] = ()) -> Locality:
    host = host_of(base_url)
    local = LOCAL_HOSTS | {h.strip().lower() for h in extra_local if h.strip()}
    return "local" if host in local else "external"
