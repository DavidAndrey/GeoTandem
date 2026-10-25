"""the tokens of a model action (E3)

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-24 12:00:00.000000

The tokens the endpoint reported for a model action (plan E3, WP86;
bewertung.md 10): the direct query's call, and for a chain its planning call
with every re-plan added. Latency was stored, tokens were only logged.
Existing records were asked before they were kept, or the endpoint reported
none: both stay null.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("model_action") as batch:
        batch.add_column(sa.Column("prompt_tokens", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("completion_tokens", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("model_action") as batch:
        batch.drop_column("completion_tokens")
        batch.drop_column("prompt_tokens")
