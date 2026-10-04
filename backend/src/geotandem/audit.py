"""Security events, one JSON line each on stderr (security review #13).

Sign-ins and their failures, account and catalog changes, and the guards'
refusals, so brute force and misuse can be noticed and traced. JSON, not
free text: usernames and file names come from outside, and a line break in
one must not forge a log line. Passwords and session tokens are never logged.

Each event carries the request it happened in (client address, method,
path), from a context the ``AuditContext`` middleware sets per request.
"""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

from starlette.types import ASGIApp, Receive, Scope, Send

LOGGER = "geotandem.security"
log = logging.getLogger(LOGGER)

_request: ContextVar[dict[str, str] | None] = ContextVar("geotandem_audit_request", default=None)


def event(name: str, **fields: Any) -> None:
    """Record one security event; ``fields`` must be JSON-serialisable (or ``str``-able)."""
    log.info(name, extra={"audit": {**(_request.get() or {}), **fields}})


class JsonLines(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "event": record.getMessage(),
            **getattr(record, "audit", {}),
        }
        return json.dumps(entry, ensure_ascii=False, default=str)


def configure() -> None:
    """Give the security log its own handler, once; independent of other logging."""
    if any(isinstance(h.formatter, JsonLines) for h in log.handlers):
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonLines())
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False


class AuditContext:
    """Remember the request for the events recorded while it is answered."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        token = _request.set(
            {
                "address": client[0] if client else "unknown",
                "method": scope["method"],
                "path": scope["path"],
            }
        )
        try:
            await self.app(scope, receive, send)
        finally:
            _request.reset(token)
