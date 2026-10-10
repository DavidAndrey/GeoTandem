"""model actions and the request limit (E2.3, E2.4)

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-10 12:00:00.000000

A new table, the action record (plan E2.3-E2.6, 1.2, WP63): proposal and log
of every model request, with level and connection as they were (H7). And two
columns on ``llm_connection`` for the request limit an administrator may set
per connection (P5); existing connections start without a limit.

The limit's check constraint is part of the column definition, so it is added
with the column: SQLite cannot add a constraint to an existing table without
recreating it, and this way ``llm_connection`` needs no rebuild.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "model_action",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("account", sa.String(length=63), nullable=False),
        # Written by the application in naive UTC, never by the database's clock.
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("proposal_only", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("prompt", sa.String(), nullable=False),
        sa.Column("prompt_hash", sa.String(length=128), nullable=False),
        sa.Column("approach", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("decision", sa.String(length=16), nullable=True),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column("reject_reason", sa.String(length=16), nullable=True),
        sa.Column("applied_by_hand", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("undone_at", sa.DateTime(), nullable=True),
        # A hand edit of the analysis reported after the action: undo is over (WP70).
        sa.Column("touched_at", sa.DateTime(), nullable=True),
        sa.Column("previewed_at", sa.DateTime(), nullable=True),
        sa.Column("parent_action_id", sa.Integer(), nullable=True),
        sa.Column("reference", sa.String(length=16), server_default="none", nullable=False),
        sa.Column("compare_of", sa.Integer(), nullable=True),
        sa.Column("level_id", sa.Integer(), nullable=False),
        sa.Column("level_name", sa.String(length=60), nullable=False),
        sa.Column("level_matrix", sa.JSON(), nullable=False),
        sa.Column("level_prompt_hash", sa.String(length=128), nullable=False),
        sa.Column("connection_id", sa.Integer(), nullable=False),
        sa.Column("connection_name", sa.String(length=60), nullable=False),
        sa.Column("connection_model", sa.String(length=200), nullable=False),
        sa.Column("connection_host", sa.String(length=500), nullable=False),
        sa.Column("connection_locality", sa.String(length=16), nullable=False),
        sa.Column("profile_hash", sa.String(length=128), nullable=False),
        sa.Column("answer", sa.JSON(), nullable=True),
        sa.Column("query", sa.JSON(), nullable=True),
        sa.Column("applied_query", sa.JSON(), nullable=True),
        sa.Column("governance", sa.JSON(), nullable=True),
        sa.Column("refusal", sa.JSON(), nullable=True),
        sa.Column("error", sa.JSON(), nullable=True),
        sa.Column("stop_reason", sa.String(length=32), nullable=True),
        sa.Column("replans", sa.Integer(), server_default="0", nullable=False),
        sa.Column("stamp", sa.JSON(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        # When the model call started; the request limit counts only those (P5).
        sa.Column("called_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["app_user.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["parent_action_id"], ["model_action.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["compare_of"], ["model_action.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_model_action_user_id_created_at", "model_action", ["user_id", "created_at"])
    op.create_index(
        "ix_model_action_decision_created_at", "model_action", ["decision", "created_at"]
    )
    op.create_index("ix_model_action_parent_action_id", "model_action", ["parent_action_id"])
    # The request limit counts a connection's requests per day (P5).
    op.create_index(
        "ix_model_action_connection_id_created_at", "model_action", ["connection_id", "created_at"]
    )

    op.add_column(
        "llm_connection",
        sa.Column("request_limit_enabled", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    # Same words on SQLite and PostgreSQL; a column constraint may name another column.
    op.execute(
        "ALTER TABLE llm_connection ADD COLUMN request_limit_per_day INTEGER"
        " CONSTRAINT ck_llm_connection_request_limit CHECK (NOT request_limit_enabled"
        " OR (request_limit_per_day IS NOT NULL AND request_limit_per_day > 0))"
    )


def downgrade() -> None:
    # The constraint belongs to request_limit_per_day and goes with it, first.
    op.drop_column("llm_connection", "request_limit_per_day")
    op.drop_column("llm_connection", "request_limit_enabled")
    op.drop_index("ix_model_action_connection_id_created_at", table_name="model_action")
    op.drop_index("ix_model_action_parent_action_id", table_name="model_action")
    op.drop_index("ix_model_action_decision_created_at", table_name="model_action")
    op.drop_index("ix_model_action_user_id_created_at", table_name="model_action")
    op.drop_table("model_action")
