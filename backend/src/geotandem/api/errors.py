"""One error body for every rejection: ``{code, message, details}`` (F-5.9)."""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from geotandem import audit
from geotandem.auth.accounts import AccountError, HashingBusy
from geotandem.engine import QueryError
from geotandem.saved_queries import SavedQueryError
from geotandem.sessions import SessionError
from geotandem.tools import UnknownTool


class Problem(Exception):
    """A rejected HTTP request with a stable ``code`` (same body as engine errors)."""

    status = 400
    code = "bad_request"

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message)
        self.message = message
        self.details = details

    @property
    def headers(self) -> dict[str, str]:
        return {}


class NotFound(Problem):
    status = 404
    code = "not_found"


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = {}


def _body(
    status: int, code: str, message: str, headers: dict[str, str] | None = None, **details: Any
) -> JSONResponse:
    body = ErrorBody(code=code, message=message, details=details)
    return JSONResponse(status_code=status, content=body.model_dump(mode="json"), headers=headers)


def install(app: FastAPI) -> None:
    @app.exception_handler(QueryError)
    async def _query_error(_: Request, exc: QueryError) -> JSONResponse:
        return _body(exc.status, exc.code, exc.message, **exc.details)

    @app.exception_handler(Problem)
    async def _problem(_: Request, exc: Problem) -> JSONResponse:
        return _body(exc.status, exc.code, exc.message, exc.headers, **exc.details)

    @app.exception_handler(AccountError)
    async def _account_rule(_: Request, exc: AccountError) -> JSONResponse:
        return _body(400, exc.code, exc.message)

    @app.exception_handler(HashingBusy)
    async def _hashing_busy(_: Request, exc: HashingBusy) -> JSONResponse:
        # Many sign-ins at once (security review #2): the client may simply try again.
        message = "Too many sign-ins at the same time. Please try again shortly."
        audit.event("hashing_busy")
        return _body(503, "busy", message, {"Retry-After": "5"})

    @app.exception_handler(SessionError)
    async def _session_rule(_: Request, exc: SessionError) -> JSONResponse:
        return _body(exc.status, exc.code, exc.message, **exc.details)

    @app.exception_handler(SavedQueryError)
    async def _saved_query_rule(_: Request, exc: SavedQueryError) -> JSONResponse:
        return _body(exc.status, exc.code, exc.message, **exc.details)

    @app.exception_handler(RequestValidationError)
    async def _schema_violation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
        first = errors[0] if errors else {"loc": [], "msg": "invalid request"}
        where = ".".join(str(p) for p in first["loc"][1:]) or "body"
        return _body(422, "schema_violation", f"{where}: {first['msg']}", errors=errors)

    @app.exception_handler(UnknownTool)
    async def _unknown_tool(_: Request, exc: UnknownTool) -> JSONResponse:
        return _body(404, "unknown_tool", f"Unknown tool '{exc.args[0]}'.")
