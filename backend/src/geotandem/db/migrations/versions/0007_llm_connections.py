"""model connections (E2.1)

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-08 10:00:00.000000

A new table and a nullable column; existing data is untouched. No
connection is seeded: a fresh install cannot know a model's address (C18).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "llm_connection",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("base_url", sa.String(length=500), nullable=False),
        sa.Column("model", sa.String(length=200), nullable=False),
        sa.Column("api_key", sa.String(), nullable=True),
        sa.Column("temperature", sa.Float(), nullable=False),
        sa.Column("seed", sa.Integer(), nullable=True),
        sa.Column("timeout_s", sa.Float(), nullable=False),
        sa.Column("reasoning_effort", sa.String(length=16), nullable=False),
        sa.Column("context_length", sa.Integer(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("may_receive_data", sa.Boolean(), nullable=False),
        sa.Column("marked_external", sa.Boolean(), nullable=False),
        sa.Column("last_test", sa.JSON(), nullable=True),
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
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    with op.batch_alter_table("app_user") as batch:
        batch.add_column(sa.Column("llm_connection_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_app_user_llm_connection_id",
            "llm_connection",
            ["llm_connection_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("app_user") as batch:
        batch.drop_constraint("fk_app_user_llm_connection_id", type_="foreignkey")
        batch.drop_column("llm_connection_id")
    op.drop_table("llm_connection")
