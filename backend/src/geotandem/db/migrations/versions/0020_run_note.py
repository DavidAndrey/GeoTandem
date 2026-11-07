"""a run's note: a few words to tell it apart in the list

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-07 12:00:00.000000

Every existing run starts without one (``''``).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("eval_run", sa.Column("note", sa.String(200), server_default="", nullable=False))


def downgrade() -> None:
    op.drop_column("eval_run", "note")
