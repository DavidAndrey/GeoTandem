from pathlib import Path

from geotandem_query.export import render
from geotandem_query.version import SCHEMA_VERSION

ARTEFACT = Path(__file__).parents[3] / "schema" / "query-object" / f"v{SCHEMA_VERSION}.json"


def test_committed_schema_matches_models() -> None:
    """The versioned artefact must not drift from the models (F-10.3).

    Regenerate with ``geotandem schema export``.
    """
    assert ARTEFACT.read_text(encoding="utf-8") == render()
