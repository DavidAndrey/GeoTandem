"""Application settings (F-9.9).

Sources, highest precedence first: constructor arguments, ``GEOTANDEM_*``
environment variables, the TOML file named by ``GEOTANDEM_CONFIG_FILE``,
defaults.
"""

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    TomlConfigSettingsSource,
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GEOTANDEM_", extra="ignore")

    data_dir: Path = Field(default=Path("./data"), description="Home of the SpatiaLite file.")
    database_url: str | None = Field(
        default=None,
        description="SQLAlchemy URL; defaults to a SpatiaLite file in data_dir (F-2.13).",
    )
    spatialite_library: str = Field(
        default="mod_spatialite", description="Name or path of the SpatiaLite extension."
    )
    internal_crs: int = Field(
        default=2056,
        description="EPSG code of the metric internal CRS (F-2.5). Fixed at first start.",
    )
    load_sample_data: bool = Field(
        default=False, description="Load the sample dataset on start if absent (F-10.5)."
    )
    max_features: int = Field(default=10_000, ge=1, description="Result size limit (F-9.6).")
    query_timeout_s: float = Field(default=10.0, gt=0, description="Query run time limit (F-9.6).")
    max_running_queries: int = Field(
        default=8, ge=1, description="Queries running at once in all (security review #5)."
    )
    max_running_queries_per_account: int = Field(
        default=3, ge=1, description="Queries running at once per account (security review #5)."
    )
    max_sessions_per_account: int = Field(
        default=100, ge=1, description="Saved analysis sessions per account (review #6)."
    )
    max_saved_queries_per_account: int = Field(
        default=100, ge=1, description="Saved queries per account (review #6)."
    )
    max_import_mb: int = Field(default=200, ge=1, description="Largest accepted upload (E1.3).")
    max_import_unpacked_mb: int = Field(
        default=1000,
        ge=1,
        description="What a zipped shapefile or an Excel workbook may unpack to (review #9).",
    )
    import_memory_mb: int = Field(
        default=4096,
        ge=1024,
        description="Address space of the process that reads an import file (review #9); "
        "the libraries alone take about 1.4 GB of it.",
    )
    import_timeout_s: int = Field(
        default=300, ge=10, description="CPU time to read an import file (review #9)."
    )
    max_request_mb: float = Field(
        default=2,
        gt=0,
        description="Largest request body but an administrator's upload (security review #3).",
    )
    session_hours: float = Field(
        default=12, gt=0, description="Login session lifetime, extended on use (F-3.12)."
    )
    session_max_days: float = Field(
        default=7,
        gt=0,
        description="Longest a login lasts from sign-in, however much it is used "
        "(security review #16).",
    )
    setup_token: SecretStr | None = Field(
        default=None,
        min_length=16,
        description="Token the first administrator's setup asks for (security review #1). "
        "Unset: one is made at each start while no account exists and written to the log.",
    )
    login_failures: int = Field(
        default=10,
        ge=1,
        description="Failed sign-ins per username and client address in 15 minutes "
        "before sign-in is refused for a while (security review #2).",
    )
    login_failures_per_address: int = Field(
        default=50,
        ge=1,
        description="Failed sign-ins per client address in 15 minutes, whatever the username.",
    )
    cookie_secure: bool = Field(
        default=False,
        description="Send the session cookie over HTTPS only. Requests that arrive over "
        "HTTPS get such a cookie anyway (security review #4).",
    )
    api_docs: bool = Field(
        default=False,
        description="Serve /docs, /redoc and /openapi.json; off on a public instance (review #10).",
    )
    basemap: str = Field(
        default="none",
        description="Background map: 'none', 'swisstopo-grau', 'osm' or a tile URL template "
        "(F-4.9). Anything but 'none' makes browsers fetch tiles from outside (F-9.1).",
    )
    basemap_attribution: str = Field(
        default="", description="Attribution shown for an own tile URL template."
    )
    frontend_dir: Path | None = Field(
        default=None, description="Built frontend to serve at '/'; none in development."
    )

    @field_validator("setup_token", mode="before")
    @classmethod
    def _empty_is_unset(cls, value: object) -> object:
        # Compose passes an unset variable on as "" (compose.yaml).
        return None if value == "" else value

    @field_validator("basemap")
    @classmethod
    def _known_basemap(cls, value: str) -> str:
        from geotandem.basemap import resolve

        resolve(value)  # fail at start, not when the first map opens
        return value

    @property
    def staging_dir(self) -> Path:
        """Uploads waiting for their import decisions."""
        return self.data_dir / "staging"

    @property
    def sqlalchemy_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'geotandem.sqlite').resolve()}"

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        sources: list[PydanticBaseSettingsSource] = [init_settings, env_settings]
        config_file = os.environ.get("GEOTANDEM_CONFIG_FILE")
        if config_file:
            sources.append(TomlConfigSettingsSource(settings_cls, toml_file=Path(config_file)))
        return tuple(sources)


@lru_cache
def get_settings() -> Settings:
    return Settings()
