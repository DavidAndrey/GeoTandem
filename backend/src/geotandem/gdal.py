"""GDAL, limited to the vector formats the import reads (F-2.1).

An import file is untrusted, and GDAL picks a driver by a file's content, not
its extension. Some drivers read other files or URLs named inside the file
(OGR_VRT, GDALG pipelines), others run programs or load libraries (GPSBabel,
ADBC). Every driver but the three import formats is skipped. GDAL honours that
only while it registers its drivers, i.e. before pyogrio is first imported,
which is why the package sets it on import (``geotandem/__init__.py``).
"""

import os

ALLOWED = frozenset({"GeoJSON", "ESRI Shapefile", "GPKG", "MEM"})

# Every other vector driver of the bundled GDAL (3.12); ``check`` names any new one.
# Comma-separated, as one has a space in its name.
SKIPPED = (
    "ADBC,AIVector,AVCBin,AVCE00,AmigoCloud,CSV,CSW,Carto,DGN,DXF,EDIGEO,EEDA,ESRIJSON,"
    "Elasticsearch,FlatGeobuf,GDALG,GML,GPSBabel,GPX,GTFS,GeoJSONSeq,GeoRSS,HTTP,Idrisi,"
    "JML,JSONFG,KML,LIBKML,LVBAG,MBTiles,MVT,MapInfo File,MapML,MiraMonVector,NGW,OAPIF,"
    "ODS,OGCAPI,OGR_GMT,OGR_PDS,OGR_VRT,OSM,OpenFileGDB,PCIDSK,PDS4,PLSCENES,PMTiles,S57,"
    "SQLite,SXF,Selafin,TopoJSON,VDV,VFK,VICAR,VRT,WAsP,WFS,XLSX"
)


def restrict() -> None:
    present = os.environ.get("GDAL_SKIP")
    os.environ["GDAL_SKIP"] = f"{present},{SKIPPED}" if present else SKIPPED


def check(readable: list[str]) -> None:
    """Fails if pyogrio was imported before ``restrict`` ran, or GDAL brings new drivers."""
    unexpected = sorted(set(readable) - ALLOWED)
    if unexpected:
        raise RuntimeError(
            "GDAL drivers not restricted to the import formats: "
            f"{', '.join(unexpected)} (see geotandem/gdal.py)"
        )
