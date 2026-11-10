"""the comprehension probe of a layer (plan-attribute-metadata C, Q5)

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-07 16:00:00.000000

Its own entry, not a model action: who probed which layer over which
connection, and the tokens. The request limit counts it.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "metadata_probe",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("account", sa.String(length=63), nullable=False),
        sa.Column("connection_id", sa.Integer(), nullable=False),
        sa.Column("layer", sa.String(length=63), nullable=False),
        sa.Column("called_at", sa.DateTime(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("error_code", sa.String(length=63), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["app_user.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_metadata_probe_connection_id_called_at",
        "metadata_probe",
        ["connection_id", "called_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_metadata_probe_connection_id_called_at", table_name="metadata_probe")
    op.drop_table("metadata_probe")
