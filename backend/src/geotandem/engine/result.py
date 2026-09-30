"""Result of a query: GeoJSON, tied to the query that produced it (F-8.9)."""

from typing import Any, Literal

from pydantic import BaseModel, Field

from geotandem_query import QueryObject


class ResultMeta(BaseModel):
    schema_version: str
    query_hash: str = Field(description="sha256 of the canonical query object.")
    data_versions: dict[str, str | None] = Field(
        description="Dataset version of every layer the query touched."
    )
    backend: str
    feature_count: int
    elapsed_ms: float


class Feature(BaseModel):
    type: Literal["Feature"] = "Feature"
    id: int
    properties: dict[str, Any]
    geometry: dict[str, Any] | None


class QueryResult(BaseModel):
    """A GeoJSON FeatureCollection plus the query and its provenance."""

    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[Feature]
    query: QueryObject
    meta: ResultMeta
