"""The comprehension probe of a layer (plan-attribute-metadata C).

Through the API, the model faked behind the client factory: the probe sends
the layer's profile and nothing else, lays the answer over the profile's
attributes, is its own entry and security event (not a model action), and
counts toward the connection's request limit.
"""

import json
from typing import Any

import httpx
import pytest
from api_helpers import Events
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from geotandem.db.orm import MetadataProbe, ModelAction
from geotandem.llm import Completion, Endpoint, LLMError
from geotandem.llm.fake import FakeLLMClient

CONNECTIONS = "/api/admin/llm/connections"
LOCAL = {"base_url": "http://127.0.0.1:11434/v1", "model": "qwen3:8b"}
PROBE = "/api/admin/layers/schulen/probe"


class Model:
    """The client factory: one fake for every endpoint, which it remembers."""

    def __init__(self) -> None:
        self.fake = FakeLLMClient()
        self.endpoints: list[Endpoint] = []

    def __call__(self, endpoint: Endpoint) -> FakeLLMClient:
        self.endpoints.append(endpoint)
        return self.fake

    def answer(self, parsed: Any, *, finish_reason: str = "stop") -> None:
        self.fake.script.append(
            Completion(
                text=json.dumps(parsed),
                parsed=parsed,
                finish_reason=finish_reason,
                latency_ms=1200,
                prompt_tokens=900,
                completion_tokens=150,
            )
        )


async def connect(client: httpx.AsyncClient, name: str = "Lokal", **fields: Any) -> int:
    response = await client.post(
        CONNECTIONS,
        json={"name": name, **LOCAL, "enabled": True, "is_default": True, **fields},
    )
    assert response.status_code == 201, response.text
    connection_id: int = response.json()["id"]
    return connection_id


@pytest.fixture
async def model(client: httpx.AsyncClient, app: FastAPI) -> Model:
    fake = Model()
    app.state.geotandem.client_factory = fake
    return fake


async def profile_names(client: httpx.AsyncClient) -> list[str]:
    response = await client.get("/api/admin/layers/schulen/profile")
    assert response.status_code == 200, response.text
    return [a["name"] for a in response.json()["attributes"]]


def probes(app: FastAPI) -> list[MetadataProbe]:
    with Session(app.state.geotandem.backend.engine) as db:
        return list(db.scalars(select(MetadataProbe).order_by(MetadataProbe.id)))


def actions(app: FastAPI) -> int:
    with Session(app.state.geotandem.backend.engine) as db:
        return db.scalar(select(func.count()).select_from(ModelAction)) or 0


def reading(name: str, **fields: Any) -> dict[str, Any]:
    return {"name": name, "meaning": "", "unit": "", "values": "", "identifier": False, **fields}


async def test_the_probe_sends_the_profile_and_lays_the_answer_over_it(
    client: httpx.AsyncClient, app: FastAPI, model: Model, events: Events
) -> None:
    await connect(client)
    names = await profile_names(client)
    first, second = names[0], names[1]
    model.answer(
        {
            "layer": "Eine Schule.",
            "attributes": [
                reading(second, meaning="Zweites.", unit="Personen"),
                reading(first, meaning="Erstes.", identifier=True),
                reading(first, meaning="Doppelt, übergangen."),
                reading("erfunden", meaning="Gibt es nicht."),
            ],
        }
    )

    response = await client.post(PROBE, json={})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["meaning"] == "Eine Schule."
    assert [a["name"] for a in body["attributes"]] == names
    assert body["attributes"][0] == {
        "name": first,
        "answered": True,
        "meaning": "Erstes.",
        "unit": "",
        "values": "",
        "identifier": True,
    }
    assert body["attributes"][1]["unit"] == "Personen"
    assert all(not a["answered"] for a in body["attributes"][2:])
    assert body["unknown"] == ["erfunden"]
    assert body["connection"]["name"] == "Lokal"
    assert (body["prompt_tokens"], body["completion_tokens"]) == (900, 150)

    # What left: the system rules and the layer's profile as the model sees it.
    (call,) = model.fake.calls
    system, user = call.messages
    assert system.role == "system" and user.role == "user"
    profile = (await client.get("/api/admin/layers/schulen/profile")).json()
    sent = json.loads(user.content)
    assert sent["name"] == "schulen"
    assert [a["name"] for a in sent["attributes"]] == [a["name"] for a in profile["attributes"]]
    assert call.schema is not None and call.schema["required"] == ["layer", "attributes"]

    # Its own entry and event, not a model action.
    (row,) = probes(app)
    assert (row.layer, row.account, row.status) == ("schulen", "admin", "ok")
    assert (row.prompt_tokens, row.completion_tokens, row.latency_ms) == (900, 150, 1200)
    assert actions(app) == 0
    (event,) = [e for e in events if e["event"] == "layer_probed"]
    assert event["ok"] is True and event["layer"] == "schulen"
    assert event["prompt_tokens"] == 900


