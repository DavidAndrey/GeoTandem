"""The layer registry (F-2.7, F-2.8) as API-ready models, and its curation."""

import hashlib
import json
import math
from collections.abc import Collection
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, selectinload

from geotandem.db.orm import Layer, LayerAttribute
from geotandem.db.spatialite import reading


class AttributeInfo(BaseModel):
    name: str
    data_type: Literal["integer", "real", "text", "boolean", "date"]
    label: str
    description: str
    unit: str | None
    value_domain: dict[str, Any] | None
    value_domain_confirmed: bool
    """False: proposed from the data at import, not yet confirmed; the model does not
    see it (plan E2.2, S2). Saving the attribute's value domain confirms it."""
    for_model: bool
    references: str | None


class LayerInfo(BaseModel):
    name: str
    title: str
    description: str
    kind: Literal["vector", "table"]
    geometry_type: str | None
    feature_count: int
    bbox_wgs84: list[float] | None
    source: str | None
    """Where the layer came from, e.g. ``file:<uploaded name>``; for administrators only,
    ``None`` for anyone else (security review #20)."""
    dataset_version: str | None
    for_model: bool
    created_at: datetime
    updated_at: datetime | None
    attributes: list[AttributeInfo]


def _info(layer: Layer) -> LayerInfo:
    return LayerInfo.model_validate(
        {
            **{k: getattr(layer, k) for k in LayerInfo.model_fields if k != "attributes"},
            "attributes": [
                AttributeInfo.model_validate(a, from_attributes=True) for a in layer.attributes
            ],
        }
    )


def list_layers(engine: Engine, only: Collection[str] | None = None) -> list[LayerInfo]:
    """All layers, or those named in ``only`` (the layers an account may see)."""
    stmt = select(Layer).options(selectinload(Layer.attributes)).order_by(Layer.name)
    if only is not None:
        stmt = stmt.where(Layer.name.in_(list(only)))
    with Session(reading(engine)) as session:
        return [_info(layer) for layer in session.scalars(stmt)]


def get_layer(engine: Engine, name: str) -> LayerInfo | None:
    with Session(reading(engine)) as session:
        layer = session.scalar(
            select(Layer).options(selectinload(Layer.attributes)).where(Layer.name == name)
        )
        return _info(layer) if layer else None


# --- curation (F-2.7 "Umbenennen", F-2.8) -------------------------------------

# Every user receives these with each layer list, and the model with each layer
# profile: bounded, so one edit cannot make them megabytes (security review #19).
MAX_TITLE = 200
"""Layer titles and attribute labels."""
MAX_DESCRIPTION = 5000
MAX_UNIT = 50
MAX_CODES = 500
"""Entries of a code list."""
MAX_CODE = 500
"""Characters of one code, and of its meaning."""

Title = Annotated[str, Field(max_length=MAX_TITLE)]
Description = Annotated[str, Field(max_length=MAX_DESCRIPTION)]
Unit = Annotated[str, Field(max_length=MAX_UNIT)]
Code = Annotated[str, Field(max_length=MAX_CODE)]


class ValueDomain(BaseModel):
    """A range for numbers or a code list (code → meaning), F-2.8."""

    min: float | None = None
    max: float | None = None
    codes: Annotated[dict[Code, Code], Field(max_length=MAX_CODES)] | None = None

    @model_validator(mode="after")
    def _one_kind(self) -> "ValueDomain":
        if self.codes is not None and (self.min is not None or self.max is not None):
            raise ValueError("a value domain is either a range or a code list")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min must not exceed max")
        return self


# Only fields sent are applied (``exclude_unset``); null only where it means
# "none" (no unit, no value domain), not for the fields every layer has.


class LayerUpdate(BaseModel):
    """Curated layer fields. ``name`` never changes; renaming sets ``title`` (plan D1)."""

    title: Title = Field(default="", min_length=1)
    description: Description = ""
    for_model: bool = True


class AttributeUpdate(BaseModel):
    label: Title = ""
    description: Description = ""
    unit: Unit | None = None
    value_domain: ValueDomain | None = None
    for_model: bool = True


def update_layer(engine: Engine, name: str, update: LayerUpdate) -> LayerInfo | None:
    with Session(engine) as session, session.begin():
        layer = session.scalar(select(Layer).where(Layer.name == name))
        if layer is None:
            return None
        for key, value in update.model_dump(exclude_unset=True).items():
            setattr(layer, key, value)
        session.flush()
        return _info(layer)


