"""Read access to the layer registry (F-2.7, F-2.8) as API-ready models."""

from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, selectinload

from geotandem.db.orm import Layer


class AttributeInfo(BaseModel):
    name: str
    data_type: Literal["integer", "real", "text", "boolean"]
    label: str
    description: str
    unit: str | None
    value_domain: dict[str, Any] | None


class LayerInfo(BaseModel):
    name: str
    title: str
    description: str
    kind: Literal["vector", "table"]
    geometry_type: str | None
    feature_count: int
    bbox_wgs84: list[float] | None
    dataset_version: str | None
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


def list_layers(engine: Engine) -> list[LayerInfo]:
    with Session(engine) as session:
        layers = session.scalars(
            select(Layer).options(selectinload(Layer.attributes)).order_by(Layer.name)
        )
        return [_info(layer) for layer in layers]


def get_layer(engine: Engine, name: str) -> LayerInfo | None:
    with Session(engine) as session:
        layer = session.scalar(
            select(Layer).options(selectinload(Layer.attributes)).where(Layer.name == name)
        )
        return _info(layer) if layer else None
