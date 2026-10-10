"""hand edit after a model action (E2.4)

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-10 20:00:00.000000

When the client first reported a hand edit of the analysis after an applied
model action (plan E2.3-E2.6, WP70): from then on the action cannot be
undone (``undo_blocked``). Existing records were never reported touched.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("model_action") as batch:
        batch.add_column(sa.Column("touched_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("model_action") as batch:
        batch.drop_column("touched_at")
