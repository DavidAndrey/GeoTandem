"""a follow-up's analysis as sent (E2.6)

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-23 18:00:00.000000

The analysis a follow-up was sent with (plan E2.3-E2.6, P6, WP81): a
comparison's repeat and a chain's re-plan ask with it again, so they answer
the same question (E2.6 gate review). Existing records were asked before
WP81 sent one, or kept none.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("model_action") as batch:
        batch.add_column(sa.Column("follow_up_analysis", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("model_action") as batch:
        batch.drop_column("follow_up_analysis")
