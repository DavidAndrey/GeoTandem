"""The data-access layer as one account sees it (F-2.7 "Sichtbarkeit je Rolle").

Same data core, fewer layers: a layer outside the view behaves exactly like
one that does not exist, also in error messages, so its existence does not
leak. The execution engine and the tools receive a view instead of the
backend and need no visibility logic of their own. A view never writes.
"""

from __future__ import annotations

from collections.abc import Collection
from typing import Any

from sqlalchemy import Select, Table

from geotandem.data.interface import DataBackend, Limits, NewLayer, Op


class LayerView:
    def __init__(self, backend: DataBackend, visible: Collection[str]) -> None:
        self._backend = backend
        self.visible = frozenset(visible)
        self.name = backend.name
        self.engine = backend.engine
        self.dialect = backend.dialect
        self.internal_srid = backend.internal_srid

    def layer_table(self, name: str) -> Table:
        if name not in self.visible:
            raise KeyError(name)
        return self._backend.layer_table(name)

    def layer_names(self) -> list[str]:
        return [n for n in self._backend.layer_names() if n in self.visible]

    def execute(self, stmt: Select[Any], limits: Limits) -> list[dict[str, Any]]:
        return self._backend.execute(stmt, limits)

    def missing_functions(self) -> dict[Op, list[str]]:
        return self._backend.missing_functions()

    def create_layer(self, layer: NewLayer) -> int:
        raise PermissionError("a layer view is read-only")

    def replace_layer(self, name: str, layer: NewLayer) -> int:
        raise PermissionError("a layer view is read-only")

    def drop_layer(self, name: str) -> None:
        raise PermissionError("a layer view is read-only")

    def duplicate_layer(self, name: str, new_name: str, title: str) -> int:
        raise PermissionError("a layer view is read-only")
