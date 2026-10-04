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
from sqlalchemy import select
from sqlalchemy.orm import Session

from geotandem.auth import visibility
from geotandem.catalog import LayerInfo, get_layer, list_layers
from geotandem.data import AttributeSpec, DataBackend, NewLayer
from geotandem.db.orm import ImportRun
from geotandem.db.spatialite import reading
from geotandem.geo import reprojector
from geotandem.importing import log as import_log
from geotandem.sample import DATA_DIR

log = logging.getLogger(__name__)
SOURCE = "sample:bern-mittelland"
SAMPLE_PREFIX = "sample:"


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
    """Create missing sample layers; replace those from an older dataset version.

    Layers of an earlier sample dataset that the current one no longer has
    (e.g. Tandemtal's ``bevoelkerung``) are removed. Only sample layers are ever
    replaced or removed: a layer of the same name that an administrator imported
    stays, and a sample layer they deleted is not loaded again.
    """
    manifest = read_manifest(directory)
    metadata = json.loads((directory / "metadata.json").read_text("utf-8"))
    version = manifest["version"]
    current = {layer["name"] for layer in metadata["layers"]}
    for info in list_layers(backend.engine):
        if _from_sample(info) and info.name not in current:
            backend.drop_layer(info.name)
            log.info("sample dataset %s: removed obsolete layer %s", version, info.name)
    existing = set(backend.layer_names())
    loaded_before = _loaded_before(backend)
    loaded = []
    for layer in metadata["layers"]:
        name = layer["name"]
        if name in existing:
            present = get_layer(backend.engine, name)
            if present is None or not _from_sample(present):
                log.warning(
                    "sample dataset %s: layer %s is not from the sample, kept", version, name
                )
                continue
            if present.dataset_version == version:
                continue
            backend.drop_layer(name)
        elif name in loaded_before:
            continue  # deleted by an administrator
        run_id = import_log.start(
            backend.engine,
            source_name=layer["file"],
            source_format=Path(layer["file"]).suffix.lstrip("."),
            mode="create",
            layer_name=name,
            actor=None,
            decisions={"source": SOURCE, "dataset_version": version},
        )
        count = backend.create_layer(
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
        import_log.finish(
            backend.engine, run_id, status="ok", read_count=count, imported_count=count
        )
        loaded.append(name)
    # The sample is meant to be seen by everyone (plan D6).
    visibility.release(backend.engine, loaded)
    if loaded:
        log.info("sample dataset %s: loaded %s", version, ", ".join(loaded))
    return loaded


def _from_sample(info: LayerInfo) -> bool:
    return (info.source or "").startswith(SAMPLE_PREFIX)


def _loaded_before(backend: DataBackend) -> set[str]:
    """Names of the layers some sample dataset has loaded, by the import log."""
    with Session(reading(backend.engine)) as session:
        runs = session.execute(
            select(ImportRun.layer_name, ImportRun.decisions).where(ImportRun.status == "ok")
        )
        return {
            name
            for name, decisions in runs
            if name and str(decisions.get("source", "")).startswith(SAMPLE_PREFIX)
        }
