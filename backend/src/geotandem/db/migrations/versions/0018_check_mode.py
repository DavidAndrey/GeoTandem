"""the chain checks the direct query (plan-check-mode)

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-29 10:00:00.000000

A connection's check mode (D1): ``off`` for every existing connection. A
model action may be a check, a repeat the application asked by itself
(``compare_of``), and a checked direct answer keeps what its check found;
every existing record is no check and unchecked.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "llm_connection",
        sa.Column("check_mode", sa.String(8), server_default="off", nullable=False),
    )
    op.add_column(
        "model_action",
        sa.Column("is_check", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column("model_action", sa.Column("check_result", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("model_action", "check_result")
    op.drop_column("model_action", "is_check")
    op.drop_column("llm_connection", "check_mode")
