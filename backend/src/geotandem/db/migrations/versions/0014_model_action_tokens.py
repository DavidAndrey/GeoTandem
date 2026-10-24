"""placeholder for WP86's model action tokens (E3)

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-24 12:00:00.000000

WP87 was built beside WP86, which owns this revision (plan E3, section 3);
this empty revision only lets 0015 name it. On merge WP86's file replaces it.
"""

from collections.abc import Sequence

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
