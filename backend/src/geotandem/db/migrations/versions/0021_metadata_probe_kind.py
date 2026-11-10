"""the kind of a metadata call: probe or proposal (plan-attribute-metadata D)

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-08 09:00:00.000000

The proposals of missing labels and descriptions are the same kind of call as
the comprehension probe and are kept in the same table; ``kind`` tells them
apart. Rows before it are probes.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("metadata_probe") as batch:
        batch.add_column(
            sa.Column("kind", sa.String(length=16), nullable=False, server_default="probe")
        )


def downgrade() -> None:
    with op.batch_alter_table("metadata_probe") as batch:
        batch.drop_column("kind")
