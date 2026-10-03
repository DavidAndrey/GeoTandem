"""The layer registry (F-2.7, F-2.8) as API-ready models, and its curation."""

from collections.abc import Collection
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, selectinload

from geotandem.db.orm import Layer, LayerAttribute


class AttributeInfo(BaseModel):
    name: str
    data_type: Literal["integer", "real", "text", "boolean", "date"]
    label: str
    description: str
    unit: str | None
    value_domain: dict[str, Any] | None
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
    source: str
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
    with Session(engine) as session:
        return [_info(layer) for layer in session.scalars(stmt)]


def get_layer(engine: Engine, name: str) -> LayerInfo | None:
    with Session(engine) as session:
        layer = session.scalar(
            select(Layer).options(selectinload(Layer.attributes)).where(Layer.name == name)
        )
        return _info(layer) if layer else None


# --- curation (F-2.7 "Umbenennen", F-2.8) -------------------------------------


class ValueDomain(BaseModel):
    """A range for numbers or a code list (code → meaning), F-2.8."""

    min: float | None = None
    max: float | None = None
    codes: dict[str, str] | None = None

    @model_validator(mode="after")
    def _one_kind(self) -> "ValueDomain":
        if self.codes is not None and (self.min is not None or self.max is not None):
            raise ValueError("a value domain is either a range or a code list")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min must not exceed max")
        return self


class LayerUpdate(BaseModel):
    """Curated layer fields. ``name`` never changes; renaming sets ``title`` (plan D1)."""

    title: str | None = Field(default=None, min_length=1)
    description: str | None = None
    for_model: bool | None = None


class AttributeUpdate(BaseModel):
    label: str | None = None
    description: str | None = None
    unit: str | None = None
    value_domain: ValueDomain | None = None
    for_model: bool | None = None


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
        session.flush()
        return AttributeInfo.model_validate(row, from_attributes=True)


# --- layer profile (F-2.9) ----------------------------------------------------


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

    Derived from the metadata (F-2.8); only layers and attributes marked
    ``for_model``. E2.2 limits it to the layers visible to the user.
    """

    name: str
    title: str
    description: str | None = None
    kind: str
    geometry_type: str | None = None
    feature_count: int
    attributes: list[AttributeProfile]


def profile(layer: LayerInfo) -> LayerProfile | None:
    if not layer.for_model:
        return None
    attributes = []
    for a in layer.attributes:
        if not a.for_model:
            continue
        domain = a.value_domain or {}
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
        feature_count=layer.feature_count,
        attributes=attributes,
    )
