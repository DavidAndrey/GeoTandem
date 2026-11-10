"""Proposed metadata of a layer (plan-attribute-metadata D).

Through the API, the model faked behind the client factory: proposals are asked
only for what the catalog leaves empty, kept to it, never saved, and the call
is the probe's (its own entry of kind ``proposal``, an event, the limit).
"""

import json
from typing import Any

import httpx
import pytest
from api_helpers import Events
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.orm import Session

from geotandem.db.orm import MetadataProbe
from geotandem.llm import Completion
from geotandem.llm.fake import FakeLLMClient

CONNECTIONS = "/api/admin/llm/connections"
LAYER = "/api/admin/layers/schulen"
PROPOSE = f"{LAYER}/proposals"


class Model:
    def __init__(self) -> None:
        self.fake = FakeLLMClient()

    def __call__(self, endpoint: Any) -> FakeLLMClient:
        return self.fake

    def answer(self, parsed: Any) -> None:
        self.fake.script.append(
            Completion(
                text=json.dumps(parsed),
                parsed=parsed,
                finish_reason="stop",
                latency_ms=800,
                prompt_tokens=700,
                completion_tokens=90,
            )
        )


@pytest.fixture
async def model(client: httpx.AsyncClient, app: FastAPI) -> Model:
    fake = Model()
    app.state.geotandem.client_factory = fake
    response = await client.post(
        CONNECTIONS,
        json={
            "name": "Lokal",
            "base_url": "http://127.0.0.1:11434/v1",
            "model": "qwen3:8b",
            "enabled": True,
            "is_default": True,
        },
    )
    assert response.status_code == 201, response.text
    return fake


async def curate(
    client: httpx.AsyncClient, layer_description: str, fields: dict[str, tuple[str, str]]
) -> list[str]:
    """Set the layer's description and each attribute's label and description;
    attributes not named get both filled. Returns the attribute names."""
    layer = (await client.get("/api/layers/schulen")).json()
    patched = await client.patch(
        LAYER, json={"title": layer["title"], "description": layer_description}
    )
    assert patched.status_code == 200, patched.text
    names = [a["name"] for a in layer["attributes"]]
    for name in names:
        label, description = fields.get(name, ("Beschriftung", "Beschreibung."))
        response = await client.patch(
            f"{LAYER}/attributes/{name}", json={"label": label, "description": description}
        )
        assert response.status_code == 200, response.text
    return names


def entries(app: FastAPI) -> list[MetadataProbe]:
    with Session(app.state.geotandem.backend.engine) as db:
        return list(db.scalars(select(MetadataProbe)))


async def test_proposals_cover_only_what_is_empty_and_are_not_saved(
    client: httpx.AsyncClient, app: FastAPI, model: Model, events: Events
) -> None:
    names = await curate(client, "", {})
    first, second, third = names[0], names[1], names[2]
    await curate(client, "", {first: ("", ""), second: ("Zweites", "")})
    model.answer(
        {
            "layer_description": "Eine Schule im Kanton.",
            "attributes": [
                {"name": first, "label": "Erstes", "description": "Was das erste bedeutet."},
                # The label is curated: the proposed one is dropped.
                {"name": second, "label": "Anders", "description": "Das zweite."},
                # Nothing is missing here: dropped.
                {"name": third, "label": "Drittes", "description": "Das dritte."},
                {"name": "erfunden", "label": "Gibt", "description": "es nicht."},
            ],
        }
    )

    response = await client.post(PROPOSE, json={})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["layer_description"] == "Eine Schule im Kanton."
    assert body["attributes"] == [
        {"name": first, "label": "Erstes", "description": "Was das erste bedeutet."},
        {"name": second, "label": "", "description": "Das zweite."},
    ]
    assert (body["prompt_tokens"], body["completion_tokens"]) == (700, 90)

    # The model is told what is missing, beside the profile.
    (call,) = model.fake.calls
    sent = json.loads(call.messages[1].content)
    assert sent["steckbrief"]["name"] == "schulen"
    assert sent["fehlt"] == {
        "layer_description": True,
        "attributes": [
            {"name": first, "fields": ["label", "description"]},
            {"name": second, "fields": ["description"]},
        ],
    }
    assert call.schema is not None and "layer_description" in call.schema["required"]

    # Drafts only: the catalog is unchanged.
    layer = (await client.get("/api/layers/schulen")).json()
    assert layer["description"] == ""
    assert layer["attributes"][0]["label"] == ""

    (row,) = entries(app)
    assert (row.kind, row.status, row.layer) == ("proposal", "ok", "schulen")
    (event,) = [e for e in events if e["event"] == "metadata_proposed"]
    assert event["ok"] is True and event["completion_tokens"] == 90