async def test_a_long_text_is_cut(client: httpx.AsyncClient, model: Model) -> None:
    await connect(client)
    first = (await profile_names(client))[0]
    model.answer({"layer": "x" * 5000, "attributes": [reading(first, meaning="y" * 5000)]})

    body = (await client.post(PROBE, json={})).json()

    assert len(body["meaning"]) == 400 and body["meaning"].endswith("…")
    assert len(body["attributes"][0]["meaning"]) == 400


async def test_the_probe_counts_toward_the_request_limit(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    await connect(client, request_limit_enabled=True, request_limit_per_day=1)
    model.answer({"layer": "", "attributes": []})

    assert (await client.post(PROBE, json={})).status_code == 200
    refused = await client.post(PROBE, json={})

    assert refused.status_code == 429
    assert refused.json()["code"] == "quota_exceeded"
    assert len(probes(app)) == 1 and len(model.fake.calls) == 1
    # A prompt is refused too: the probe used the day's one request.
    prompt = await client.post("/api/model/prompt", json={"text": "Wie viele Schulen?"})
    assert (prompt.status_code, prompt.json()["code"]) == (429, "quota_exceeded")


async def test_a_chosen_connection_is_used_a_disabled_one_refused(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    await connect(client)
    other = await connect(client, "Zweite", is_default=False, temperature=0.7)
    off = await connect(client, "Aus", is_default=False, enabled=False)
    model.answer({"layer": "", "attributes": []})

    chosen = await client.post(PROBE, json={"connection_id": other})
    refused = await client.post(PROBE, json={"connection_id": off})

    assert chosen.status_code == 200 and chosen.json()["connection"]["name"] == "Zweite"
    assert model.endpoints[0].temperature == 0.7
    assert (refused.status_code, refused.json()["code"]) == (409, "connection_not_available")
    assert len(probes(app)) == 1


async def test_without_a_connection_nothing_is_asked(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    response = await client.post(PROBE, json={})

    assert (response.status_code, response.json()["code"]) == (409, "connection_not_available")
    assert probes(app) == [] and model.fake.calls == []


@pytest.mark.parametrize(
    ("script", "code"),
    [
        (LLMError("llm_timeout", "No answer.", cause="deadline"), "llm_timeout"),
        ({"not": "the probe"}, "model_unreadable"),
        ("truncated", "model_truncated"),
    ],
)
async def test_a_failed_probe_says_why_and_is_kept_failed(
    client: httpx.AsyncClient,
    app: FastAPI,
    model: Model,
    events: Events,
    script: Any,
    code: str,
) -> None:
    await connect(client)
    if isinstance(script, LLMError):
        model.fake.script.append(script)
    elif script == "truncated":
        model.answer({"layer": "", "attributes": []}, finish_reason="length")
    else:
        model.answer(script)

    response = await client.post(PROBE, json={})

    assert (response.status_code, response.json()["code"]) == (502, code)
    (row,) = probes(app)
    assert (row.status, row.error_code) == ("failed", code)
    (event,) = [e for e in events if e["event"] == "layer_probed"]
    assert event["ok"] is False and event["code"] == code


async def test_a_layer_not_for_the_model_is_not_probed(
    client: httpx.AsyncClient, app: FastAPI, model: Model
) -> None:
    await connect(client)
    hidden = await client.patch("/api/admin/layers/schulen", json={"for_model": False})
    assert hidden.status_code == 200, hidden.text

    response = await client.post(PROBE, json={})

    assert (response.status_code, response.json()["code"]) == (400, "layer_not_for_model")
    assert probes(app) == [] and model.fake.calls == []


async def test_a_fenced_answer_without_names_is_read_by_place(
    client: httpx.AsyncClient, model: Model
) -> None:
    """Anthropic's compatibility gets the schema only as text: the answer may be
    fenced, and its readings may come without names but in the profile's order."""
    await connect(client)
    names = await profile_names(client)
    items = [
        {"meaning": f"Feld {i}.", "unit": "", "values": "", "identifier": False}
        for i in range(len(names))
    ]
    text = "```json\n" + json.dumps({"layer": "Schule.", "attributes": items}) + "\n```"
    model.fake.script.append(Completion(text=text, parsed=None, finish_reason="stop"))

    body = (await client.post(PROBE, json={})).json()

    assert body["meaning"] == "Schule."
    assert [a["meaning"] for a in body["attributes"]] == [f"Feld {i}." for i in range(len(names))]


async def test_readings_without_names_are_not_guessed_when_some_are_missing(
    client: httpx.AsyncClient, model: Model
) -> None:
    await connect(client)
    model.answer({"layer": "", "attributes": [{"meaning": "Wessen?"}]})

    body = (await client.post(PROBE, json={})).json()

    assert not any(a["answered"] for a in body["attributes"])
