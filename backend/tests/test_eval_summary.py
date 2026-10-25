"""The completeness of the layer profile (plan E3, D11, WP94).

The summary of the sample data and of each Phase 4 mode (``evaluation/profiles.py``)
matches a count by hand from ``sample/data/metadata.json``; the route gives the
sample's, or the live catalog's as an account sees it, and a proposed code list
not yet confirmed shows as the first gap although the profile never carries it.
"""

import shutil
from pathlib import Path

import httpx
import pytest
from sqlalchemy import Engine
from test_profile import SENTINELS, import_sentinels, sentinel_csv

from geotandem.catalog import model_profile
from geotandem.config import Settings
from geotandem.db.bootstrap import bootstrap
from geotandem.evaluation.profiles import PROFILES, strip
from geotandem.evaluation.schemas import LayerGaps, ProfileSummary
from geotandem.evaluation.summary import profile_summary

ROUTE = "/api/admin/evaluation/profile-summary"

# --- the sample, counted by hand -----------------------------------------------

TITLES = {
    "gemeindedaten": "Gemeindedaten",
    "gemeinden": "Gemeinden",
    "gewaesser": "Gewässer",
    "haltestellen": "Haltestellen",
    "schulen": "Schulen",
    "strassen": "Strassen",
}
"""Every sample layer, in the catalog's order (by name); each has a description."""

ATTRIBUTES = {
    "gemeindedaten": ["gem_nr", "einwohner", "steueranlage", "steuerpflichtige", "steuerjahr"],
    "gemeinden": ["gem_nr", "name", "flaeche_km2"],
    "gewaesser": ["name", "typ", "laenge_km"],
    "haltestellen": ["name", "verkehrsmittel", "kategorie", "einwohner", "arbeitsplaetze"],
    "schulen": [
        "name",
        "gem_nr",
        "typ",
        "kindergarten",
        "primarstufe",
        "sekundarstufe",
        "sprache",
        "standorte",
    ],
    "strassen": ["name", "nummer", "klasse"],
}
"""27 attributes, every one labelled (``gewaesser.name`` is «Name», not ``name``)."""

CODED = {
    "gewaesser": ["typ"],
    "haltestellen": ["verkehrsmittel", "kategorie"],
    "schulen": ["typ", "sprache"],
    "strassen": ["klasse"],
}
"""The 6 text attributes with a code list; the other 6 text attributes are names."""

DESCRIBED = {
    "gemeindedaten": ["gem_nr", "steueranlage"],
    "gemeinden": ["gem_nr"],
    "haltestellen": ["kategorie"],
    "schulen": ["gem_nr"],
}
"""The 5 attributes with a description: 6 layers + 5 = 11 of 33 described."""

TOTALS = {
    # mode: labelled, text_with_codes, described (of 27, 6, 33)
    "full": (27, 6, 11),
    "no-desc": (27, 6, 0),
    "no-labels": (0, 6, 11),
    "no-domains": (27, 0, 11),
    "raw": (0, 0, 0),
    "raw-codes": (0, 6, 0),
}


def expected_gaps(mode: str) -> list[LayerGaps]:
    no_desc = mode in ("no-desc", "raw", "raw-codes")
    no_labels = mode in ("no-labels", "raw", "raw-codes")
    no_codes = mode in ("no-domains", "raw")
    gaps = []
    for layer, names in ATTRIBUTES.items():
        described = [] if no_desc else DESCRIBED.get(layer, [])
        gap = LayerGaps(
            layer=layer,
            title=layer if mode in ("raw", "raw-codes") else TITLES[layer],
            attributes=len(names),
            text_attributes=len(CODED.get(layer, [])),
            unconfirmed_codes=CODED.get(layer, []) if no_codes else [],
            unlabelled=names if no_labels else [],
            undescribed=([""] if no_desc else []) + [n for n in names if n not in described],
        )
        if gap.unconfirmed_codes or gap.unlabelled or gap.undescribed:
            gaps.append(gap)
    return gaps


@pytest.fixture
def stripped(tmp_path: Path, sample_database: Path) -> Engine:
    """A copy of the sample's data core, each test strips it by its mode."""
    settings = Settings(data_dir=tmp_path / "data")
    settings.data_dir.mkdir()
    shutil.copy(sample_database, settings.data_dir / "geotandem.sqlite")
    return bootstrap(settings)


@pytest.mark.parametrize("mode", list(PROFILES))
def test_the_summary_of_each_mode_matches_the_count_by_hand(stripped: Engine, mode: str) -> None:
    strip(stripped, mode)
    profile = model_profile(stripped, list(TITLES))
    labelled, coded, described = TOTALS[mode]
    assert profile_summary(profile, stripped) == ProfileSummary(
        profile_hash=profile.hash,
        layers=6,
        attributes=27,
        labelled=labelled,
        text_attributes=6,
        text_with_codes=coded,
        described=described,
        gaps=expected_gaps(mode),
    )


