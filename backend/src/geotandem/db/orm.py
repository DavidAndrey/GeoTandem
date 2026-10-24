"""Administrative schema with a fixed structure (tech-stack 3.3).

Layer tables themselves are data, created dynamically by the data-access
layer, and are not part of this metadata or of the Alembic migrations.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from sqlalchemy import (
    JSON,
    CheckConstraint,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    false,
    func,
    true,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

LayerKind = Literal["vector", "table"]
AttributeType = Literal["integer", "real", "text", "boolean", "date"]


class Base(DeclarativeBase):
    pass


class Layer(Base):
    __tablename__ = "layer"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(63), unique=True)
    title: Mapped[str]
    description: Mapped[str] = mapped_column(default="")
    kind: Mapped[str] = mapped_column(String(16))
    geometry_type: Mapped[str | None] = mapped_column(String(32))
    srid: Mapped[int | None]
    feature_count: Mapped[int] = mapped_column(default=0)
    bbox_wgs84: Mapped[list[float] | None] = mapped_column(JSON)
    source: Mapped[str] = mapped_column(default="")
    dataset_version: Mapped[str | None] = mapped_column(String(64))
    for_model: Mapped[bool] = mapped_column(server_default=true())
    """Offered to the model as context (F-2.9, F-9.3); takes effect from E2.2."""
    created_at: Mapped[datetime] = mapped_column(server_default=func.current_timestamp())
    updated_at: Mapped[datetime | None] = mapped_column(
        default=func.current_timestamp(), onupdate=func.current_timestamp()
    )

    attributes: Mapped[list[LayerAttribute]] = relationship(
        back_populates="layer",
        cascade="all, delete-orphan",
        order_by="LayerAttribute.position",
    )


class LayerAttribute(Base):
    """Attribute metadata (F-2.8), the basis of the layer profile (F-2.9)."""

    __tablename__ = "layer_attribute"
    __table_args__ = (UniqueConstraint("layer_id", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    layer_id: Mapped[int] = mapped_column(ForeignKey("layer.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(63))
    position: Mapped[int]
    data_type: Mapped[str] = mapped_column(String(16))
    label: Mapped[str] = mapped_column(default="")
    description: Mapped[str] = mapped_column(default="")
    unit: Mapped[str | None]
    value_domain: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    value_domain_confirmed: Mapped[bool] = mapped_column(server_default=true())
    """A domain proposed from the data reaches the model only once confirmed (S2)."""
    for_model: Mapped[bool] = mapped_column(server_default=true())
    references: Mapped[str | None] = mapped_column(String(127))
    """``layer.attribute`` this attribute is a key to, e.g. from a key-join import (F-2.9)."""

    layer: Mapped[Layer] = relationship(back_populates="attributes")


ImportStatus = Literal["running", "ok", "warning", "failed", "aborted"]


class ImportRun(Base):
    """One import attempt, successful or not (F-2.10)."""

    __tablename__ = "import_run"

    id: Mapped[int] = mapped_column(primary_key=True)
    started_at: Mapped[datetime] = mapped_column(
        server_default=func.current_timestamp(), index=True
    )
    finished_at: Mapped[datetime | None]
    actor: Mapped[str | None] = mapped_column(String(63))
    """Username at the time of the import; kept as text so the log outlives the account."""
    source_name: Mapped[str]
    source_format: Mapped[str] = mapped_column(String(16))
    layer_name: Mapped[str | None] = mapped_column(String(63))
    mode: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16))
    read_count: Mapped[int] = mapped_column(default=0)
    imported_count: Mapped[int] = mapped_column(default=0)
    rejected_count: Mapped[int] = mapped_column(default=0)
    decisions: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    warnings: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    errors: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    steps: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    rejected_sample: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    """Rejected rows with their reason, capped at 1000 (design D8)."""


Role = Literal["admin", "user"]
ROLES: tuple[Role, ...] = ("admin", "user")


class User(Base):
    """A local account (F-3.12; etappen 11.1: no groups, no SSO)."""

    __tablename__ = "app_user"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(63), unique=True)
    display_name: Mapped[str] = mapped_column(default="")
    password_hash: Mapped[str]
    role: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="active")
    """``active`` or ``locked``."""
    must_change_password: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.current_timestamp())
    last_login_at: Mapped[datetime | None]
    level_id: Mapped[int | None] = mapped_column(ForeignKey("level.id", ondelete="SET NULL"))
    """The chosen level of model support; none or gone means the default (plan E2.0, H7)."""
    llm_connection_id: Mapped[int | None] = mapped_column(
        ForeignKey("llm_connection.id", ondelete="SET NULL")
    )
    """The chosen model connection; disabled, none or gone means the default (plan C17)."""


class AuthSession(Base):
    """A server-side login session; the cookie holds the token, the table only its hash."""

    __tablename__ = "auth_session"

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("app_user.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.current_timestamp())
    expires_at: Mapped[datetime]

    user: Mapped[User] = relationship()


class LayerVisibility(Base):
    """Layer released for a role (F-2.7). Administrators see every layer regardless."""

    __tablename__ = "layer_visibility"

    layer_id: Mapped[int] = mapped_column(
        ForeignKey("layer.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(16), primary_key=True)


class AnalysisSession(Base):
    """A named, saved analysis state (F-4.10), private to its owner (design decision 2).

    Not to be confused with ``AuthSession``, the login. Holds the frontend's
    state as versioned JSON, the result query object and the result stamp
    the server computed from it (F-8.9; plan E1.7, S5).
    """

    __tablename__ = "analysis_session"
    __table_args__ = (UniqueConstraint("owner_id", "name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("app_user.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(120))
    note: Mapped[str] = mapped_column(default="")
    state_version: Mapped[int]
    state: Mapped[dict[str, Any]] = mapped_column(JSON)
    query: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    """The result query object, canonical; null while the analysis has no result layer."""
    stamp: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    """``ResultStamp`` of ``query`` at save time."""
    stamped_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.current_timestamp())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.current_timestamp())
    opened_at: Mapped[datetime | None]


class SavedQuery(Base):
    """A named query — result layer, conditions, restriction — reusable across
    sessions and shareable read-only with every account (design C6, plan E1.7b).
    """

    __tablename__ = "saved_query"
    __table_args__ = (UniqueConstraint("owner_id", "name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("app_user.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(120))
    shared: Mapped[bool] = mapped_column(default=False)
    state_version: Mapped[int]
    state: Mapped[dict[str, Any]] = mapped_column(JSON)
    query: Mapped[dict[str, Any]] = mapped_column(JSON)
    layers: Mapped[list[str]] = mapped_column(JSON)
    """Every catalog layer the query uses; a shared query shows only to who sees them all."""
    created_at: Mapped[datetime] = mapped_column(server_default=func.current_timestamp())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.current_timestamp())

    owner: Mapped[User] = relationship()


class Level(Base):
    """A level of model support (vision 8.1, plan E2.0); ``position`` only orders the display."""

    __tablename__ = "level"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(60))
    description: Mapped[str] = mapped_column(default="")
    system_prompt: Mapped[str] = mapped_column(default="")
    position: Mapped[int]
    selectable: Mapped[bool]
    is_default: Mapped[bool]

    permissions: Mapped[list[LevelPermission]] = relationship(cascade="all, delete-orphan")


class LevelPermission(Base):
    """One cell of a level's matrix: operation class by ``off`` / ``approve`` / ``auto``."""

    __tablename__ = "level_permission"

    level_id: Mapped[int] = mapped_column(
        ForeignKey("level.id", ondelete="CASCADE"), primary_key=True
    )
    op_class: Mapped[str] = mapped_column(String(16), primary_key=True)
    mode: Mapped[str] = mapped_column(String(16))


