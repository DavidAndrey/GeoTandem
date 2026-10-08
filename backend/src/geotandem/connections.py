"""Model connections: administration, rules and the account's choice (plan E2.1).

Local or external is derived from the host on every read (C5), never
stored, so a changed ``GEOTANDEM_LLM_LOCAL_HOSTS`` takes effect at once.
The API key is write-only: stored encrypted (C8), reported as
``has_api_key``, decrypted only to build an ``Endpoint`` for a call.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import BaseModel, Field, SecretStr, StringConstraints
from sqlalchemy import Engine, select, update
from sqlalchemy.orm import Session

from geotandem.connection_check import CheckResult
from geotandem.db.orm import LLMConnection, User
from geotandem.db.spatialite import reading
from geotandem.llm import Effort, Endpoint, LLMError, Locality, classify_host, host_of
from geotandem.vault import CredentialsUnreadable, Vault

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
BaseUrl = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
ModelName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
ApiKey = Annotated[SecretStr, Field(min_length=1, max_length=1000)]
Temperature = Annotated[float, Field(ge=0, le=2)]
Timeout = Annotated[float, Field(gt=0, le=600)]
ContextLength = Annotated[int, Field(ge=256, le=10_000_000)]


class ConnectionProblem(Exception):
    """A rule about connections was violated; ``code`` is stable for the UI."""

    def __init__(self, status: int, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


class CallParameters(BaseModel):
    """How to call the model (C4): what an ``Endpoint`` is built from."""

    base_url: BaseUrl
    model: ModelName
    api_key: ApiKey | None = None
    temperature: Temperature = 0
    seed: int | None = 42
    timeout_s: Timeout = 120
    reasoning_effort: Effort | None = Field(
        default=None, description="Unset: 'none' for a local connection, 'default' else (C10)."
    )
    marked_external: bool = False


def default_effort(local: bool) -> Effort:
    """Thinking off where it costs local time, the provider's own choice else (C10)."""
    return "none" if local else "default"


class ConnectionWrite(CallParameters):
    """A new connection (C4). Unset defaults follow from local or external."""

    name: Name
    context_length: ContextLength | None = None
    enabled: bool = False
    is_default: bool = False
    may_receive_data: bool | None = Field(
        default=None, description="Unset: on for a local connection, off else (C6)."
    )
    confirm_data_release: bool = Field(
        default=False,
        description="Required to let an external connection receive data contents (C6).",
    )


class ConnectionPatch(BaseModel):
    """Only the fields sent change. ``api_key: null`` removes the key."""

    name: Name | None = None
    base_url: BaseUrl | None = None
    model: ModelName | None = None
    api_key: ApiKey | None = None
    temperature: Temperature | None = None
    seed: int | None = None
    timeout_s: Timeout | None = None
    reasoning_effort: Effort | None = None
    context_length: ContextLength | None = None
    enabled: bool | None = None
    is_default: bool | None = None
    may_receive_data: bool | None = None
    marked_external: bool | None = None
    confirm_data_release: bool = False


NULLABLE = frozenset({"api_key", "seed", "context_length"})
"""Patch fields where ``null`` is a value, not "unchanged"."""


class ConnectionDraft(CallParameters):
    """What the connection test needs, before or without saving (C12).

    Editing a saved connection without retyping its key: name it in
    ``connection_id`` and the stored key is used.
    """

    connection_id: int | None = None


class ConnectionInfo(BaseModel):
    id: int
    name: str
    base_url: str
    host: str
    locality: Locality
    """Effective: external by host or by the administrator's mark (C5)."""
    model: str
    has_api_key: bool
    credentials_unreadable: bool
    """A key is stored but this instance's secret.key cannot open it (C8)."""
    temperature: float
    seed: int | None
    timeout_s: float
    reasoning_effort: Effort
    context_length: int | None
    enabled: bool
    is_default: bool
    may_receive_data: bool
    marked_external: bool
    last_test: CheckResult | None
    created_at: datetime
    updated_at: datetime


