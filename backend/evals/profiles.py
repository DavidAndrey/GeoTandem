"""Metadata ablation for the layer profile (docs/testplan-system-context.md, Phase 4).

A mode strips part of the sample data's curated metadata before the profile is
built, so the model sees the layers as a less curated import would leave them.
It edits the catalog rows, not the profile: ``model_profile`` and the code
reading of E-2 (``labels.py``, from the profile's codes) work as in production.
The rows only describe; the data and the checks do not read them.

    uv run python evals/run.py --model gemma4:12b --profile no-desc --label a1-gemma4_12b
"""

from collections.abc import Callable

from sqlalchemy import Engine, select, update
from sqlalchemy.orm import Session

from geotandem.db.orm import Layer, LayerAttribute


def _no_desc(db: Session) -> None:
    """No layer or attribute descriptions."""
    db.execute(update(Layer).values(description=""))
    db.execute(update(LayerAttribute).values(description=""))


def _no_labels(db: Session) -> None:
    """Attributes named only by their column name; layer titles stay."""
    db.execute(update(LayerAttribute).values(label=""))


def _no_domains(db: Session) -> None:
    """No code lists and no ranges: as a proposed domain left unconfirmed (S2)."""
    db.execute(update(LayerAttribute).values(value_domain_confirmed=False))


def _raw(db: Session) -> None:
    """As a plain import leaves it: all of the above, no units, title = name."""
    _no_desc(db)
    _no_labels(db)
    _no_domains(db)
    db.execute(update(LayerAttribute).values(unit=None))
    db.execute(update(Layer).values(title=Layer.name))


def _raw_codes(db: Session) -> None:
    """``raw``, but the proposed domains confirmed as an import proposes them: a
    code list names each code by itself (``propose_value_domain``), ranges stay."""
    _raw(db)
    for row in db.scalars(select(LayerAttribute).where(LayerAttribute.value_domain.is_not(None))):
        domain = dict(row.value_domain or {})
        if "codes" in domain:
            domain["codes"] = {code: code for code in domain["codes"]}
        row.value_domain = domain
        row.value_domain_confirmed = True


PROFILES: dict[str, Callable[[Session], None] | None] = {
    "full": None,
    "no-desc": _no_desc,
    "no-labels": _no_labels,
    "no-domains": _no_domains,
    "raw": _raw,
    "raw-codes": _raw_codes,
}


def strip(engine: Engine, mode: str) -> None:
    """Apply ``mode`` to the catalog of ``engine``; ``full`` leaves it as loaded."""
    if (apply := PROFILES[mode]) is None:
        return
    with Session(engine) as db, db.begin():
        apply(db)
