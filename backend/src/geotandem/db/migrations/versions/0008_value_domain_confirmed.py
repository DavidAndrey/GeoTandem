"""confirmed value domains (E2.2)

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-08 14:00:00.000000

A value domain proposed by an import comes from the rows: a code list is
the column's distinct values, a range its minimum and maximum. It reaches
the model only once an administrator confirms it (plan E2.2, S2). Imported
domains so far were never confirmed and start unconfirmed; the sample's
come from its curated metadata and count as confirmed.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("layer_attribute") as batch:
        batch.add_column(
            sa.Column(
                "value_domain_confirmed", sa.Boolean(), server_default=sa.true(), nullable=False
            )
        )
    op.execute(
        "UPDATE layer_attribute SET value_domain_confirmed = false"
        " WHERE value_domain IS NOT NULL AND CAST(value_domain AS TEXT) != 'null'"
        " AND layer_id IN"
        " (SELECT id FROM layer WHERE source NOT LIKE 'sample:%')"
    )


def downgrade() -> None:
    with op.batch_alter_table("layer_attribute") as batch:
        batch.drop_column("value_domain_confirmed")
