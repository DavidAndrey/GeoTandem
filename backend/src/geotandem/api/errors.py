"""One error body for every rejection: ``{code, message, details}`` (F-5.9)."""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from geotandem.engine import QueryError
from geotandem.tools import UnknownTool


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = {}


def _body(status: int, code: str, message: str, **details: Any) -> JSONResponse:
    body = ErrorBody(code=code, message=message, details=details)
    return JSONResponse(status_code=status, content=body.model_dump(mode="json"))


def install(app: FastAPI) -> None:
    @app.exception_handler(QueryError)
    async def _query_error(_: Request, exc: QueryError) -> JSONResponse:
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
