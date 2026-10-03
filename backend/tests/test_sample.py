import json
import shutil
from pathlib import Path

import pytest
import shapely
from shapely.geometry import shape
from sqlalchemy import func, select

from geotandem.catalog import get_layer
from geotandem.data import AttributeSpec, DataBackend, Limits, NewLayer
from geotandem.sample import DATA_DIR
from geotandem.sample.build import FETCHED, build, default_cache
from geotandem.sample.load import SOURCE, SampleDataError, load_sample, read_manifest

LIMITS = Limits(max_features=10_000, timeout_s=5)
LAYERS = ["gemeindedaten", "gemeinden", "gewaesser", "haltestellen", "schulen", "strassen"]


def _features(directory: Path, name: str) -> list[dict]:  # type: ignore[type-arg]
    return json.loads((directory / name).read_text("utf-8"))["features"]  # type: ignore[no-any-return]


def _metadata() -> dict:  # type: ignore[type-arg]
    return json.loads((DATA_DIR / "metadata.json").read_text("utf-8"))  # type: ignore[no-any-return]


def _cache_with_committed_sources() -> Path | None:
    cache = default_cache()
    if not (cache / FETCHED).exists():
        return None
    fetched = json.loads((cache / FETCHED).read_text("utf-8"))["files"]
    pinned = {s["code"]: s["sha256"] for s in _metadata()["sources"]}
    return cache if fetched == pinned else None


def test_committed_sample_matches_build(tmp_path: Path) -> None:
    """Rebuild from the pinned download; coordinates within 1e-7° to tolerate PROJ builds."""
    cache = _cache_with_committed_sources()
    if cache is None:
        pytest.skip("download cache with the pinned sources absent: geotandem sample update")
    fresh = build(cache, tmp_path)
    assert fresh["version"] == read_manifest(DATA_DIR)["version"]
    for name in ("gemeindedaten.csv", "metadata.json"):
        assert (tmp_path / name).read_text() == (DATA_DIR / name).read_text()
    for layer in _metadata()["layers"]:
        if layer["kind"] != "vector":
            continue
        new, old = _features(tmp_path, layer["file"]), _features(DATA_DIR, layer["file"])
        assert [f["properties"] for f in new] == [f["properties"] for f in old]
        for a, b in zip(new, old, strict=True):
            assert shapely.equals_exact(shape(a["geometry"]), shape(b["geometry"]), 1e-7)


def test_tampered_file_is_detected(tmp_path: Path) -> None:
    shutil.copytree(DATA_DIR, tmp_path, dirs_exist_ok=True)
    (tmp_path / "gemeindedaten.csv").write_text("gem_nr,einwohner\n")
    with pytest.raises(SampleDataError):
        read_manifest(tmp_path)


def test_metadata_credits_and_pins_every_source() -> None:
    metadata = _metadata()
    assert metadata["attribution"] == "Amt für Geoinformation des Kantons Bern (AGI)"
    assert metadata["license"] == "opendata.swiss terms_open"
    assert all(
        len(s["sha256"]) == 64 and s["url"].startswith("https://") for s in metadata["sources"]
    )
    assert sorted(layer["name"] for layer in metadata["layers"]) == LAYERS


def test_region_is_consistent() -> None:
    gem = {
        f["properties"]["gem_nr"]: shape(f["geometry"])
        for f in _features(DATA_DIR, "gemeinden.geojson")
    }
    assert len(gem) == 74
    # Every school lies in exactly one municipality: the one it names.
    for school in _features(DATA_DIR, "schulen.geojson"):
        point = shape(school["geometry"])
        assert [n for n, g in gem.items() if g.contains(point)] == [school["properties"]["gem_nr"]]
    region = shapely.union_all(list(gem.values()))
    assert all(
        region.contains(shape(f["geometry"])) for f in _features(DATA_DIR, "haltestellen.geojson")
    )
    rows = (DATA_DIR / "gemeindedaten.csv").read_text("utf-8").splitlines()[1:]
    assert sorted(int(r.split(",")[0]) for r in rows) == sorted(gem)


def test_load_creates_layers_once(backend: DataBackend) -> None:
    loaded = load_sample(backend)
    assert sorted(loaded) == LAYERS
    assert load_sample(backend) == []  # idempotent

    schools = backend.layer_table("schulen")
    gem = backend.layer_table("gemeinden")
    count = backend.execute(select(func.count()).select_from(schools), LIMITS)
    assert next(iter(count[0].values())) == 137
    # Stored in the internal CRS: the areas add up to what the files state.
    stated = sum(f["properties"]["flaeche_km2"] for f in _features(DATA_DIR, "gemeinden.geojson"))
    area = backend.execute(select(func.sum(func.ST_Area(gem.c.geom))), LIMITS)
    assert next(iter(area[0].values())) / 1e6 == pytest.approx(stated, rel=1e-4)


def test_load_removes_layers_of_an_earlier_sample(backend: DataBackend) -> None:
    backend.create_layer(
        NewLayer(
            name="bevoelkerung",
            title="Bevölkerung",
            description="",
            kind="table",
            attributes=[AttributeSpec(name="gem_nr", data_type="integer")],
            rows=iter([(None, {"gem_nr": 101})]),
            source="sample:tandemtal",
            dataset_version="tandemtal-1",
        )
    )
    load_sample(backend)
    assert "bevoelkerung" not in backend.layer_names()
    info = get_layer(backend.engine, "schulen")
    assert info is not None and info.source == SOURCE
