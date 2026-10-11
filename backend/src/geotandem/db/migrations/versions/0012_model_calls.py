"""the re-plan calls of a tool chain, for the request limit (E2.5)

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-11 18:00:00.000000

The connection's request limit (plan E2.3-E2.6, P5) counts every model call
on the day it happens (E2.5 gate, security review #43): a prompt's call is
its record (``model_action.called_at``); a chain's re-plan is one row here,
with the connection it went to and when. Rows go with their action. Existing
chains made their re-plans before this was counted: none is added.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "model_call",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("action_id", sa.Integer(), nullable=False),
        sa.Column("connection_id", sa.Integer(), nullable=False),
        sa.Column("called_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["action_id"], ["model_action.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_model_call_connection_id_called_at", "model_call", ["connection_id", "called_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_model_call_connection_id_called_at", table_name="model_call")
    op.drop_table("model_call")
