"""Application settings (F-9.9).

Sources, highest precedence first: constructor arguments, ``GEOTANDEM_*``
environment variables, the TOML file named by ``GEOTANDEM_CONFIG_FILE``,
defaults.
"""

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
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
    frontend_dir: Path | None = Field(
        default=None, description="Built frontend to serve at '/'; none in development."
    )

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