class LLMConnection(Base):
    """A model behind an OpenAI-compatible endpoint (F-3.2, plan E2.1, C4)."""

    __tablename__ = "llm_connection"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(60), unique=True)
    base_url: Mapped[str] = mapped_column(String(500))
    model: Mapped[str] = mapped_column(String(200))
    api_key: Mapped[str | None]
    """Fernet-encrypted with ``secret.key`` (C8); never sent back."""
    temperature: Mapped[float]
    seed: Mapped[int | None]
    timeout_s: Mapped[float]
    reasoning_effort: Mapped[str] = mapped_column(String(16))
    context_length: Mapped[int | None]
    """A declared budget for the profile size check, not sent anywhere (C11)."""
    enabled: Mapped[bool]
    """Offered to users; a disabled connection is usable by nobody (C14)."""
    is_default: Mapped[bool]
    may_receive_data: Mapped[bool]
    """Data release (C6): may receive data contents, not only metadata."""
    marked_external: Mapped[bool]
    """A local host the administrator treats as external (C5); never the reverse."""
    last_test: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    request_limit_enabled: Mapped[bool] = mapped_column(default=False, server_default=false())
    """Requests per day are capped for this connection, over all accounts (P5)."""
    request_limit_per_day: Mapped[int | None] = mapped_column(
        CheckConstraint(
            "NOT request_limit_enabled"
            " OR (request_limit_per_day IS NOT NULL AND request_limit_per_day > 0)",
            name="ck_llm_connection_request_limit",
        )
    )
    """The cap; required and positive while the limit is on."""
    created_at: Mapped[datetime] = mapped_column(server_default=func.current_timestamp())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.current_timestamp())


