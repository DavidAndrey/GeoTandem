"""the examples a model action or a run's answer was given (plan-improve-examples 5, D7)

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-06 10:00:00.000000

The ids of the verified cases a prompt with the profile ``eigene`` was given
as examples; every existing record and answer was given none chosen (``NULL``).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("model_action", sa.Column("examples", sa.JSON(), nullable=True))
    op.add_column("eval_answer", sa.Column("examples", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("eval_answer", "examples")
    op.drop_column("model_action", "examples")
