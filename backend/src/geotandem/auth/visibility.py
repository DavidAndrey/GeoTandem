"""Which layers a role may see (F-2.7, design D10).

Administrators see every layer. For the role ``user`` a layer is visible
once it is released. New imports start unreleased (plan D6) unless the
administrator set new layers to be visible at once (design D10, plan E1.8);
the sample dataset is released when it is loaded.
"""

from __future__ import annotations

from collections.abc import Iterable

from pydantic import BaseModel
from sqlalchemy import Engine, delete, select
from sqlalchemy.orm import Session

from geotandem.auth.accounts import Account
from geotandem.data import DataBackend
from geotandem.data.view import LayerView
from geotandem.db.orm import AppMeta, Layer, LayerVisibility, Role

NEW_LAYERS_VISIBLE = "new_layers_visible"
"""Instance setting: new layers released for users at once (design D10)."""

RELEASABLE: tuple[Role, ...] = ("user",)
"""Roles whose visibility is configured; ``admin`` always sees everything."""


class VisibilityRow(BaseModel):
    layer: str
    title: str
    roles: dict[Role, bool]


def visible_names(engine: Engine, role: Role) -> frozenset[str]:
    with Session(engine) as session:
        if role == "admin":
            return frozenset(session.scalars(select(Layer.name)))
        return frozenset(
            session.scalars(
                select(Layer.name).join(LayerVisibility).where(LayerVisibility.role == role)
            )
        )


def view_for(backend: DataBackend, account: Account) -> DataBackend:
    """The backend as ``account`` sees it; administrators get the backend itself."""
    if account.role == "admin":
        return backend
    return LayerView(backend, visible_names(backend.engine, account.role))


def matrix(engine: Engine) -> list[VisibilityRow]:
    with Session(engine) as session:
        released = {
            (layer_id, role)
            for layer_id, role in session.execute(
                select(LayerVisibility.layer_id, LayerVisibility.role)
            )
        }
        return [
            VisibilityRow(
                layer=layer.name,
                title=layer.title,
                roles={"admin": True, **{r: (layer.id, r) in released for r in RELEASABLE}},
            )
            for layer in session.scalars(select(Layer).order_by(Layer.title))
        ]


def set_visible(engine: Engine, layer: str, role: Role, visible: bool) -> bool:
    """Release or withdraw ``layer`` for ``role``; ``False`` if the layer is unknown."""
    if role not in RELEASABLE:
        raise ValueError(f"visibility of role '{role}' is not configurable")
    with Session(engine) as session, session.begin():
        layer_id = session.scalar(select(Layer.id).where(Layer.name == layer))
        if layer_id is None:
            return False
        session.execute(
            delete(LayerVisibility).where(
                LayerVisibility.layer_id == layer_id, LayerVisibility.role == role
            )
        )
        if visible:
            session.add(LayerVisibility(layer_id=layer_id, role=role))
        return True


def release(engine: Engine, layers: Iterable[str], role: Role = "user") -> None:
    for layer in layers:
        set_visible(engine, layer, role, True)


def new_layers_visible(engine: Engine) -> bool:
    """Whether a new layer is released at once; by default it waits for release (plan D6)."""
    with Session(engine) as session:
        value = session.scalar(select(AppMeta.value).where(AppMeta.key == NEW_LAYERS_VISIBLE))
        return value == "true"


def set_new_layers_visible(engine: Engine, visible: bool) -> None:
    with Session(engine) as session, session.begin():
        entry = session.get(AppMeta, NEW_LAYERS_VISIBLE)
        if entry is None:
            session.add(AppMeta(key=NEW_LAYERS_VISIBLE, value=str(visible).lower()))
        else:
            entry.value = str(visible).lower()


def apply_default(engine: Engine, layer: str) -> None:
    """For a layer just created: release it if the instance says so."""
    if new_layers_visible(engine):
        release(engine, [layer])


def copy_visibility(engine: Engine, source: str, target: str) -> None:
    """A duplicate is seen by whoever saw the original."""
    for row in matrix(engine):
        if row.layer == source:
            for role in RELEASABLE:
                set_visible(engine, target, role, row.roles.get(role, False))
