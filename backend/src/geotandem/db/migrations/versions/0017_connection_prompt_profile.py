"""prompt profile and prices of a model connection (E3)

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-25 10:00:00.000000

The prompt profile of a connection (plan E3, D9, WP91): how the direct
query's prompt is written, as JSON; every existing connection gets today's
prompt. Optional prices per million input and output tokens with their
currency (O4, D12): all three or none, none for every existing connection.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFAULT_PROMPT_PROFILE = '{"examples": "standard", "placement": "P0", "output": "constrained"}'


def upgrade() -> None:
    op.add_column(
        "llm_connection",
        sa.Column(
            "prompt_profile", sa.JSON(), server_default=DEFAULT_PROMPT_PROFILE, nullable=False
        ),
    )
    op.add_column("llm_connection", sa.Column("price_input_per_mtok", sa.Float(), nullable=True))
    op.add_column("llm_connection", sa.Column("price_output_per_mtok", sa.Float(), nullable=True))
    # As 0009's request limit: a column constraint may name the other columns.
    op.execute(
        "ALTER TABLE llm_connection ADD COLUMN price_currency VARCHAR(3)"
        " CONSTRAINT ck_llm_connection_price CHECK ((price_input_per_mtok IS NULL"
        " AND price_output_per_mtok IS NULL AND price_currency IS NULL)"
        " OR (price_input_per_mtok IS NOT NULL AND price_output_per_mtok IS NOT NULL"
        " AND price_currency IS NOT NULL))"
    )


def downgrade() -> None:
    # The constraint belongs to price_currency and goes with it, first.
    op.drop_column("llm_connection", "price_currency")
    op.drop_column("llm_connection", "price_output_per_mtok")
    op.drop_column("llm_connection", "price_input_per_mtok")
    op.drop_column("llm_connection", "prompt_profile")
