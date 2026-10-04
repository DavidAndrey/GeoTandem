"""FastAPI application: one process, one port, API plus built frontend."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, HTMLResponse, Response
from starlette.types import Scope

from geotandem import __version__, audit
from geotandem.api import admin, auth, errors, queries, routes, sessions
from geotandem.api.guards import (
    CSP_NONCE,
    NONCE_PLACEHOLDER,
    BodyLimit,
    SameOrigin,
    SecurityHeaders,
)
from geotandem.api.slots import HashingSlots, QuerySlots
from geotandem.api.state import AppState
from geotandem.auth import accounts, setup_token
from geotandem.auth.device import Devices
from geotandem.auth.throttle import LoginThrottle
from geotandem.config import Settings, get_settings
from geotandem.data.spatialite import SpatiaLiteBackend
from geotandem.db.bootstrap import bootstrap
from geotandem.importing import log as import_log
from geotandem.importing.staging import Staging
from geotandem.sample.load import load_sample
from geotandem.tools import default_registry

log = logging.getLogger(__name__)


def start(settings: Settings) -> AppState:
    """Bring the data core up to date and check capabilities (F-2.12, F-2.14)."""
    engine = bootstrap(settings)
    backend = SpatiaLiteBackend(engine, settings.internal_crs)
    unsupported = backend.missing_functions()
    for op, functions in unsupported.items():
        log.warning(
            "backend %s cannot perform '%s': missing %s", backend.name, op, ", ".join(functions)
        )
    if stale := import_log.fail_stale(engine):
        log.warning("%d imports were interrupted by the last shutdown", stale)
    if settings.load_sample_data:
        load_sample(backend)
    staging = Staging(settings.staging_dir)
    staging.cleanup()
    throttle = LoginThrottle(
        settings.login_failures,
        settings.login_failures_per_address,
        settings.login_failures_per_username,
    )
    slots = QuerySlots(
        settings.max_running_queries_per_account,
        settings.max_running_queries,
        wait_s=settings.query_timeout_s,
    )
    hashing = HashingSlots(accounts.MAX_HASHING, accounts.HASHING_WAIT_S)
    token = None if accounts.has_accounts(engine) else setup_token.issue(settings)
    return AppState(
        settings,
        backend,
        unsupported,
        default_registry(),
        staging,
        throttle,
        slots,
        hashing,
        Devices(),
        token,
    )


class SinglePageApp(StaticFiles):
    """Serve the built frontend; unknown non-API paths get index.html (client routing).

    The page names this request's Content-Security-Policy nonce, so it is
    filled in on every load and never cached (security review #7).
    """

    _page: str | None = None

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            response = await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code != 404 or path.startswith("api/"):
                raise
            response = await super().get_response("index.html", scope)
        if isinstance(response, FileResponse) and Path(response.path).name == "index.html":
            if self._page is None:
                self._page = Path(response.path).read_text(encoding="utf-8")
            page = self._page.replace(NONCE_PLACEHOLDER, scope.get(CSP_NONCE, ""))
            return HTMLResponse(page, headers={"Cache-Control": "no-store"})
        return response


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.geotandem = start(settings)
        yield
        app.state.geotandem.backend.engine.dispose()

    docs = settings.api_docs
    app = FastAPI(
        title="GeoTandem",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
    )
    # Outermost last: headers go on every answer, also on the guards' refusals.
    app.add_middleware(BodyLimit)
    app.add_middleware(SameOrigin)
    app.add_middleware(SecurityHeaders)
    # Outermost: every security event, the guards' included, knows its request.
    app.add_middleware(audit.AuditContext)
    audit.configure()
    errors.install(app)
    app.include_router(routes.router)
    app.include_router(admin.router)
    app.include_router(auth.router)
    app.include_router(sessions.router)
    app.include_router(queries.router)
    frontend = settings.frontend_dir
    if frontend is not None and Path(frontend, "index.html").exists():
        app.mount("/", SinglePageApp(directory=frontend, html=True), name="frontend")
    return app


def openapi_document() -> str:
    """OpenAPI description as committed in ``frontend/openapi.json`` (tech-stack 4.5)."""
    import json

    return json.dumps(create_app(Settings()).openapi(), indent=2, ensure_ascii=False) + "\n"
