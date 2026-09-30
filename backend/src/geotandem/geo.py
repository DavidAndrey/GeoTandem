"""Coordinate transformation in application code (import path, F-2.5).

Analysis never reprojects here — that happens in the database.
"""

from collections.abc import Callable
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
