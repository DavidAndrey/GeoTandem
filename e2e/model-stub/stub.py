"""An OpenAI-compatible model stub for the acceptance tests (plan E2.3-E2.6, WP69).

Scripted from the contract fixture ``schema/model-cases/v1.json``; standard
library only. ``scripts/gate.sh`` starts it on the gate's internal network,
next to the application, as the only host the application can reach.

Routes, each also under a prefix ``/case/<id>`` (see below):

- ``GET /v1/models``: one model, ``STUB_MODEL`` (default ``stub-model``).
- ``POST /v1/chat/completions``:
  - the connection test's probes (F-3.4) are answered so the test is green:
    a JSON-schema request whose schema asks for ``result`` gets
    ``{"result": 5}``; a request offering tools gets a call of its first tool;
  - any other request is a prompt: the case whose ``prompt`` is the question
    of the last user message (the text after the last ``Frage: ``, or the
    whole message, as ``geotandem.model.prompt`` writes it) answers with its
    ``answer`` as JSON, or its ``raw`` text verbatim; an unknown prompt gets a
    ``cannot_answer``;
  - a case with ``llm_error`` fails: ``llm_unreachable`` closes the connection
    without a response (the client's transport error, as for a dead host;
    a 503 would read ``llm_server_error``), ``llm_timeout`` holds the answer
    for ``STUB_SLOW_S`` seconds (default 30): the test gives that connection
    a short time limit (``timeout_s``), so the client gives up first.
- ``GET /_requests``: every request body received so far, oldest first, for
  privacy assertions; ``DELETE /_requests`` empties the list.
- ``PUT /_cases/<id>``: adds (or replaces) case ``<id>``, a JSON object shaped
  as the fixture's cases, for ``/case/<id>``: a test scripts a sequence the
  fixture has no case for (E2.5: a re-plan that brings a plan the run
  finishes). Kept until the stub stops.
- ``POST /_release``: ends every hold under way (``/hold/<seconds>``, below)
  at once.

Several cases share a prompt ("Primarschulen in Köniz": unreadable,
unreachable, timeout, ...). By prompt alone the first direct case in fixture
order answers. A connection whose base URL is ``http://<host>/case/<id>/v1``
gets case ``<id>`` for every prompt, whatever its text: that is how a test
picks a failure without a prompt of its own.

A case with a ``replan`` answers a request that continues a conversation
with the model (one with an assistant turn in it: a tool chain's re-plan, P4)
with that, and the first call with its ``answer``; without one, ``answer``
answers both.

A further prefix ``/hold/<seconds>`` (after ``/case/<id>``, if any) holds the
answer to every request that continues a conversation with the model: a tool
chain's re-plan (P4), a follow-up (P6). The first call answers at once. That
is how a test keeps a chain ``running`` long enough to abort it (E2.5): its
steps take milliseconds, its re-plan waits for the model, until ``<seconds>``
are over or the test ends the hold (``POST /_release``), whichever is first.
A release counts for the requests received before it only.

    python stub.py [--port 8080] [--cases /cases/v1.json]
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL = os.environ.get("STUB_MODEL", "stub-model")
SLOW_S = float(os.environ.get("STUB_SLOW_S", "30"))
CASE_PREFIX = re.compile(r"^/case/([A-Za-z0-9_-]+)(/.*)$")
HOLD_PREFIX = re.compile(r"^/hold/(\d{1,3})(/.*)$")
NO_ANSWER = {
    "kind": "cannot_answer",
    "explanation": "Für diese Frage hat der Stub keine Antwort.",
    "missing": [],
}


class Stub:
    def __init__(self, cases: list[dict[str, Any]]) -> None:
        self.cases = {c["id"]: c for c in cases}
        # Direct cases first: a prompt shared with a chain case answers directly.
        self.by_order = sorted(cases, key=lambda c: c.get("approach") != "direct")
        self.requests: list[Any] = []
        self.lock = threading.Lock()
        # Each release starts a new generation; a hold waits for the next one.
        self.released = threading.Condition()
        self.generation = 0

    def record(self, path: str, body: Any) -> None:
        with self.lock:
            self.requests.append({"path": path, "body": body})

    def add(self, case_id: str, case: dict[str, Any]) -> None:
        with self.lock:
            self.cases[case_id] = {**case, "id": case_id}

    def hold(self, seconds: float, since: int) -> None:
        """Waits ``seconds``, or until a release after generation ``since``."""
        with self.released:
            self.released.wait_for(lambda: self.generation != since, timeout=seconds)

    def release(self) -> None:
        with self.released:
            self.generation += 1
            self.released.notify_all()

    def case_for(self, question: str, forced: str | None) -> dict[str, Any] | None:
        if forced is not None:
            with self.lock:
                return self.cases.get(forced)
        return next((c for c in self.by_order if c.get("prompt", "").strip() == question), None)


def question_of(messages: list[dict[str, Any]]) -> str:
    """The user's question: the last user message, after its last ``Frage: ``."""
    users = [m for m in messages if m.get("role") == "user"]
    content = users[-1].get("content", "") if users else ""
    if not isinstance(content, str):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    marker = content.rfind("Frage: ")
    return (content[marker + len("Frage: ") :] if marker >= 0 else content).strip()


