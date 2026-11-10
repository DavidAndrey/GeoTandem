"""Proposed metadata of a layer (plan-attribute-metadata D).

Where a layer's description or an attribute's label or description is empty,
a model proposes one from the layer's profile. The proposals are drafts: the
administrator sees them in the attribute form and nothing reaches the profile
until they save it (the S2 pattern of proposed code lists). Nothing proposed
is kept here.

The rules come from Phase 4 (memo.md): a description says what the value
*means*; it never describes joins or keys (such prose made a model guess
``gem_nr``, testplan 8.5); no units and no codes are made up (part A: units
did not matter, so none are proposed); empty when unsure.

The same call as the probe (``layer_probe.MetadataCall``): metadata only, any
enabled connection, its own entry (``kind`` ``proposal``) and the security
event ``metadata_proposed``; counts toward the request limit.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from pydantic import BaseModel

from geotandem.auth.accounts import Account
from geotandem.catalog import LayerInfo, LayerProfile
from geotandem.layer_probe import (
    MAX_TEXT,
    MetadataCall,
    ProbeConnection,
    attribute_items,
    by_name,
    connection_of,
)
from geotandem.llm import Message
from geotandem.model.errors import ActionError

MAX_LABEL = 200
"""The catalog's limit for a label."""

SYSTEM = """\
Du bekommst den Steckbrief eines Layers, so wie ihn ein Sprachmodell für eine \
Abfrage bekommt, und die Angaben, die darin fehlen. Fehlt die Beschriftung \
eines Attributs, steht im Steckbrief an ihrer Stelle sein Name.

Schlage für jede fehlende Angabe einen Text vor:
- layer_description: ein bis zwei Sätze, was ein Objekt dieses Layers ist.
- je Attribut:
  - label: eine kurze Beschriftung, wie ein Mensch das Feld nennt (höchstens \
60 Zeichen).
  - description: ein bis zwei Sätze, was der Wert bedeutet.

Regeln:
- Sag, was der Wert bedeutet, nicht wie er entstanden ist.
- Beschreibe keine Verknüpfungen, Schlüssel oder Verweise auf andere Layer.
- Erfinde keine Einheiten, keine Codes und keine Wertebereiche.
- Lass den Text leer, wenn du unsicher bist. Ein leerer Text ist besser als \
ein geratener.
- Für Angaben, die nicht fehlen, schreibe einen leeren Text.
Schreibe Deutsch in Schweizer Rechtschreibung (ss, nie ß). Antworte nur mit \
JSON nach dem Schema."""

_PROPOSAL = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "label": {"type": "string"},
        "description": {"type": "string"},
    },
    "required": ["name", "label", "description"],
    "additionalProperties": False,
}

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "layer_description": {"type": "string"},
        "attributes": {"type": "array", "items": _PROPOSAL},
    },
    "required": ["layer_description", "attributes"],
    "additionalProperties": False,
}


class Missing(BaseModel):
    """What the catalog leaves empty, of what the model sees."""

    layer_description: bool
    attributes: dict[str, list[str]]
    """Per attribute the fields to propose: ``label``, ``description``."""

    @property
    def empty(self) -> bool:
        return not self.layer_description and not self.attributes


def missing(layer: LayerInfo) -> Missing:
    """Only attributes the model sees: one hidden from it is not in the profile."""
    fields = {
        a.name: [
            f for f, value in (("label", a.label), ("description", a.description)) if not value
        ]
        for a in layer.attributes
        if a.for_model
    }
    return Missing(
        layer_description=not layer.description,
        attributes={name: f for name, f in fields.items() if f},
    )


class AttributeProposal(BaseModel):
    """A proposal for one attribute; a field is empty where the catalog has a
    value or the model proposed nothing."""

    name: str
    label: str = ""
    description: str = ""


class ProposalResult(BaseModel):
    layer: str
    layer_description: str
    """Empty unless the catalog's is empty and the model proposed one."""
    attributes: list[AttributeProposal]
    """The attributes with at least one proposal, in the profile's order."""
    connection: ProbeConnection
    proposed_at: datetime
    latency_ms: int
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


def _cut(value: Any, limit: int) -> str:
    text = " ".join(value.split()) if isinstance(value, str) else ""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def proposals(
    profile: LayerProfile, wanted: Missing, parsed: Any
) -> tuple[str, list[AttributeProposal]]:
    """The answer kept to what is missing: a text the model wrote for a field
    the catalog has is dropped, as is one for an attribute the profile lacks."""
    items = attribute_items(parsed)
    if items is None or not isinstance(parsed, dict):
        raise ActionError(
            "model_unreadable",
            "The model's answer is not the proposals' JSON.",
            http_status=502,
            cause="no list of attributes",
        )
    given, _unknown = by_name(profile, items)
    out = []
    for attribute in profile.attributes:
        item, fields = given.get(attribute.name), wanted.attributes.get(attribute.name, [])
        if item is None or not fields:
            continue
        proposal = AttributeProposal(
            name=attribute.name,
            label=_cut(item.get("label"), MAX_LABEL) if "label" in fields else "",
            description=_cut(item.get("description"), MAX_TEXT) if "description" in fields else "",
        )
        if proposal.label or proposal.description:
            out.append(proposal)
    layer_description = (
        _cut(parsed.get("layer_description"), MAX_TEXT) if wanted.layer_description else ""
    )
    return layer_description, out


def prompt(profile: LayerProfile, wanted: Missing) -> list[Message]:
    body = {
        "steckbrief": profile.model_dump(mode="json", exclude_none=True),
        "fehlt": {
            "layer_description": wanted.layer_description,
            "attributes": [{"name": n, "fields": f} for n, f in wanted.attributes.items()],
        },
    }
    return [Message("system", SYSTEM), Message("user", json.dumps(body, ensure_ascii=False))]


class Proposals(MetadataCall):
    """Propose a layer's missing metadata for one account; the route's whole work."""

    kind = "proposal"
    event = "metadata_proposed"
    schema = SCHEMA

    def run(
        self, caller: Account, profile: LayerProfile, wanted: Missing, connection_id: int | None
    ) -> ProposalResult:
        (layer_description, attributes), answer, connection = self.ask(
            caller,
            profile.name,
            connection_id,
            prompt(profile, wanted),
            lambda parsed: proposals(profile, wanted, parsed),
        )
        return ProposalResult(
            layer=profile.name,
            layer_description=layer_description,
            attributes=attributes,
            connection=connection_of(connection),
            proposed_at=self.clock(),
            latency_ms=answer.latency_ms,
            prompt_tokens=answer.prompt_tokens,
            completion_tokens=answer.completion_tokens,
        )
