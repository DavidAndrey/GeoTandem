"""FastAPI application: one process, one port, API plus built frontend."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.types import Scope

from geotandem import __version__
from geotandem.api import admin, auth, errors, routes, sessions
from geotandem.api.state import AppState
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
    return AppState(settings, backend, unsupported, default_registry(), staging)


class SinglePageApp(StaticFiles):
    """Serve the built frontend; unknown non-API paths get index.html (client routing)."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code != 404 or path.startswith("api/"):
                raise
            return await super().get_response("index.html", scope)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.geotandem = start(settings)
        yield
        app.state.geotandem.backend.engine.dispose()

    app = FastAPI(title="GeoTandem", version=__version__, lifespan=lifespan)
    errors.install(app)
    app.include_router(routes.router)
    app.include_router(admin.router)
    app.include_router(auth.router)
    app.include_router(sessions.router)
    frontend = settings.frontend_dir
    if frontend is not None and Path(frontend, "index.html").exists():
        app.mount("/", SinglePageApp(directory=frontend, html=True), name="frontend")
    return app


def openapi_document() -> str:
    """OpenAPI description as committed in ``frontend/openapi.json`` (tech-stack 4.5)."""
    import json

    return json.dumps(create_app(Settings()).openapi(), indent=2, ensure_ascii=False) + "\n"