def continues(messages: list[dict[str, Any]]) -> bool:
    """Whether the request goes on from an answer of the model's (a re-plan)."""
    return any(m.get("role") == "assistant" for m in messages)


def is_schema_probe(body: dict[str, Any]) -> bool:
    schema = ((body.get("response_format") or {}).get("json_schema") or {}).get("schema") or {}
    return schema.get("required") == ["result"]


def completion(content: str | None, tool_calls: list[dict[str, Any]] | None = None) -> bytes:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return json.dumps(
        {
            "id": f"stub-{time.time_ns()}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": MODEL,
            "choices": [
                {
                    "index": 0,
                    "message": message,
                    "finish_reason": "tool_calls" if tool_calls else "stop",
                }
            ],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
    ).encode()


class Handler(BaseHTTPRequestHandler):
    stub: Stub
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"stub: {self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")

    def _send(self, status: int, payload: bytes, kind: str = "application/json") -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass  # a slow answer whose client gave up (llm_timeout)

    def _json(self, status: int, value: Any) -> None:
        self._send(status, json.dumps(value).encode())

    def _route(self) -> tuple[str | None, int, str]:
        """The forced case, the seconds a continued conversation is held, the path."""
        forced, hold, path = None, 0, self.path
        if match := CASE_PREFIX.match(path):
            forced, path = match.group(1), match.group(2)
        if match := HOLD_PREFIX.match(path):
            hold, path = int(match.group(1)), match.group(2)
        return forced, hold, path

    def do_GET(self) -> None:
        path = self._route()[2]
        if path == "/v1/models":
            model = {"id": MODEL, "object": "model", "created": 0, "owned_by": "stub"}
            self._json(200, {"object": "list", "data": [model]})
        elif path == "/_requests":
            with self.stub.lock:
                self._json(200, list(self.stub.requests))
        elif path == "/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_DELETE(self) -> None:
        if self._route()[2] != "/_requests":
            self._json(404, {"error": {"message": "not found"}})
            return
        with self.stub.lock:
            self.stub.requests.clear()
        self._send(204, b"")

    def _body(self) -> Any:
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return raw.decode("utf-8", "replace")

    def do_PUT(self) -> None:
        match = re.fullmatch(r"/_cases/([A-Za-z0-9_-]+)", self.path)
        body = self._body()
        if match is None or not isinstance(body, dict):
            self._json(404, {"error": {"message": "not found"}})
            return
        self.stub.add(match.group(1), body)
        self._send(204, b"")

    def do_POST(self) -> None:
        # Before the request is logged: a release the test sends once it has
        # seen this request in the log counts for it.
        since = self.stub.generation
        forced, hold, path = self._route()
        body = self._body()
        if path == "/_release":
            self.stub.release()
            self._send(204, b"")
            return
        self.stub.record(self.path, body)
        if path != "/v1/chat/completions" or not isinstance(body, dict):
            self._json(404, {"error": {"message": "not found"}})
            return

        # The connection test (geotandem.connection_check), whatever the case.
        if is_schema_probe(body):
            self._send(200, completion(json.dumps({"result": 5})))
            return
        if body.get("tools"):
            tool = body["tools"][0]["function"]["name"]
            call = {
                "id": "call-1",
                "type": "function",
                "function": {"name": tool, "arguments": json.dumps({"date": "2026-10-08"})},
            }
            self._send(200, completion(None, [call]))
            return

        messages = body.get("messages", [])
        if hold and continues(messages):
            self.stub.hold(hold, since)  # a re-plan waits; the chain stays running meanwhile
        case = self.stub.case_for(question_of(messages), forced) or {}
        error = case.get("llm_error")
        if error == "llm_unreachable":
            # No status line at all: the client's transport fails, as for a dead host.
            self.close_connection = True
            return
        if error == "llm_timeout":
            time.sleep(SLOW_S)  # then answers like a case without an answer
        if "raw" in case:
            self._send(200, completion(case["raw"]))
            return
        replan = case.get("replan") if continues(messages) else None
        answer = replan or case.get("answer") or NO_ANSWER
        self._send(200, completion(json.dumps(answer, ensure_ascii=False)))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=int(os.environ.get("STUB_PORT", "8080")))
    parser.add_argument("--cases", default=os.environ.get("STUB_CASES", "/cases/v1.json"))
    args = parser.parse_args()
    with open(args.cases, encoding="utf-8") as file:
        Handler.stub = Stub(json.load(file)["cases"])
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    server.daemon_threads = True
    print(f"model stub on :{args.port}, {len(Handler.stub.cases)} cases", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
