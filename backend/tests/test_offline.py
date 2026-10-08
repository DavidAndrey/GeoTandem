"""F-9.1: with only local model connections, nothing leaves the host (plan WP59).

The guard sits at the socket layer, below every HTTP library: a name lookup
or a connection to anything but loopback is refused and recorded. A
positive control shows the guard catches an attempt; then the application
is driven through setup, connections, a real connection test against a fake
Ollama on 127.0.0.1, the account's choice and a query.
"""

import json
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import httpx
import httpx2
import pytest
from api_helpers import sign_in_as

LOOPBACK = {"127.0.0.1", "::1", "localhost"}


class FakeOllama(BaseHTTPRequestHandler):
    def _send(self, body: Any) -> None:
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/v1/models":
            self._send({"object": "list", "data": [{"id": "qwen3:8b", "object": "model"}]})
        elif self.path == "/api/version":
            self._send({"version": "0.12.3"})
        elif self.path == "/api/tags":
            self._send({"models": [{"name": "qwen3:8b", "digest": "sha256:abc", "size": 1}]})
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        message: dict[str, Any] = {"role": "assistant", "content": '{"result": 5}'}
        if "tools" in request:
            call = {"name": "weekday_of", "arguments": '{"date": "2026-10-08"}'}
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [{"id": "c1", "type": "function", "function": call}],
            }
        self._send(
            {
                "id": "x",
                "object": "chat.completion",
                "created": 0,
                "model": "qwen3:8b",
                "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
            }
        )

    def log_message(self, *_: Any) -> None:
        pass


@pytest.fixture
def ollama() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/v1"
    server.shutdown()


@pytest.fixture
def outbound(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """Every host the process looks up or connects to; anything not loopback is refused."""
    seen: list[str] = []
    lookup = socket.getaddrinfo
    connect = socket.socket.connect

    def guarded_lookup(host: Any, *args: Any, **kwargs: Any) -> Any:
        seen.append(str(host))
        if str(host) not in LOOPBACK:
            raise OSError(f"F-9.1: lookup of {host} refused")
        return lookup(host, *args, **kwargs)

    def guarded_connect(self: socket.socket, address: Any) -> Any:
        host = str(address[0]) if isinstance(address, tuple) else str(address)
        seen.append(host)
        if self.family in (socket.AF_INET, socket.AF_INET6) and host not in LOOPBACK:
            raise OSError(f"F-9.1: connection to {host} refused")
        return connect(self, address)

    monkeypatch.setattr(socket, "getaddrinfo", guarded_lookup)
    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    yield seen


def outside(seen: list[str]) -> list[str]:
    return [host for host in seen if host not in LOOPBACK]


def test_the_guard_catches_an_attempt(outbound: list[str]) -> None:
    """Positive control: without it, the test below would prove nothing."""
    with pytest.raises(httpx2.ConnectError), httpx2.Client(trust_env=False) as client:
        client.get("https://api.openai.com/v1/models")
    assert outside(outbound) == ["api.openai.com"]


async def test_with_local_connections_nothing_leaves(
    client: httpx.AsyncClient, ollama: str, outbound: list[str]
) -> None:
    created = await client.post(
        "/api/admin/llm/connections",
        json={"name": "Ollama", "base_url": ollama, "model": "qwen3:8b", "enabled": True},
    )
    assert created.status_code == 201, created.text
    tested = await client.post(f"/api/admin/llm/connections/{created.json()['id']}/test")
    assert tested.json()["ok"] is True, tested.json()

    await sign_in_as(client, "m.keller")
    options = (await client.get("/api/llm/options")).json()
    assert options["active_connection_id"] == created.json()["id"]
    assert (await client.get("/api/config/map")).status_code == 200
    assert (await client.get("/api/layers")).status_code == 200

    assert "127.0.0.1" in outbound  # the guard saw the connection test's traffic
    assert outside(outbound) == []
