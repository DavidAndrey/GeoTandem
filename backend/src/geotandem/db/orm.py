"""Administrative schema with a fixed structure (tech-stack 3.3).

Layer tables themselves are data, created dynamically by the data-access
layer, and are not part of this metadata or of the Alembic migrations.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from sqlalchemy import JSON, ForeignKey, String, UniqueConstraint, func, true
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


class AppMeta(Base):
    """Instance-wide facts fixed at first start, e.g. the internal CRS."""

    __tablename__ = "app_meta"

    key: Mapped[str] = mapped_column(String(63), primary_key=True)
    value: Mapped[str]
