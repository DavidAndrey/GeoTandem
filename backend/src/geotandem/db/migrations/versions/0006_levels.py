"""levels of model support (E2.0)

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-07 12:00:00.000000

Seeds the shipped levels (plan E2.0, H8): Assistenz (all off), Prüfen (all
approve, the default) and Automatisch (all auto, not selectable), so out of
the box nothing runs unseen. Existing accounts get no choice and so work on
the default.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CLASSES = ("catalog", "query", "spatial", "derive", "display")

_BASE = (
    "Du bist der Analyseassistent von GeoTandem. Du beantwortest Fragen zu den "
    "Geodaten, die der Layer-Steckbrief beschreibt, ausschliesslich mit "
    "Abfrageobjekten und den bereitgestellten Werkzeugen. Du schreibst weder SQL "
    "noch Programmcode. Du kennst nur die Metadaten der Layer, nicht ihre Inhalte: "
    "Erfinde keine Layer, Attribute oder Werte. Nenne die Annahmen, die du "
    "triffst, und frage nach, wenn eine Frage mehrdeutig ist."
)

LEVELS = [
    {
        "name": "Assistenz",
        "description": "Das Modell erklärt und schlägt Abfragen vor; ausgeführt wird "
        "nur, was der Anwender selbst übernimmt.",
        "system_prompt": _BASE + "\n\nAuf dieser Stufe führst du nichts aus. Erkläre, "
        "wie sich die Frage beantworten lässt, und schlage ein Abfrageobjekt vor, das "
        "der Anwender selbst übernehmen kann.",
        "position": 0,
        "selectable": True,
        "is_default": False,
        "mode": "off",
    },
    {
        "name": "Prüfen",
        "description": "Jede Abfrage des Modells wird vor der Ausführung zur Freigabe gezeigt.",
        "system_prompt": _BASE + "\n\nAuf dieser Stufe prüft der Anwender jede Abfrage, "
        "bevor sie läuft. Beschreibe knapp, was sie tut, damit er sie beurteilen kann.",
        "position": 1,
        "selectable": True,
        "is_default": True,
        "mode": "approve",
    },
    {
        "name": "Automatisch",
        "description": "Abfragen des Modells laufen sofort; die Änderung ist sichtbar "
        "und lässt sich zurücknehmen.",
        "system_prompt": _BASE + "\n\nAuf dieser Stufe laufen deine Abfragen ohne "
        "Rückfrage; der Anwender sieht die Änderung und kann sie zurücknehmen. Wähle "
        "die einfachste Abfrage, die die Frage beantwortet.",
        "position": 2,
        "selectable": False,
        "is_default": False,
        "mode": "auto",
    },
]


def upgrade() -> None:
    level = op.create_table(
        "level",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("system_prompt", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("selectable", sa.Boolean(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "level_permission",
        sa.Column("level_id", sa.Integer(), nullable=False),
        sa.Column("op_class", sa.String(length=16), nullable=False),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.ForeignKeyConstraint(["level_id"], ["level.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("level_id", "op_class"),
    )
    with op.batch_alter_table("app_user") as batch:
        batch.add_column(sa.Column("level_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_app_user_level_id", "level", ["level_id"], ["id"], ondelete="SET NULL"
        )

    # Ids come from the database, so PostgreSQL's sequence stays in step (P track).
    op.bulk_insert(level, [{k: v for k, v in row.items() if k != "mode"} for row in LEVELS])
    for row in LEVELS:
        for op_class in CLASSES:
            op.execute(
                sa.text(
                    "INSERT INTO level_permission (level_id, op_class, mode)"
                    " SELECT id, :op_class, :mode FROM level WHERE name = :name"
                ).bindparams(op_class=op_class, mode=row["mode"], name=row["name"])
            )


def downgrade() -> None:
    with op.batch_alter_table("app_user") as batch:
        batch.drop_constraint("fk_app_user_level_id", type_="foreignkey")
        batch.drop_column("level_id")
    op.drop_table("level_permission")
    op.drop_table("level")
