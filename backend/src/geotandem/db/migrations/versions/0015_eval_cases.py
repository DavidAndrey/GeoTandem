"""own cases of the evaluation (E3)

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-24 14:00:00.000000

The administrator's own cases (plan E3, D2, WP87): authored, imported or
taken from the log. The start set stays the files of ``schema/eval-cases``
and is never stored here. One row per case, its body as the case file
writes it; split, origin and data state beside it for the list's filters.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

COLUMNS = ("split", "origin", "data_state")
"""The list's filters, each with its index."""


def upgrade() -> None:
    op.create_table(
        "eval_case",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("case_id", sa.String(length=63), nullable=False),
        sa.Column("split", sa.String(length=16), nullable=False),
        sa.Column("origin", sa.String(length=16), nullable=False),
        sa.Column("data_state", sa.String(length=16), nullable=False),
        sa.Column("body", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("case_id"),
    )
    for column in COLUMNS:
        op.create_index(f"ix_eval_case_{column}", "eval_case", [column])


def downgrade() -> None:
    for column in COLUMNS:
        op.drop_index(f"ix_eval_case_{column}", table_name="eval_case")
    op.drop_table("eval_case")
