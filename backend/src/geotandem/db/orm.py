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
AttributeType = Literal["integer", "real", "text", "boolean"]


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


class AppMeta(Base):
    """Instance-wide facts fixed at first start, e.g. the internal CRS."""

    __tablename__ = "app_meta"

    key: Mapped[str] = mapped_column(String(63), primary_key=True)
    value: Mapped[str]
