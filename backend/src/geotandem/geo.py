"""Coordinate transformation in application code (import path, F-2.5).

Analysis never reprojects here — that happens in the database.
"""

from collections.abc import Callable, Iterable
from functools import cache

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry.base import BaseGeometry

WGS84 = 4326


@cache
def reprojector(source_srid: int, target_srid: int) -> Callable[[BaseGeometry], BaseGeometry]:
    transformer = Transformer.from_crs(source_srid, target_srid, always_xy=True)

    def apply(geom: BaseGeometry) -> BaseGeometry:
        def coords(xy: np.ndarray) -> np.ndarray:
            x, y = transformer.transform(xy[:, 0], xy[:, 1])
            return np.column_stack([x, y])

        return shapely.transform(geom, coords)

    return apply


def common_geometry_type(geometries: Iterable[BaseGeometry | None]) -> str:
    """The one geometry type a layer column can hold: ``Point``, ``MultiPolygon``, …

    Single and multi variants of one type become multi; anything else is
    ``Geometry``. Rows without geometry don't count.
    """
    kinds: set[str] = {str(g.geom_type) for g in geometries if g is not None}
    if not kinds:
        return "Geometry"
    if len(kinds) == 1:
        return kinds.pop()
    base = {k.removeprefix("Multi") for k in kinds}
    if len(base) == 1 and base <= {"Point", "LineString", "Polygon"}:
        return "Multi" + base.pop()
    return "Geometry"
