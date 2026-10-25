"""How complete the layer profile is (plan E3, D11, V8): the metadata Phase 4
found to matter, counted, and per layer what is missing in the order of care
(docs/testplan-system-context.md 8.5): code lists, then labels, then
descriptions.

Counted over the profile, so only what the model sees counts: layers and
attributes released for the model and visible to the account. A proposed code
list that is not confirmed never reaches the profile (S2), so the catalog is
read for it.
"""

from sqlalchemy import Engine

from geotandem.catalog import ModelProfile, list_layers
from geotandem.evaluation.schemas import LayerGaps, ProfileSummary


def profile_summary(profile: ModelProfile, engine: Engine) -> ProfileSummary:
    """The completeness of ``profile``, which was built from the catalog of ``engine``.

    - ``labelled``: attributes whose label is not their column name (the profile
      writes the column name where the label is empty).
    - ``text_attributes``: text attributes with a code list, confirmed or only
      proposed; ``text_with_codes`` the confirmed ones. A text attribute that has
      none (a name) is not counted, so the share can reach 100 % and each layer's
      share follows from its totals and gaps (``LayerGaps``).
    - ``described``: layers and attributes with a description.
    """
    catalog = {
        layer.name: {a.name: a for a in layer.attributes}
        for layer in list_layers(engine, only=[p.name for p in profile.layers])
    }
    attributes = labelled = text_attributes = text_with_codes = described = 0
    gaps: list[LayerGaps] = []
    for layer in profile.layers:
        rows = catalog.get(layer.name, {})
        unconfirmed: list[str] = []
        unlabelled: list[str] = []
        undescribed: list[str] = [] if layer.description else [""]
        texts = 0
        for a in layer.attributes:
            row = rows.get(a.name)
            if a.type == "text":
                if a.codes is not None:
                    texts += 1
                    text_with_codes += 1
                elif row is not None and "codes" in (row.value_domain or {}):
                    texts += 1
                    unconfirmed.append(a.name)
            if a.label == a.name:
                unlabelled.append(a.name)
            if not a.description:
                undescribed.append(a.name)
        count = len(layer.attributes)
        attributes += count
        labelled += count - len(unlabelled)
        text_attributes += texts
        described += count + 1 - len(undescribed)
        if unconfirmed or unlabelled or undescribed:
            gaps.append(
                LayerGaps(
                    layer=layer.name,
                    title=layer.title,
                    attributes=count,
                    text_attributes=texts,
                    unconfirmed_codes=unconfirmed,
                    unlabelled=unlabelled,
                    undescribed=undescribed,
                )
            )
    return ProfileSummary(
        profile_hash=profile.hash,
        layers=len(profile.layers),
        attributes=attributes,
        labelled=labelled,
        text_attributes=text_attributes,
        text_with_codes=text_with_codes,
        described=described,
        gaps=gaps,
    )
