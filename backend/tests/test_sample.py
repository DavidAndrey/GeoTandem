import json
from pathlib import Path

import pytest
import shapely
from shapely.geometry import shape
from sqlalchemy import func, select

from geotandem.data import DataBackend, Limits
from geotandem.sample import DATA_DIR
from geotandem.sample.generate import DATASET_VERSION, generate
from geotandem.sample.load import SampleDataError, load_sample, read_manifest

LIMITS = Limits(max_features=10_000, timeout_s=5)


def _features(directory: Path, name: str) -> list[dict]:  # type: ignore[type-arg]
    return json.loads((directory / name).read_text("utf-8"))["features"]  # type: ignore[no-any-return]


def test_committed_sample_matches_generator(tmp_path: Path) -> None:
    """Regenerate and compare; coordinates within 1e-7° to tolerate PROJ builds."""
    fresh = generate(tmp_path)
    committed = read_manifest(DATA_DIR)
    assert fresh["version"] == committed["version"] == DATASET_VERSION
    for name in ("bevoelkerung.csv", "metadata.json"):
        assert (tmp_path / name).read_text() == (DATA_DIR / name).read_text()
    for name in ("gemeinden.geojson", "gewaesser.geojson", "strassen.geojson", "schulen.geojson"):
        new, old = _features(tmp_path, name), _features(DATA_DIR, name)
        assert [f["properties"] for f in new] == [f["properties"] for f in old]
        for a, b in zip(new, old, strict=True):
            assert shapely.equals_exact(shape(a["geometry"]), shape(b["geometry"]), 1e-7)


def test_tampered_file_is_detected(tmp_path: Path) -> None:
    generate(tmp_path)
    (tmp_path / "bevoelkerung.csv").write_text("gem_nr,einwohner,anteil_u20\n")
    with pytest.raises(SampleDataError):
        read_manifest(tmp_path)


def test_region_is_a_clean_tiling() -> None:
    gem = [shape(f["geometry"]) for f in _features(DATA_DIR, "gemeinden.geojson")]
    schools = [shape(f["geometry"]) for f in _features(DATA_DIR, "schulen.geojson")]
    assert len(gem) == 12
    assert len(schools) == 120
    # Every school lies in exactly one municipality.
    assert all(sum(g.contains(s) for g in gem) == 1 for s in schools)


def test_load_creates_layers_once(backend: DataBackend) -> None:
    loaded = load_sample(backend)
    assert sorted(loaded) == ["bevoelkerung", "gemeinden", "gewaesser", "schulen", "strassen"]
    assert load_sample(backend) == []  # idempotent

    schools = backend.layer_table("schulen")
    gem = backend.layer_table("gemeinden")
    count = backend.execute(select(func.count()).select_from(schools), LIMITS)
    assert next(iter(count[0].values())) == 120
    # Stored in the internal CRS: municipality areas sum to the 12 x 9 km region.
    area = backend.execute(select(func.sum(func.ST_Area(gem.c.geom))), LIMITS)
    assert next(iter(area[0].values())) == pytest.approx(108e6, rel=1e-4)