def update_attribute(
    engine: Engine, layer_name: str, attribute: str, update: AttributeUpdate
) -> AttributeInfo | None:
    with Session(engine) as session, session.begin():
        row = session.scalar(
            select(LayerAttribute)
            .join(Layer)
            .where(Layer.name == layer_name, LayerAttribute.name == attribute)
        )
        if row is None:
            return None
        for key, value in update.model_dump(exclude_unset=True).items():
            if key == "value_domain" and value is not None:
                value = {k: v for k, v in value.items() if v is not None}
            if key == "unit" and value == "":
                value = None
            setattr(row, key, value)
        if "value_domain" in update.model_fields_set:
            row.value_domain_confirmed = True  # the administrator saw and kept it (S2)
        session.flush()
        return AttributeInfo.model_validate(row, from_attributes=True)


# --- layer profile (F-2.9, plan E2.2) --------------------------------------------

PROFILE_VERSION = 1

CHARS_PER_TOKEN = 3
"""For the token estimate (S5): deliberately low, so the estimate errs high.
Tokenizers differ; compact JSON with German labels runs at about 3 to 4."""


class AttributeProfile(BaseModel):
    name: str
    type: str
    label: str
    description: str | None = None
    unit: str | None = None
    range: list[float] | None = None
    codes: dict[str, str] | None = None
    references: str | None = None


class LayerProfile(BaseModel):
    """What the model learns about a layer: structure and meaning, never content (F-9.3).

    Metadata only (S1): nothing computed from the rows, so no feature count, no
    extent, no distinct values. A value domain counts only once confirmed (S2).
    Only layers and attributes marked ``for_model``.
    """

    name: str
    title: str
    description: str | None = None
    kind: str
    geometry_type: str | None = None
    attributes: list[AttributeProfile]


class ModelProfile(BaseModel):
    """Every layer an account's model may know of, in canonical form (S3, S4).

    ``hash`` is SHA-256 over the canonical JSON of ``profile_version`` and
    ``layers``: two calls with the same hash asked about the same world (E3).
    """

    profile_version: int = PROFILE_VERSION
    layers: list[LayerProfile]
    hash: str
    size_chars: int
    """Characters of the canonical form, as the model receives it."""
    tokens_estimate: int
    """A rough upper estimate of its size in tokens (S5, ``CHARS_PER_TOKEN``)."""


def profile(layer: LayerInfo) -> LayerProfile | None:
    if not layer.for_model:
        return None
    attributes = []
    for a in layer.attributes:
        if not a.for_model:
            continue
        domain = (a.value_domain or {}) if a.value_domain_confirmed else {}
        has_range = "min" in domain and "max" in domain
        attributes.append(
            AttributeProfile(
                name=a.name,
                type=a.data_type,
                label=a.label or a.name,
                description=a.description or None,
                unit=a.unit,
                range=[domain["min"], domain["max"]] if has_range else None,
                codes=domain.get("codes"),
                references=a.references,
            )
        )
    return LayerProfile(
        name=layer.name,
        title=layer.title,
        description=layer.description or None,
        kind=layer.kind,
        geometry_type=layer.geometry_type,
        attributes=attributes,
    )


def _canonical(data: Any) -> str:
    """Stable JSON: sorted keys, no spaces."""
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def model_profile(engine: Engine, visible: Collection[str]) -> ModelProfile:
    """The profile for an account that sees ``visible`` (S3): layers for the model
    and visible, attributes for the model; a reference kept only when its target
    is in the same profile, so no hidden layer is named."""
    layers = [p for p in map(profile, list_layers(engine, only=visible)) if p is not None]
    present = {(p.name, a.name) for p in layers for a in p.attributes}
    for p in layers:
        for a in p.attributes:
            if a.references is not None:
                target = tuple(a.references.split(".", 1))
                if target not in present:
                    a.references = None
    body = {
        "profile_version": PROFILE_VERSION,
        "layers": [p.model_dump(exclude_none=True) for p in layers],
    }
    text = _canonical(body)
    return ModelProfile(
        layers=layers,
        hash=hashlib.sha256(text.encode()).hexdigest(),
        size_chars=len(text),
        tokens_estimate=math.ceil(len(text) / CHARS_PER_TOKEN),
    )
