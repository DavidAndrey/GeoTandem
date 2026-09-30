"""Export of the query-object JSON schema as a versioned artefact (F-10.3)."""

import json
from pathlib import Path
from typing import Any

from geotandem_query.models import QueryObject
from geotandem_query.version import SCHEMA_VERSION

SCHEMA_ID = f"https://geotandem.local/schema/query-object/v{SCHEMA_VERSION}.json"


def json_schema() -> dict[str, Any]:
    schema = QueryObject.model_json_schema(by_alias=True)
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = SCHEMA_ID
    return schema


def render() -> str:
    return json.dumps(json_schema(), indent=2, ensure_ascii=False) + "\n"


def write(directory: Path) -> Path:
    path = directory / f"v{SCHEMA_VERSION}.json"
    path.write_text(render(), encoding="utf-8")
    return path