class ModelAction(Base):
    """One model request and what became of it: proposal and log entry at once
    (plan E2.3-E2.6, 1.2; F-6.8). Level and connection are kept as they were
    when asked (H7), not referenced, so a later edit or deletion changes no
    record. ``account`` is the username then, so the log outlives the account;
    ``user_id`` goes null with it and so can never match a later account."""

    __tablename__ = "model_action"
    __table_args__ = (
        Index("ix_model_action_user_id_created_at", "user_id", "created_at"),
        Index("ix_model_action_decision_created_at", "decision", "created_at"),
        Index("ix_model_action_connection_id_created_at", "connection_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("app_user.id", ondelete="SET NULL"))
    account: Mapped[str] = mapped_column(String(63))
    created_at: Mapped[datetime]
    """Naive UTC from the application's clock, like every time of the record, so
    a period filter means the same on every database."""
    proposal_only: Mapped[bool] = mapped_column(default=False, server_default=false())
    """The model may only propose (P1, D1); an overtaken record ends ``proposal_only``."""
    prompt: Mapped[str]
    prompt_hash: Mapped[str] = mapped_column(String(128))
    approach: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16))
    decision: Mapped[str | None] = mapped_column(String(16))
    decided_at: Mapped[datetime | None]
    reject_reason: Mapped[str | None] = mapped_column(String(16))
    applied_by_hand: Mapped[bool] = mapped_column(default=False, server_default=false())
    undone_at: Mapped[datetime | None]
    touched_at: Mapped[datetime | None]
    """When the client first reported a hand edit of the analysis after this
    applied action: from then on it cannot be undone (WP70)."""
    previewed_at: Mapped[datetime | None]
    parent_action_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_action.id", ondelete="SET NULL"), index=True
    )
    reference: Mapped[str] = mapped_column(String(16), default="none", server_default="none")
    follow_up_analysis: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    """The analysis a follow-up was sent with, as sent (P6): a comparison's
    repeat and a chain's re-plan ask with it again. Never part of a view."""
    compare_of: Mapped[int | None] = mapped_column(
        ForeignKey("model_action.id", ondelete="SET NULL")
    )
    level_id: Mapped[int]
    level_name: Mapped[str] = mapped_column(String(60))
    level_matrix: Mapped[dict[str, str]] = mapped_column(JSON)
    level_prompt_hash: Mapped[str] = mapped_column(String(128))
    connection_id: Mapped[int]
    connection_name: Mapped[str] = mapped_column(String(60))
    connection_model: Mapped[str] = mapped_column(String(200))
    connection_host: Mapped[str] = mapped_column(String(500))
    connection_locality: Mapped[str] = mapped_column(String(16))
    profile_hash: Mapped[str] = mapped_column(String(128))
    answer: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    query: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    applied_query: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    governance: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    refusal: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    stop_reason: Mapped[str | None] = mapped_column(String(32))
    replans: Mapped[int] = mapped_column(default=0, server_default="0")
    stamp: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    latency_ms: Mapped[int | None]
    prompt_tokens: Mapped[int | None]
    completion_tokens: Mapped[int | None]
    """As the endpoint reported them (bewertung.md 10): the direct query's
    call, a chain's planning call and its re-plans added up; ``None`` when the
    endpoint reported none. Never part of a view."""
    called_at: Mapped[datetime | None]
    """When the model call started; ``None`` for a request aborted before it.
    The request limit counts only requests that reached the call (P5)."""
    run_ms: Mapped[int] = mapped_column(default=0, server_default="0")
    """A chain's run time so far, its halts for approval left out (P4, WP75):
    with the planning call's ``latency_ms`` it is held to ``CHAIN_TIME_LIMIT_S``."""
    level_prompt: Mapped[str | None]
    """The level's system prompt as it was when asked (H7): a chain's re-plan
    asks with it, never with the level's text now (WP75). ``level_prompt_hash``
    is its hash."""
    turns: Mapped[list[Any] | None] = mapped_column(JSON)
    """A chain's conversation after the prompt, ``[role, text]`` each: the
    plans the model gave and every re-plan's input (P4, D9). The model's own
    words and ``model_view``s, nothing of the data."""


