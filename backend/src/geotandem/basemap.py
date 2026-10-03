"""Background map (F-4.9) without breaking offline operation (F-9.1).

``GEOTANDEM_BASEMAP`` names a preset or gives an own tile URL template. The
default is ``none``: a plain installation makes no outside requests. An
external background is marked as such, because the browser then fetches
tiles from a third party, which learns the map area being looked at
(plan E1.5, D2).
"""

from pydantic import BaseModel


class Basemap(BaseModel):
    url: str
    """Leaflet tile URL template with {z}, {x}, {y}."""
    attribution: str
    max_zoom: int
    external: bool
    """Tiles come from outside this installation."""


PRESETS: dict[str, Basemap] = {
    "swisstopo-grau": Basemap(
        url="https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg",
        attribution='© <a href="https://www.swisstopo.admin.ch/">swisstopo</a>',
        max_zoom=18,
        external=True,
    ),
    "osm": Basemap(
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
        max_zoom=19,
        external=True,
    ),
}


class BasemapError(ValueError):
    pass


def resolve(setting: str, attribution: str = "") -> Basemap | None:
    """``none``, a preset name, or an own ``http(s)://…{z}…{x}…{y}…`` template."""
    value = setting.strip()
    if value in ("", "none"):
        return None
    if value in PRESETS:
        return PRESETS[value]
    if value.startswith(("http://", "https://")) and all(p in value for p in ("{z}", "{x}", "{y}")):
        return Basemap(url=value, attribution=attribution, max_zoom=19, external=True)
    raise BasemapError(
        f"GEOTANDEM_BASEMAP={setting!r}: expected 'none', one of {', '.join(PRESETS)}, "
        "or a tile URL template with {z}, {x} and {y}."
    )