class ConnectionOption(BaseModel):
    """What a user sees of a connection when choosing one (C7, C14)."""

    id: int
    name: str
    model: str
    host: str
    locality: Locality
    is_default: bool


class ConnectionChoice(BaseModel):
    connections: list[ConnectionOption]
    """Enabled connections; none when the administrator has set none up (C18)."""
    chosen_connection_id: int | None
    """The account's stored choice, even while that connection is disabled (C17)."""
    active_connection_id: int | None
    """What a model action would use now: the choice if enabled, else the default."""


@dataclass(frozen=True)
class Connections:
    engine: Engine
    vault: Vault
    local_hosts: Sequence[str] = ()

    # --- reading -----------------------------------------------------------------

    def locality(self, row: LLMConnection) -> Locality:
        derived = classify_host(row.base_url, self.local_hosts)
        return "external" if row.marked_external or derived == "external" else "local"

    def is_local(self, base_url: str, marked_external: bool) -> bool:
        """Local by host and not marked external; an invalid URL counts as external."""
        try:
            return classify_host(base_url, self.local_hosts) == "local" and not marked_external
        except LLMError:
            return False

    @staticmethod
    def _row(session: Session, connection_id: int) -> LLMConnection:
        row = session.get(LLMConnection, connection_id)
        if row is None:
            raise ConnectionProblem(404, "not_found", "Unknown connection.", id=connection_id)
        return row

    def _info(self, row: LLMConnection) -> ConnectionInfo:
        return ConnectionInfo(
            id=row.id,
            name=row.name,
            base_url=row.base_url,
            host=host_of(row.base_url),
            locality=self.locality(row),
            model=row.model,
            has_api_key=row.api_key is not None,
            credentials_unreadable=self._key(row)[1],
            temperature=row.temperature,
            seed=row.seed,
            timeout_s=row.timeout_s,
            reasoning_effort=row.reasoning_effort,
            context_length=row.context_length,
            enabled=row.enabled,
            is_default=row.is_default,
            may_receive_data=row.may_receive_data,
            marked_external=row.marked_external,
            last_test=row.last_test,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )

    def all(self) -> list[ConnectionInfo]:
        with Session(reading(self.engine)) as session:
            rows = session.scalars(select(LLMConnection).order_by(LLMConnection.name))
            return [self._info(row) for row in rows]

    def get(self, connection_id: int) -> ConnectionInfo | None:
        with Session(reading(self.engine)) as session:
            row = session.get(LLMConnection, connection_id)
            return self._info(row) if row else None

    def _key(self, row: LLMConnection) -> tuple[str | None, bool]:
        """The stored key decrypted, and whether it could not be."""
        if row.api_key is None:
            return None, False
        try:
            return self.vault.decrypt(row.api_key), False
        except CredentialsUnreadable:
            return None, True

    def endpoint(self, connection_id: int) -> Endpoint:
        """The parameters for a call, the key decrypted (C8). Raises
        ``CredentialsUnreadable`` when the key cannot be opened."""
        with Session(reading(self.engine)) as session:
            row = self._row(session, connection_id)
            return self._endpoint(row, self.vault.decrypt(row.api_key) if row.api_key else None)

    @staticmethod
    def _endpoint(row: LLMConnection, key: str | None) -> Endpoint:
        return Endpoint(
            base_url=row.base_url,
            model=row.model,
            api_key=key,
            temperature=row.temperature,
            seed=row.seed,
            timeout_s=row.timeout_s,
            reasoning_effort=row.reasoning_effort,  # type: ignore[arg-type]
        )

    def for_test(self, connection_id: int) -> tuple[Endpoint, bool]:
        """A saved connection's endpoint for the test; an unreadable key is
        reported, not raised, so the test can say which step it breaks."""
        with Session(reading(self.engine)) as session:
            row = self._row(session, connection_id)
            key, unreadable = self._key(row)
            return self._endpoint(row, key), unreadable

    def draft_for_test(self, draft: ConnectionDraft) -> tuple[Endpoint, bool]:
        key: str | None = draft.api_key.get_secret_value() if draft.api_key else None
        unreadable = False
        if key is None and draft.connection_id is not None:
            with Session(reading(self.engine)) as session:
                key, unreadable = self._key(self._row(session, draft.connection_id))
        # An invalid URL takes the external default; the test's first step reports it.
        effort = draft.reasoning_effort or default_effort(
            self.is_local(draft.base_url, draft.marked_external)
        )
        endpoint = Endpoint(
            base_url=draft.base_url,
            model=draft.model,
            api_key=key,
            temperature=draft.temperature,
            seed=draft.seed,
            timeout_s=draft.timeout_s,
            reasoning_effort=effort,
        )
        return endpoint, unreadable

    def record_test(self, connection_id: int, result: CheckResult) -> None:
        """Keep the latest test with the connection (C12); the list shows it."""
        with Session(self.engine) as session, session.begin():
            session.execute(
                update(LLMConnection)
                .where(LLMConnection.id == connection_id)
                .values(last_test=result.model_dump(mode="json"))
            )

    # --- writing -----------------------------------------------------------------

    def _check_url(self, base_url: str) -> None:
        try:
            host_of(base_url)
        except LLMError as exc:
            raise ConnectionProblem(400, exc.code, exc.message, cause=exc.cause) from None

    @staticmethod
    def _check_name(session: Session, name: str, own_id: int | None) -> None:
        with session.no_autoflush:
            others = [r for r in session.scalars(select(LLMConnection)) if r.id != own_id]
        if any(other.name.casefold() == name.casefold() for other in others):
            raise ConnectionProblem(
                400, "connection_name_taken", f"A connection named '{name}' exists.", name=name
            )

    def _check_release(self, row: LLMConnection, released_before: bool, confirmed: bool) -> None:
        """Data contents to an external connection only on explicit confirmation (C6)."""
        if (
            self.locality(row) == "external"
            and row.may_receive_data
            and not released_before
            and not confirmed
        ):
            raise ConnectionProblem(
                400,
                "data_release_unconfirmed",
                "Letting an external connection receive data contents needs confirmation.",
                name=row.name,
            )

    @staticmethod
    def _settle_default(
        session: Session, made_default: LLMConnection | None, had_default: bool
    ) -> None:
        """At most one default, always enabled; while any connection is enabled,
        exactly one is the default (C18). ``made_default``: the connection this
        change makes the default, if any."""
        if made_default is not None and not made_default.enabled:
            raise ConnectionProblem(
                400,
                "default_not_enabled",
                "The default connection must be enabled for users.",
                name=made_default.name,
            )
        session.flush()
        rows = list(session.scalars(select(LLMConnection).order_by(LLMConnection.id)))
        for other in rows:
            if made_default is not None and other is not made_default:
                other.is_default = False
            if other.is_default and not other.enabled:
                other.is_default = False  # the last enabled one went: it may (C18)
        enabled = [r for r in rows if r.enabled]
        if not enabled or any(r.is_default for r in enabled):
            return
        if had_default:
            raise ConnectionProblem(
                400,
                "default_connection_required",
                "Make another enabled connection the default first.",
            )
        enabled[0].is_default = True  # the first enabled one becomes the default

    @staticmethod
    def _had_default(session: Session) -> bool:
        return (
            session.scalar(
                select(LLMConnection.id).where(LLMConnection.is_default, LLMConnection.enabled)
            )
            is not None
        )

    def create(self, body: ConnectionWrite) -> ConnectionInfo:
        self._check_url(body.base_url)
        local = self.is_local(body.base_url, body.marked_external)
        row = LLMConnection(
            name=body.name,
            base_url=body.base_url,
            model=body.model,
            api_key=self.vault.encrypt(body.api_key.get_secret_value()) if body.api_key else None,
            temperature=body.temperature,
            seed=body.seed,
            timeout_s=body.timeout_s,
            reasoning_effort=body.reasoning_effort or default_effort(local),
            context_length=body.context_length,
            enabled=body.enabled,
            is_default=body.is_default,
            may_receive_data=local if body.may_receive_data is None else body.may_receive_data,
            marked_external=body.marked_external,
        )
        self._check_release(row, released_before=False, confirmed=body.confirm_data_release)
        with Session(self.engine) as session, session.begin():
            had_default = self._had_default(session)
            self._check_name(session, row.name, None)
            session.add(row)
            self._settle_default(session, row if row.is_default else None, had_default)
            new_id = row.id
        return self.get(new_id)  # type: ignore[return-value]

    def update(
        self, connection_id: int, patch: ConnectionPatch
    ) -> tuple[ConnectionInfo, list[str]]:
        """The connection after the patch, and the names of the fields that changed."""
        sent = patch.model_fields_set - {"confirm_data_release"}
        with Session(self.engine) as session, session.begin():
            row = self._row(session, connection_id)
            released_before = row.may_receive_data and self.locality(row) == "external"
            had_default = self._had_default(session)
            changed: list[str] = []
            for name in sorted(sent):
                value = getattr(patch, name)
                if value is None and name not in NULLABLE:
                    continue
                if name == "api_key":
                    row.api_key = self.vault.encrypt(value.get_secret_value()) if value else None
                    changed.append(name)
                    continue
                if name == "base_url":
                    self._check_url(value)
                if getattr(row, name) != value:
                    setattr(row, name, value)
                    changed.append(name)
            self._check_release(row, released_before, patch.confirm_data_release)
            self._check_name(session, row.name, row.id)
            made_default = row if "is_default" in changed and row.is_default else None
            self._settle_default(session, made_default, had_default)
            row.updated_at = datetime.now(UTC).replace(tzinfo=None)
        return self.get(connection_id), changed  # type: ignore[return-value]

    def delete(self, connection_id: int) -> None:
        """Accounts that chose it fall back to the default (C17, ON DELETE SET NULL)."""
        with Session(self.engine) as session, session.begin():
            row = self._row(session, connection_id)
            had_default = self._had_default(session)
            session.delete(row)
            self._settle_default(session, None, had_default)

    # --- the account's choice (C14, C17) -----------------------------------------

    def active(self, user_id: int) -> ConnectionInfo | None:
        """The connection a model action of this account uses: its choice while that
        is enabled, else the default, else none. Resolved on every use."""
        with Session(reading(self.engine)) as session:
            chosen_id = session.scalar(select(User.llm_connection_id).where(User.id == user_id))
            chosen = session.get(LLMConnection, chosen_id) if chosen_id is not None else None
            if chosen is not None and chosen.enabled:
                return self._info(chosen)
            default = session.scalar(
                select(LLMConnection).where(LLMConnection.is_default, LLMConnection.enabled)
            )
            return self._info(default) if default else None

    def options(self, user_id: int) -> ConnectionChoice:
        with Session(reading(self.engine)) as session:
            chosen = session.scalar(select(User.llm_connection_id).where(User.id == user_id))
            rows = session.scalars(
                select(LLMConnection).where(LLMConnection.enabled).order_by(LLMConnection.name)
            )
            offered = [
                ConnectionOption(
                    id=r.id,
                    name=r.name,
                    model=r.model,
                    host=host_of(r.base_url),
                    locality=self.locality(r),
                    is_default=r.is_default,
                )
                for r in rows
            ]
        active = self.active(user_id)
        return ConnectionChoice(
            connections=offered,
            chosen_connection_id=chosen,
            active_connection_id=active.id if active else None,
        )

    def choose(self, user_id: int, connection_id: int | None) -> None:
        """Store the account's choice; a disabled connection is refused, also for
        administrators (C14)."""
        with Session(self.engine) as session, session.begin():
            if connection_id is not None:
                row = session.get(LLMConnection, connection_id)
                if row is None or not row.enabled:
                    raise ConnectionProblem(
                        400,
                        "connection_not_available",
                        "That connection is not offered.",
                        id=connection_id,
                    )
            session.execute(
                update(User).where(User.id == user_id).values(llm_connection_id=connection_id)
            )
