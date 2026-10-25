"""evaluation runs and their answers (E3)

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-25 10:00:00.000000

The runs of the evaluation (plan E3, D7, D8, WP90): one row per run with the
request as V4 composed it, its label (F-3.18), the cases as it asked them
(H7), its measuring points with their figures once done, and its progress;
one row per answer of one repeat, with the grading fields of ``AnswerView``,
latency and tokens. A run is a measurement, not use: nothing here is a model
action, and no row holds a key or a row of the data.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "eval_run",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("scope", sa.String(length=16), nullable=False),
        sa.Column("data_state", sa.String(length=16), nullable=False),
        sa.Column("request", sa.JSON(), nullable=False),
        sa.Column("label", sa.JSON(), nullable=False),
        sa.Column("cases", sa.JSON(), nullable=False),
        sa.Column("points", sa.JSON(), nullable=False),
        sa.Column("prices", sa.JSON(), nullable=False),
        sa.Column("connection_ids", sa.String(length=200), nullable=False),
        sa.Column("case_set_hash", sa.String(length=80), nullable=False),
        sa.Column("reference", sa.Integer(), nullable=False),
        sa.Column("progress_done", sa.Integer(), server_default="0", nullable=False),
        sa.Column("progress_total", sa.Integer(), nullable=False),
        sa.Column("error", sa.String(length=64), nullable=True),
        sa.Column("started_by", sa.String(length=63), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_eval_run_status", "eval_run", ["status"])
    op.create_table(
        "eval_answer",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.Integer(), nullable=False),
        sa.Column("case_id", sa.String(length=63), nullable=False),
        sa.Column("point", sa.Integer(), nullable=False),
        sa.Column("connection_id", sa.Integer(), nullable=False),
        sa.Column("block", sa.Integer(), nullable=False),
        sa.Column("seed", sa.Integer(), nullable=False),
        sa.Column("verdict", sa.String(length=16), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=True),
        sa.Column("flags", sa.JSON(), nullable=False),
        sa.Column("silently_wrong", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("answer", sa.JSON(), nullable=True),
        sa.Column("refusal", sa.JSON(), nullable=True),
        sa.Column("raw", sa.String(), nullable=True),
        sa.Column("reading", sa.Integer(), nullable=True),
        sa.Column("diff", sa.JSON(), nullable=True),
        sa.Column("hits", sa.Integer(), nullable=True),
        sa.Column("reference_hits", sa.Integer(), nullable=True),
        sa.Column("only_answer", sa.JSON(), nullable=False),
        sa.Column("only_answer_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("only_reference", sa.JSON(), nullable=False),
        sa.Column("only_reference_count", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["eval_run.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "case_id", "point", "seed"),
    )
    op.create_index("ix_eval_answer_connection_id", "eval_answer", ["connection_id"])


def downgrade() -> None:
    op.drop_index("ix_eval_answer_connection_id", table_name="eval_answer")
    op.drop_table("eval_answer")
    op.drop_index("ix_eval_run_status", table_name="eval_run")
    op.drop_table("eval_run")
