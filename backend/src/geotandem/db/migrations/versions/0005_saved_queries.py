"""saved and shared queries (E1.7b)

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-03 20:00:00.000000

A new table only; existing data is untouched.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "saved_query",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("shared", sa.Boolean(), nullable=False),
        sa.Column("state_version", sa.Integer(), nullable=False),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("query", sa.JSON(), nullable=False),
        sa.Column("layers", sa.JSON(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["app_user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", "name"),
    )


def downgrade() -> None:
    op.drop_table("saved_query")
