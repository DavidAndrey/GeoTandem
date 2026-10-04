"""Sign-in, first administrator and own password (E1.4, F-3.12; design A1, A2, A4).

The session lives server-side; the browser holds only an HttpOnly,
SameSite=Strict cookie, which a cross-site request never carries.
"""

from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel

from geotandem.api.errors import ErrorBody, Problem
from geotandem.api.state import AppState, get_state
from geotandem.auth import accounts, sessions
from geotandem.auth.accounts import Account
from geotandem.catalog import list_layers
from geotandem.sample.load import SOURCE as SAMPLE_SOURCE
from geotandem.sample.load import load_sample

router = APIRouter(prefix="/api/auth", tags=["auth"])
State = Annotated[AppState, Depends(get_state)]

ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorBody} for status in (400, 401, 403, 409)
}


class NotAuthenticated(Problem):
    status = 401
    code = "not_authenticated"


class PasswordChangeRequired(Problem):
    status = 403
    code = "password_change_required"


class Forbidden(Problem):
    status = 403
    code = "forbidden"


class SetupClosed(Problem):
    status = 409
    code = "setup_closed"


# --- dependencies -------------------------------------------------------------


def _lifetime(state: AppState) -> timedelta:
    return timedelta(hours=state.settings.session_hours)


def signed_in(request: Request, state: State) -> Account | None:
    return sessions.resolve(
        state.backend.engine, request.cookies.get(sessions.COOKIE), _lifetime(state)
    )


def require_session(account: Annotated[Account | None, Depends(signed_in)]) -> Account:
    """Signed in, possibly still with the start password: only for own-account routes."""
    if account is None:
        raise NotAuthenticated("Please sign in.")
    return account


def require_account(account: Annotated[Account, Depends(require_session)]) -> Account:
    """Signed in and done with the start password (design A4: a mandatory step)."""
    if account.must_change_password:
        raise PasswordChangeRequired("Please change your start password first.")
    return account


def require_admin(account: Annotated[Account, Depends(require_account)]) -> Account:
    if account.role != "admin":
        raise Forbidden("This needs the administrator role.")
    return account


CurrentAccount = Annotated[Account, Depends(require_account)]
CurrentSession = Annotated[Account, Depends(require_session)]


def _sign_in(response: Response, state: AppState, account: Account) -> None:
    token = sessions.start(state.backend.engine, account.id, _lifetime(state))
    response.set_cookie(
        sessions.COOKIE,
        token,
        httponly=True,
        samesite="strict",
        secure=state.settings.cookie_secure,
        path="/",
    )


# --- routes -------------------------------------------------------------------


class SetupStatus(BaseModel):
    needs_setup: bool
    """No account exists yet: the first one becomes administrator (design A1)."""
    sample_loaded: bool


class SetupRequest(BaseModel):
    username: str
    display_name: str = ""
    password: str
    load_sample: bool = True


class Credentials(BaseModel):
    username: str
    password: str


class PasswordChange(BaseModel):
    current: str
    new: str


def _sample_loaded(state: AppState) -> bool:
    return any(layer.source == SAMPLE_SOURCE for layer in list_layers(state.backend.engine))


@router.get("/setup")
def setup_status(state: State) -> SetupStatus:
    return SetupStatus(
        needs_setup=not accounts.has_accounts(state.backend.engine),
        sample_loaded=_sample_loaded(state),
    )


@router.post("/setup", responses=ERRORS)
def setup(body: SetupRequest, response: Response, state: State) -> Account:
    """Create the first administrator; closed as soon as any account exists."""
    if accounts.has_accounts(state.backend.engine):
        raise SetupClosed("The application is already set up.")
    try:
        account = accounts.create(
            state.backend.engine,
            body.username,
            body.password,
            "admin",
            display_name=body.display_name,
            first=True,
        )
    except accounts.AccountError as exc:
        if exc.code == "setup_closed":
            raise SetupClosed(exc.message) from exc
        raise
    if body.load_sample and not _sample_loaded(state):
        load_sample(state.backend)
    _sign_in(response, state, account)
    return account


@router.post("/login", responses=ERRORS)
def login(body: Credentials, response: Response, state: State) -> Account:
    account = accounts.authenticate(state.backend.engine, body.username, body.password)
    if account is None:
        # One answer for unknown, wrong and locked: no hint which accounts exist.
        raise NotAuthenticated("Username or password is wrong, or the account is locked.")
    _sign_in(response, state, account)
    return account


@router.post("/logout", status_code=204)
def logout(request: Request, state: State) -> Response:
    sessions.end(state.backend.engine, request.cookies.get(sessions.COOKIE))
    response = Response(status_code=204)
    response.delete_cookie(sessions.COOKIE, path="/")
    return response


@router.get("/me", responses=ERRORS)
def me(account: CurrentSession) -> Account:
    return account


@router.post("/password", status_code=204, responses=ERRORS)
def change_password(
    body: PasswordChange, request: Request, account: CurrentSession, state: State
) -> Response:
    """A changed password signs out every other login, e.g. one with a stolen cookie."""
    accounts.change_password(state.backend.engine, account.id, body.current, body.new)
    sessions.end_others(state.backend.engine, account.id, request.cookies.get(sessions.COOKIE))
    return Response(status_code=204)
