"""Sign-in, first administrator and own password (E1.4, F-3.12; design A1, A2, A4).

The session lives server-side; the browser holds only an HttpOnly,
SameSite=Strict cookie, which a cross-site request never carries.
"""

import math
from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field

from geotandem import audit
from geotandem.api.errors import ErrorBody, Problem
from geotandem.api.state import AppState, get_state
from geotandem.auth import accounts, sessions, setup_token
from geotandem.auth.accounts import MAX_PASSWORD_LENGTH, Account
from geotandem.catalog import list_layers
from geotandem.sample.load import SOURCE as SAMPLE_SOURCE
from geotandem.sample.load import load_sample

router = APIRouter(prefix="/api/auth", tags=["auth"])
State = Annotated[AppState, Depends(get_state)]

ERRORS: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorBody} for status in (400, 401, 403, 409, 429, 503)
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


class SetupTokenInvalid(Problem):
    status = 403
    code = "setup_token_invalid"


class TooManyAttempts(Problem):
    status = 429
    code = "too_many_attempts"

    def __init__(self, retry_after_s: float) -> None:
        seconds = math.ceil(retry_after_s)
        minutes = math.ceil(seconds / 60)
        super().__init__(
            f"Too many failed sign-ins. Please try again in {minutes} "
            f"minute{'s' if minutes != 1 else ''}.",
            retry_after_s=seconds,
        )

    @property
    def headers(self) -> dict[str, str]:
        return {"Retry-After": str(self.details["retry_after_s"])}


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
        audit.event("forbidden", username=account.username, role=account.role)
        raise Forbidden("This needs the administrator role.")
    return account


CurrentAccount = Annotated[Account, Depends(require_account)]
CurrentSession = Annotated[Account, Depends(require_session)]


def _address(request: Request) -> str:
    """The client as uvicorn sees it; behind a proxy only if ``FORWARDED_ALLOW_IPS`` trusts it."""
    return request.client.host if request.client else "unknown"


def _brake(state: AppState, address: str, username: str) -> None:
    """Refuse before any password is checked while the throttle says so (review #2)."""
    wait = state.login_throttle.retry_after(address, username)
    if wait is not None:
        refusal = TooManyAttempts(wait)
        audit.event(
            "sign_in_throttled", username=username, retry_after_s=refusal.details["retry_after_s"]
        )
        raise refusal


def _sign_in(request: Request, response: Response, state: AppState, account: Account) -> None:
    token = sessions.start(state.backend.engine, account.id, _lifetime(state))
    response.set_cookie(
        sessions.COOKIE,
        token,
        httponly=True,
        samesite="strict",
        # Over HTTPS always: the setting must not be the only thing between the
        # cookie and plain HTTP (security review #4).
        secure=state.settings.cookie_secure or request.url.scheme == "https",
        path="/",
    )


# --- routes -------------------------------------------------------------------


class SetupStatus(BaseModel):
    needs_setup: bool
    """No account exists yet: the first one becomes administrator (design A1)."""
    sample_loaded: bool


Username = Annotated[str, Field(max_length=64)]
Password = Annotated[str, Field(max_length=MAX_PASSWORD_LENGTH)]
"""Bounded, so one request cannot ask for unbounded hashing work (review #2)."""


class SetupRequest(BaseModel):
    token: Annotated[str, Field(max_length=256)]
    """From the installation: its log, or ``GEOTANDEM_SETUP_TOKEN`` (security review #1)."""
    username: Username
    display_name: str = ""
    password: Password
    load_sample: bool = True


class Credentials(BaseModel):
    username: Username
    password: Password


class PasswordChange(BaseModel):
    current: Password
    new: Password


def _sample_loaded(state: AppState) -> bool:
    return any(layer.source == SAMPLE_SOURCE for layer in list_layers(state.backend.engine))


@router.get("/setup")
def setup_status(state: State) -> SetupStatus:
    return SetupStatus(
        needs_setup=not accounts.has_accounts(state.backend.engine),
        sample_loaded=_sample_loaded(state),
    )


@router.post("/setup", responses=ERRORS)
def setup(body: SetupRequest, request: Request, response: Response, state: State) -> Account:
    """Create the first administrator; closed as soon as any account exists.

    Only with the installation's token: reaching the address is not enough
    (security review #1). Wrong tokens are braked like failed sign-ins.
    """
    if accounts.has_accounts(state.backend.engine):
        raise SetupClosed("The application is already set up.")
    address = _address(request)
    _brake(state, address, setup_token.THROTTLE_KEY)
    if not setup_token.matches(state.setup_token, body.token):
        state.login_throttle.failed(address, setup_token.THROTTLE_KEY)
        audit.event("setup_token_rejected")
        raise SetupTokenInvalid(
            "The setup token is wrong. It is in the log of the installation, "
            "or set as GEOTANDEM_SETUP_TOKEN."
        )
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
    state.setup_token = None  # used up
    audit.event("setup", username=account.username)
    if body.load_sample and not _sample_loaded(state):
        load_sample(state.backend)
    _sign_in(request, response, state, account)
    return account


@router.post("/login", responses=ERRORS)
def login(body: Credentials, request: Request, response: Response, state: State) -> Account:
    """Repeated failures are braked per username and client address (review #2)."""
    address = _address(request)
    _brake(state, address, body.username)
    account = accounts.authenticate(state.backend.engine, body.username, body.password)
    if account is None:
        state.login_throttle.failed(address, body.username)
        # The log says why; the answer does not, so it hints at no account.
        reason = accounts.failure_reason(state.backend.engine, body.username)
        audit.event("sign_in_failed", username=body.username, reason=reason)
        raise NotAuthenticated("Username or password is wrong, or the account is locked.")
    state.login_throttle.succeeded(address, body.username)
    audit.event("sign_in", username=account.username)
    _sign_in(request, response, state, account)
    return account


@router.post("/logout", status_code=204)
def logout(
    request: Request, state: State, account: Annotated[Account | None, Depends(signed_in)]
) -> Response:
    if account is not None:
        audit.event("sign_out", username=account.username)
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
    """A changed password signs out every other login, e.g. one with a stolen cookie.

    Wrong current passwords count like failed sign-ins: a stolen cookie must
    not become a way to guess the password (review #2).
    """
    address = _address(request)
    _brake(state, address, account.username)
    try:
        accounts.change_password(state.backend.engine, account.id, body.current, body.new)
    except accounts.AccountError as exc:
        if exc.code == "wrong_password":
            state.login_throttle.failed(address, account.username)
            audit.event("password_change_failed", username=account.username)
        raise
    state.login_throttle.succeeded(address, account.username)
    audit.event("password_changed", username=account.username)
    sessions.end_others(state.backend.engine, account.id, request.cookies.get(sessions.COOKIE))
    return Response(status_code=204)