class ModelActionStep(Base):
    """One step of a chain (plan E2.3-E2.6, WP75): what the model planned, how
    the level governs it, and what became of it. A step's result is its query
    object and a count, never a table (F-9.5); only the adoptable step gets a
    stamp. ``position`` is stable: a removed step keeps its place, a re-plan's
    steps continue after the last step that ran."""

    __tablename__ = "model_action_step"
    __table_args__ = (UniqueConstraint("action_id", "position"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    action_id: Mapped[int] = mapped_column(ForeignKey("model_action.id", ondelete="CASCADE"))
    position: Mapped[int]
    text: Mapped[str]
    tool: Mapped[str] = mapped_column(String(64))
    arguments: Mapped[dict[str, Any]] = mapped_column(JSON)
    """As the model wrote them, or as the user changed their values (``edited``)."""
    classes: Mapped[list[str]] = mapped_column(JSON)
    cell: Mapped[str] = mapped_column(String(16))
    """The strictest cell among ``classes`` at the level as it was."""
    status: Mapped[str] = mapped_column(String(16))
    revised: Mapped[bool] = mapped_column(default=False, server_default=false())
    edited: Mapped[bool] = mapped_column(default=False, server_default=false())
    approved: Mapped[bool] = mapped_column(default=False, server_default=false())
    """An approval cleared it to run (``approve``), so the run does not halt before it."""
    count: Mapped[int | None]
    stamp: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    model_view: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    query: Mapped[dict[str, Any]] = mapped_column(JSON)
    duration_ms: Mapped[int | None]


class ModelCall(Base):
    """A chain's re-plan call (E2.5 gate, security review #43): the request
    limit (P5) counts it on the day it happened, beside the records whose
    first call reached the model (``ModelAction.called_at``)."""

    __tablename__ = "model_call"
    __table_args__ = (Index("ix_model_call_connection_id_called_at", "connection_id", "called_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    action_id: Mapped[int] = mapped_column(ForeignKey("model_action.id", ondelete="CASCADE"))
    connection_id: Mapped[int]
    called_at: Mapped[datetime]
    """Naive UTC from the application's clock, like the record's times."""


class OwnCase(Base):
    """An own case of the evaluation (plan E3, D2): authored, imported or taken
    from the log. The start set stays files (``schema/eval-cases``). ``body`` is
    the case as the case file writes it, without ``null`` fields; ``split``,
    ``origin`` and ``data_state`` repeat its fields for the list's filters."""

    __tablename__ = "eval_case"

    id: Mapped[int] = mapped_column(primary_key=True)
    case_id: Mapped[str] = mapped_column(String(63), unique=True)
    split: Mapped[str] = mapped_column(String(16), index=True)
    origin: Mapped[str] = mapped_column(String(16), index=True)
    data_state: Mapped[str] = mapped_column(String(16), index=True)
    body: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime]
    updated_at: Mapped[datetime]
    """Naive UTC from the application's clock."""


class AppMeta(Base):
    """Instance-wide facts fixed at first start, e.g. the internal CRS."""

    __tablename__ = "app_meta"

    key: Mapped[str] = mapped_column(String(63), primary_key=True)
    value: Mapped[str]
