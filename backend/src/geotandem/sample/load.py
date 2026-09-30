"""Load the sample dataset through the data-access layer (F-10.5).

Uses ``DataBackend.create_layer`` — the same entry point the import (E1.3)
uses — so there is no second way into the data core.
"""

import csv
import hashlib
import json
import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

from geotandem.catalog import get_layer
from geotandem.data import AttributeSpec, DataBackend, NewLayer
from geotandem.geo import reprojector
from geotandem.sample import DATA_DIR

log = logging.getLogger(__name__)
SOURCE = "sample:tandemtal"


class SampleDataError(RuntimeError):
    pass


def read_manifest(directory: Path = DATA_DIR) -> dict[str, Any]:
    manifest: dict[str, Any] = json.loads((directory / "manifest.json").read_text("utf-8"))
    for name, digest in manifest["files"].items():
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
            raise SampleDataError(f"{name} does not match manifest.json")
    return manifest


def dataset_version(directory: Path = DATA_DIR) -> str:
    return str(read_manifest(directory)["version"])


def _rows(
    directory: Path, layer: dict[str, Any], source_srid: int, target_srid: int
) -> Iterator[tuple[BaseGeometry | None, dict[str, Any]]]:
    path = directory / layer["file"]
    if layer["kind"] == "table":
        types = {a["name"]: a["data_type"] for a in layer["attributes"]}
        cast = {"integer": int, "real": float, "text": str}
        with path.open(encoding="utf-8", newline="") as f:
            for record in csv.DictReader(f):
                yield None, {k: cast[types[k]](v) for k, v in record.items()}
        return
    to_internal = reprojector(source_srid, target_srid)
    for feature in json.loads(path.read_text("utf-8"))["features"]:
        yield to_internal(shape(feature["geometry"])), feature["properties"]


def load_sample(backend: DataBackend, directory: Path = DATA_DIR) -> list[str]:
    """Create missing sample layers; replace those from an older dataset version."""
    manifest = read_manifest(directory)
    metadata = json.loads((directory / "metadata.json").read_text("utf-8"))
    version = manifest["version"]
    existing = set(backend.layer_names())
    loaded = []
    for layer in metadata["layers"]:
        name = layer["name"]
        if name in existing:
            if _version_of(backend, name) == version:
                continue
            backend.drop_layer(name)
        backend.create_layer(
            NewLayer(
                name=name,
                title=layer["title"],
                description=layer.get("description", ""),
                kind=layer["kind"],
                attributes=[AttributeSpec(**a) for a in layer["attributes"]],
                rows=_rows(directory, layer, metadata["source_crs"], backend.internal_srid),
                source=SOURCE,
                dataset_version=version,
            )
        )
        loaded.append(name)
    if loaded:
        log.info("sample dataset %s: loaded %s", version, ", ".join(loaded))
    return loaded


def _version_of(backend: DataBackend, name: str) -> str | None:
    info = get_layer(backend.engine, name)
    return info.dataset_version if info else None
