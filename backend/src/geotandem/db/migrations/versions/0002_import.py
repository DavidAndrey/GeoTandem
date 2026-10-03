"""import log, model flags, attribute references (E1.3)

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-03 10:40:00.000000

Columns are added and dropped with plain ALTER TABLE (SQLite >= 3.35), not
batch mode: recreating ``layer`` would cascade-delete its attributes.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "layer", sa.Column("for_model", sa.Boolean(), server_default=sa.true(), nullable=False)
    )
    op.add_column("layer", sa.Column("updated_at", sa.DateTime(), nullable=True))
    op.execute("UPDATE layer SET updated_at = created_at")
    op.add_column(
        "layer_attribute",
        sa.Column("for_model", sa.Boolean(), server_default=sa.true(), nullable=False),
    )
    op.add_column("layer_attribute", sa.Column("references", sa.String(length=127), nullable=True))
    op.create_table(
        "import_run",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("actor", sa.String(length=63), nullable=True),
        sa.Column("source_name", sa.String(), nullable=False),
        sa.Column("source_format", sa.String(length=16), nullable=False),
        sa.Column("layer_name", sa.String(length=63), nullable=True),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("read_count", sa.Integer(), nullable=False),
        sa.Column("imported_count", sa.Integer(), nullable=False),
        sa.Column("rejected_count", sa.Integer(), nullable=False),
        sa.Column("decisions", sa.JSON(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("errors", sa.JSON(), nullable=False),
        sa.Column("steps", sa.JSON(), nullable=False),
        sa.Column("rejected_sample", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_import_run_started_at", "import_run", ["started_at"])


def downgrade() -> None:
    op.drop_index("ix_import_run_started_at", table_name="import_run")
    op.drop_table("import_run")
    op.drop_column("layer_attribute", "references")
    op.drop_column("layer_attribute", "for_model")
    op.drop_column("layer", "updated_at")
    op.drop_column("layer", "for_model")
