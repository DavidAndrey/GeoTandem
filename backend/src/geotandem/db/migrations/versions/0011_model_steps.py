"""the steps of a tool chain (E2.5)

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-11 10:00:00.000000

A chain's steps, one row each (plan E2.3-E2.6, WP75): what the model planned
(text, tool, arguments), how the level as it was governs the step (classes,
cell, and whether an approval cleared it), and what became of it (status,
the count for the user, ``model_view`` for the model, the step's query
object, its duration; a stamp for the adoptable step only). Rows go with
their action. And two columns of the action: a chain's run time so far,
halts left out, and its conversation with the model after the prompt.
Existing records are direct queries: no steps, no run time.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "model_action_step",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("action_id", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("text", sa.String(), nullable=False),
        sa.Column("tool", sa.String(length=64), nullable=False),
        sa.Column("arguments", sa.JSON(), nullable=False),
        sa.Column("classes", sa.JSON(), nullable=False),
        sa.Column("cell", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("revised", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("edited", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("approved", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("count", sa.Integer(), nullable=True),
        sa.Column("stamp", sa.JSON(), nullable=True),
        sa.Column("model_view", sa.JSON(), nullable=True),
        sa.Column("query", sa.JSON(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["action_id"], ["model_action.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("action_id", "position"),
    )
    with op.batch_alter_table("model_action") as batch:
        batch.add_column(sa.Column("run_ms", sa.Integer(), server_default="0", nullable=False))
        batch.add_column(sa.Column("turns", sa.JSON(), nullable=True))


def downgrade() -> None:
    # The steps first: a rebuild of model_action then has no rows referring to it.
    op.drop_table("model_action_step")
    with op.batch_alter_table("model_action") as batch:
        batch.drop_column("turns")
        batch.drop_column("run_ms")
