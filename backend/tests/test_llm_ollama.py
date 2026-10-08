"""Against a real Ollama, opt-in (plan WP56): ``uv run pytest -m llm``.

Outside ``make gate``: it needs a running Ollama and a pulled model, named in
``GEOTANDEM_TEST_LLM_MODEL`` (e.g. ``qwen3:8b``); the address defaults to
``http://127.0.0.1:11434/v1`` (``GEOTANDEM_TEST_LLM_URL``).
"""

import os

import pytest

from geotandem.connection_check import run_check
from geotandem.llm import Endpoint, Message, ToolSpec
from geotandem.llm.openai_compat import OpenAICompatClient

pytestmark = pytest.mark.llm

MODEL = os.environ.get("GEOTANDEM_TEST_LLM_MODEL", "")
URL = os.environ.get("GEOTANDEM_TEST_LLM_URL", "http://127.0.0.1:11434/v1")


@pytest.fixture
def llm() -> OpenAICompatClient:
    if not MODEL:
        pytest.skip("GEOTANDEM_TEST_LLM_MODEL is not set")
    return OpenAICompatClient(Endpoint(base_url=URL, model=MODEL, reasoning_effort="none"))


def test_the_model_is_offered_with_its_digest(llm: OpenAICompatClient) -> None:
    assert llm.server_version()
    [info] = [m for m in llm.models() if m.id == MODEL]
    assert info.digest and info.size


def test_schema_output_parses(llm: OpenAICompatClient) -> None:
    schema = {
        "type": "object",
        "properties": {"count": {"type": "integer"}},
        "required": ["count"],
    }
    answer = llm.complete(
        [Message("user", "Wie viele Tage hat eine Woche? Antworte als JSON.")], schema=schema
    )
    assert answer.parse_error is None, answer.text
    assert answer.parsed == {"count": 7}
    assert answer.prompt_tokens and answer.completion_tokens


def test_a_tool_is_called(llm: OpenAICompatClient) -> None:
    tool = ToolSpec(
        "describe_layer",
        "Describe one layer of the map.",
        {
            "type": "object",
            "properties": {"layer": {"type": "string"}},
            "required": ["layer"],
        },
    )
    answer = llm.complete(
        [Message("user", "Beschreibe den Layer 'schulen'. Nutze das Werkzeug.")], tools=[tool]
    )
    assert [(c.name, c.parsed) for c in answer.tool_calls] == [
        ("describe_layer", {"layer": "schulen"})
    ]


def test_the_connection_test_is_green() -> None:
    if not MODEL:
        pytest.skip("GEOTANDEM_TEST_LLM_MODEL is not set")
    endpoint = Endpoint(base_url=URL, model=MODEL, reasoning_effort="none")
    result = run_check(endpoint, OpenAICompatClient)
    assert result.ok, [(s.name, s.status, s.code, s.cause) for s in result.steps]