def test_the_sample_lacks_only_attribute_descriptions(stripped: Engine) -> None:
    """Every code list confirmed and every attribute labelled: the sample's gaps
    are of the third kind only, and its own layer descriptions are there."""
    summary = profile_summary(model_profile(stripped, list(TITLES)), stripped)
    assert all(not g.unconfirmed_codes and not g.unlabelled for g in summary.gaps)
    assert all("" not in g.undescribed for g in summary.gaps)
    assert [g.layer for g in summary.gaps] == list(TITLES)


def test_only_what_the_profile_holds_counts(stripped: Engine) -> None:
    """An account's visible layers only; an attribute not for the model is not
    counted, nor is its code list."""
    summary = profile_summary(model_profile(stripped, ["schulen", "gemeinden"]), stripped)
    assert (summary.layers, summary.attributes, summary.text_attributes) == (2, 11, 2)
    assert [g.layer for g in summary.gaps] == ["gemeinden", "schulen"]
    empty = profile_summary(model_profile(stripped, []), stripped)
    assert empty.model_dump(exclude={"profile_hash"}) == {
        "layers": 0,
        "attributes": 0,
        "labelled": 0,
        "text_attributes": 0,
        "text_with_codes": 0,
        "described": 0,
        "gaps": [],
    }


# --- the route -------------------------------------------------------------------


async def summary_of(client: httpx.AsyncClient, **params: str) -> ProfileSummary:
    response = await client.get(ROUTE, params=params)
    assert response.status_code == 200, response.text
    return ProfileSummary.model_validate(response.json())


async def test_the_sample_and_the_live_catalog_as_loaded_agree(client: httpx.AsyncClient) -> None:
    sample = await summary_of(client, data_state="sample")
    live = await summary_of(client)
    assert (sample.layers, sample.attributes, sample.labelled) == (6, 27, 27)
    assert (sample.text_attributes, sample.text_with_codes, sample.described) == (6, 6, 11)
    assert sample.gaps == expected_gaps("full")
    assert live == sample
    assert live == await summary_of(client, data_state="live", account="admin")


async def test_live_is_as_the_account_sees_it(client: httpx.AsyncClient) -> None:
    hide = {"layer": "gemeinden", "role": "user", "visible": False}
    assert (await client.put("/api/admin/visibility", json=hide)).status_code == 200
    await client.patch("/api/admin/layers/schulen", json={"for_model": False})
    await client.patch("/api/admin/layers/strassen/attributes/klasse", json={"for_model": False})
    created = await client.post("/api/admin/users", json={"username": "m.keller", "role": "user"})
    assert created.status_code == 201

    admin = await summary_of(client)
    user = await summary_of(client, account="m.keller")
    assert (admin.layers, admin.attributes, admin.text_attributes) == (5, 18, 3)
    assert (user.layers, user.attributes, user.text_attributes) == (4, 15, 3)
    assert "gemeinden" not in [g.layer for g in user.gaps]
    assert "klasse" not in next(g for g in admin.gaps if g.layer == "strassen").undescribed
    # The sample is the same for every account (D4).
    assert await summary_of(client, data_state="sample", account="m.keller") == await summary_of(
        client, data_state="sample"
    )


async def test_a_proposed_code_list_is_the_first_gap_until_confirmed(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    await import_sentinels(client, sentinel_csv(tmp_path))
    before = await summary_of(client)
    [gap] = [g for g in before.gaps if g.layer == "sentinel"]
    assert gap.unconfirmed_codes == ["kategorie"]
    # The coordinates stay as columns, labelled by their header («E», «N»).
    assert gap.unlabelled == ["kategorie", "wert"]
    assert gap.undescribed == ["", "e", "n", "kategorie", "wert"]
    assert (gap.attributes, gap.text_attributes) == (4, 1)
    assert (before.text_attributes, before.text_with_codes) == (7, 6)
    assert SENTINELS[0] not in before.model_dump_json()

    confirmed = await client.patch(
        "/api/admin/layers/sentinel/attributes/kategorie",
        json={"value_domain": {"codes": {SENTINELS[0]: "Zebra"}}, "label": "Kategorie"},
    )
    assert confirmed.status_code == 200, confirmed.text
    after = await summary_of(client)
    [gap] = [g for g in after.gaps if g.layer == "sentinel"]
    assert (gap.unconfirmed_codes, gap.unlabelled) == ([], ["wert"])
    assert (after.text_attributes, after.text_with_codes) == (7, 7)
    assert after.profile_hash != before.profile_hash


async def test_an_unknown_account_is_not_found(client: httpx.AsyncClient) -> None:
    for state in ("live", "sample"):
        response = await client.get(ROUTE, params={"data_state": state, "account": "niemand"})
        assert response.status_code == 404, response.text
        assert response.json()["details"] == {"account": "niemand"}
    assert (await client.get(ROUTE, params={"data_state": "beides"})).status_code == 422
