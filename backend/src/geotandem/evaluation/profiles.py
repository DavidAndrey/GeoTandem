"""Metadata ablation for the layer profile (docs/testplan-system-context.md, Phase 4).

A mode strips part of the sample data's curated metadata before the profile is
built, so the model sees the layers as a less curated import would leave them.
It edits the catalog rows, not the profile: ``model_profile`` and the code
reading of E-2 (``labels.py``, from the profile's codes) work as in production.
The rows only describe; the data and the checks do not read them.

The modes of docs/plan-attribute-metadata.md (A2) ask about units, references
and an identifier role. ``role`` has no catalog column yet, so ``refs-role``
sets it on the built profile (``ROLES``, ``model_profile_for``) and seals it
again; everything else stays a row edit.

The harness takes a mode with ``--profile`` (``evals/run.py``, ``regrade.py``),
the tests of the profile summary (WP94) take every mode from here:

    uv run python evals/run.py --model gemma4:12b --profile no-desc --label a1-gemma4_12b
"""

from collections.abc import Callable, Collection

from sqlalchemy import Engine, select, update
from sqlalchemy.orm import Session

from geotandem.catalog import ModelProfile, model_profile, seal
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


def _no_units(db: Session) -> None:
    """No units; the sample's labels name none either («Fläche», «Länge im Gebiet»),
    so only the column name (``flaeche_km2``) still carries one."""
    db.execute(update(LayerAttribute).values(unit=None))


KEYS = {
    ("gemeinden", "gem_nr"): ("BFS-Gemeindenummer.", None),
    ("schulen", "gem_nr"): ("Schulgemeinde.", "gemeinden.gem_nr"),
    ("gemeindedaten", "gem_nr"): ("", "gemeinden.gem_nr"),
}
"""The sample's keys: (description without the join, reference). Today the joins
are prose only («Schlüssel auf gemeinden.gem_nr»), which led qwen3:14b to
``gem_nr = 1`` (testplan-system-context 8.5, point 4)."""


def _refs(db: Session) -> None:
    """The joins as ``references`` instead of prose in the descriptions."""
    for (layer, name), (description, references) in KEYS.items():
        row = db.scalar(
            select(LayerAttribute)
            .join(Layer)
            .where(Layer.name == layer, LayerAttribute.name == name)
        )
        assert row is not None, f"{layer}.{name} is not in the sample"
        row.description = description
        row.references = references


ROLES: dict[str, set[tuple[str, str]]] = {"refs-role": set(KEYS)}
"""Per mode, the attributes the profile marks ``role: identifier``."""


PROFILES: dict[str, Callable[[Session], None] | None] = {
    "full": None,
    "no-desc": _no_desc,
    "no-labels": _no_labels,
    "no-domains": _no_domains,
    "raw": _raw,
    "raw-codes": _raw_codes,
    "no-units": _no_units,
    "refs": _refs,
    "refs-role": _refs,
}


def strip(engine: Engine, mode: str) -> None:
    """Apply ``mode`` to the catalog of ``engine``; ``full`` leaves it as loaded."""
    if (apply := PROFILES[mode]) is None:
        return
    with Session(engine) as db, db.begin():
        apply(db)


def model_profile_for(engine: Engine, visible: Collection[str], mode: str) -> ModelProfile:
    """``catalog.model_profile`` of a catalog stripped by ``mode``, with the roles
    of ``ROLES`` set; the same profile as ``model_profile`` for any other mode."""
    found = model_profile(engine, visible)
    marked = ROLES.get(mode)
    if not marked:
        return found
    for layer in found.layers:
        for a in layer.attributes:
            if (layer.name, a.name) in marked:
                a.role = "identifier"
    return seal(found.layers)
