"""GeoTandem backend."""

from importlib.metadata import version

from geotandem import gdal

# Before anything imports pyogrio: GDAL reads the setting only once (see gdal.py).
gdal.restrict()

__version__ = version("geotandem")
