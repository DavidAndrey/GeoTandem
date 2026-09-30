from pathlib import Path

import pytest

from geotandem.config import Settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data")
