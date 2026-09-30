"""admin schema

Revision ID: 0001
Revises:
Create Date: 2026-09-30 18:27:01.294401
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "app_meta",
        sa.Column("key", sa.String(length=63), nullable=False),
        sa.Column("value", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "layer",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=63), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("geometry_type", sa.String(length=32), nullable=True),
        sa.Column("srid", sa.Integer(), nullable=True),
        sa.Column("feature_count", sa.Integer(), nullable=False),
        sa.Column("bbox_wgs84", sa.JSON(), nullable=True),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("dataset_version", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "layer_attribute",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("layer_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=63), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("data_type", sa.String(length=16), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("unit", sa.String(), nullable=True),
        sa.Column("value_domain", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["layer_id"], ["layer.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("layer_id", "name"),
    )


def downgrade() -> None:
    op.drop_table("layer_attribute")
    op.drop_table("layer")
    op.drop_table("app_meta")
