"""Request guards the application keeps itself (security review #3, #4, #7, #8).

A reverse proxy may enforce the same (``compose.traefik.yaml``); these hold
when it is missing, misconfigured or bypassed. Pure ASGI, so they see the
request before FastAPI reads its body — which FastAPI does before it checks
who is asking.

Client address and scheme are uvicorn's: behind a proxy they come from
``X-Forwarded-*`` only if ``FORWARDED_ALLOW_IPS`` trusts it.
"""

from __future__ import annotations

import json
import secrets
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit

from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from geotandem import audit
from geotandem.auth import sessions
from geotandem.basemap import Basemap, resolve

MiB = 1024 * 1024
IMPORT_PATH = "/api/admin/imports"
UPLOAD_OVERHEAD = MiB
"""Room for the multipart framing around the file itself."""
DOCS_PATHS = ("/docs", "/redoc")
CSP_NONCE = "geotandem.csp_nonce"
"""Scope key of this request's nonce, for the page that names it (app.SinglePageApp)."""
NONCE_PLACEHOLDER = "__GEOTANDEM_CSP_NONCE__"
"""What the frontend build writes where the nonce belongs (frontend/vite.config.ts)."""
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _settings(scope: Scope) -> Any:
    return scope["app"].state.geotandem.settings


async def _reject(send: Send, status: int, code: str, message: str, **details: Any) -> None:
    """The same body as every other rejection (api/errors.py)."""
    body = json.dumps({"code": code, "message": message, "details": details}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


# --- #3: request size ------------------------------------------------------------


class _BodyTooLarge(Exception):
    pass


class BodyLimit:
    """Cut every request body off at ``max_request_mb``; an upload may be larger only
    for a signed-in administrator, checked before a byte of it is read."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit, upload = await self._limit(scope)
        declared = Headers(scope=scope).get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            await self._too_large(send, scope, upload)
            return

        received = 0
        exceeded = started = False

        async def counted() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise _BodyTooLarge
            return message

        async def guarded(message: Message) -> None:
            nonlocal started
            if exceeded:
                return  # the application's answer to a body it never got whole
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counted, guarded)
        except Exception:
            if not exceeded:
                raise
        if exceeded and not started:
            await self._too_large(send, scope, upload)

    async def _limit(self, scope: Scope) -> tuple[int, bool]:
        settings = _settings(scope)
        general = int(settings.max_request_mb * MiB)
        if scope["method"] != "POST" or scope["path"] != IMPORT_PATH:
            return general, False
        if not await run_in_threadpool(_is_admin, scope):
            return general, False
        return settings.max_import_mb * MiB + UPLOAD_OVERHEAD, True

    async def _too_large(self, send: Send, scope: Scope, upload: bool) -> None:
        settings = _settings(scope)
        audit.event("request_too_large", upload=upload)
        if upload:
            mb = settings.max_import_mb
            await _reject(send, 413, "upload_too_large", f"The file exceeds {mb} MB.", max_mb=mb)
        else:
            mb = settings.max_request_mb
            await _reject(
                send, 413, "request_too_large", f"The request exceeds {mb:g} MB.", max_mb=mb
            )


def _is_admin(scope: Scope) -> bool:
    """As ``require_admin`` would decide; the route checks again after the body."""
    state = scope["app"].state.geotandem
    token = Request(scope).cookies.get(sessions.COOKIE)
    lifetime = timedelta(hours=state.settings.session_hours)
    account = sessions.resolve(state.backend.engine, token, lifetime)
    return account is not None and account.role == "admin" and not account.must_change_password


# --- #8: cross-site requests -----------------------------------------------------


class SameOrigin:
    """Refuse changes asked for by another site, on top of the SameSite=Strict cookie.

    A browser names the page behind a request in ``Origin`` and, if recent,
    ``Sec-Fetch-Site``. Requests without them (curl, scripts) carry no
    browser's cookie unasked and pass.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] in UNSAFE_METHODS:
            headers = Headers(scope=scope)
            origin = headers.get("origin")
            fetch_site = headers.get("sec-fetch-site")
            foreign_origin = origin is not None and urlsplit(origin).netloc != headers.get("host")
            if foreign_origin or fetch_site in ("cross-site", "same-site"):
                audit.event("cross_origin_refused", origin=origin, fetch_site=fetch_site)
                await _reject(
                    send, 403, "cross_origin", "Requests from other sites are not accepted."
                )
                return
        await self.app(scope, receive, send)


# --- #4, #7: response headers ----------------------------------------------------


def content_security_policy(basemap: Basemap | None, nonce: str) -> str:
    """Everything from the instance itself; images also from the tile server, if any.

    Styles added at run time (dialogs lock scrolling with ``<style>`` elements)
    only with this page load's nonce; scripts only as files, never inline.
    """
    images = ["'self'", "data:"]
    if basemap is not None:
        images.append(_tile_origin(basemap.url))
    return "; ".join(
        [
            "default-src 'self'",
            f"img-src {' '.join(images)}",
            f"style-src 'self' 'nonce-{nonce}'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )


def _tile_origin(template: str) -> str:
    """``https://{s}.tile.example.org/{z}/{x}/{y}.png`` → ``https://*.tile.example.org``."""
    parts = urlsplit(template)
    host = ".".join("*" if "{" in label else label for label in parts.netloc.split("."))
    return f"{parts.scheme}://{host}"


class SecurityHeaders:
    """Headers on every response; HSTS only once the request came over HTTPS."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self._basemap: tuple[Basemap | None] | None = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        settings = _settings(scope)
        docs = settings.api_docs and scope["path"].startswith(DOCS_PATHS)
        nonce = scope[CSP_NONCE] = secrets.token_urlsafe(16)

        async def with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Content-Type-Options"] = "nosniff"
                headers["X-Frame-Options"] = "DENY"
                headers["Referrer-Policy"] = "same-origin"
                headers["Cross-Origin-Opener-Policy"] = "same-origin"
                if not docs:  # Swagger UI and ReDoc load from a CDN
                    headers["Content-Security-Policy"] = self._policy(settings, nonce)
                if scope.get("scheme") == "https":
                    headers["Strict-Transport-Security"] = "max-age=31536000"
            await send(message)

        await self.app(scope, receive, with_headers)

    def _policy(self, settings: Any, nonce: str) -> str:
        if self._basemap is None:
            self._basemap = (resolve(settings.basemap, settings.basemap_attribution),)
        return content_security_policy(self._basemap[0], nonce)
