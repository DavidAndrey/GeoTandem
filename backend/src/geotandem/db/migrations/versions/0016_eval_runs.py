"""placeholder for the evaluation runs (E3, WP90)

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-25 09:00:00.000000

Empty on the branch of WP91, which builds 0017 on it while WP90 writes the
real 0016 (``eval_run``, ``eval_answer``) in parallel; the integrator takes
WP90's file at the merge (plan E3, 3).
"""

from collections.abc import Sequence

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