async def test_a_complete_layer_asks_nothing(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    await curate(client, "Schulen.", {})

    response = await client.post(PROPOSE, json={})

    assert (response.status_code, response.json()["code"]) == (400, "nothing_to_propose")
    assert entries(app) == [] and model.fake.calls == []


async def test_an_attribute_hidden_from_the_model_is_not_proposed_for(
    client: httpx.AsyncClient, model: Model
) -> None:
    names = await curate(client, "Schulen.", {})
    hidden = await client.patch(
        f"{LAYER}/attributes/{names[0]}", json={"label": "", "for_model": False}
    )
    assert hidden.status_code == 200, hidden.text

    response = await client.post(PROPOSE, json={})

    assert (response.status_code, response.json()["code"]) == (400, "nothing_to_propose")


async def test_long_and_unsure_texts(client: httpx.AsyncClient, model: Model) -> None:
    names = await curate(client, "Schulen.", {})
    await curate(client, "Schulen.", {names[0]: ("", ""), names[1]: ("", "")})
    model.answer(
        {
            "layer_description": "Nicht gefragt.",
            "attributes": [
                {"name": names[0], "label": "x" * 500, "description": "  zwei\n Zeilen "},
                {"name": names[1], "label": "", "description": ""},
            ],
        }
    )

    body = (await client.post(PROPOSE, json={})).json()

    # The layer description is curated; an attribute left empty is not listed.
    assert body["layer_description"] == ""
    (proposal,) = body["attributes"]
    assert len(proposal["label"]) == 200 and proposal["label"].endswith("…")
    assert proposal["description"] == "zwei Zeilen"


async def test_proposals_count_toward_the_limit_with_probes(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    connection = (await client.get(CONNECTIONS)).json()[0]
    limited = await client.patch(
        f"{CONNECTIONS}/{connection['id']}",
        json={"request_limit_enabled": True, "request_limit_per_day": 1},
    )
    assert limited.status_code == 200, limited.text
    await curate(client, "", {})
    model.answer({"layer_description": "Schulen.", "attributes": []})

    assert (await client.post(PROPOSE, json={})).status_code == 200
    probe = await client.post(f"{LAYER}/probe", json={})

    assert (probe.status_code, probe.json()["code"]) == (429, "quota_exceeded")
    assert [row.kind for row in entries(app)] == ["proposal"]


async def test_an_unreadable_answer_is_kept_failed(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    await curate(client, "", {})
    model.answer({"not": "proposals"})

    response = await client.post(PROPOSE, json={})

    assert (response.status_code, response.json()["code"]) == (502, "model_unreadable")
    (row,) = entries(app)
    assert (row.kind, row.status, row.error_code) == ("proposal", "failed", "model_unreadable")


async def test_proposals_keyed_by_name_and_fenced_are_read(
    client: httpx.AsyncClient, model: Model
) -> None:
    """Anthropic's compatibility gets the schema only as text: Haiku 5.5 fenced the
    answer and keyed the attributes by name instead of listing them."""
    names = await curate(client, "Schulen.", {})
    await curate(client, "Schulen.", {names[0]: ("", "")})
    answer = {
        "layer_description": "",
        "attributes": {names[0]: {"label": "Erstes", "description": "Das erste."}},
    }
    text = "```json\n" + json.dumps(answer) + "\n```"
    model.fake.script.append(Completion(text=text, parsed=None, finish_reason="stop"))

    body = (await client.post(PROPOSE, json={})).json()

    assert body["attributes"] == [
        {"name": names[0], "label": "Erstes", "description": "Das erste."}
    ]
