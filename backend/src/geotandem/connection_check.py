"""The connection test (F-3.4, plan E2.1, C12, C13).

"Green" means the endpoint can do what the direct query (E2.3) and the tool
chain (E2.5) need, not merely that it answers: the URL is valid, the
endpoint reachable, the key accepted, the model present, JSON-schema output
parses and a tool call comes back. Each step has a stable code and the
verbatim cause, never a response body. The prompts are synthetic: no data,
no layer, nothing of the instance leaves.

The test never raises: every failure is a step.
"""

from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel

from geotandem.llm import ClientFactory, Endpoint, LLMError, Message, ToolSpec, host_of

StepName = Literal["url", "reachable", "authorised", "model", "server", "json_schema", "tool_call"]
StepStatus = Literal["ok", "failed", "skipped"]

REACH_TIMEOUT_S = 5.0
GENERATION_TIMEOUT_S = 60.0

SCHEMA = {
    "type": "object",
    "properties": {"result": {"type": "integer"}},
    "required": ["result"],
}
SCHEMA_PROMPT = 'Wie viel ist 2 + 3? Antworte nur mit JSON der Form {"result": <Zahl>}.'

WEEKDAY_TOOL = ToolSpec(
    name="weekday_of",
    description="Returns the weekday of a calendar date.",
    parameters={
        "type": "object",
        "properties": {"date": {"type": "string", "description": "ISO date, e.g. 2026-10-08"}},
        "required": ["date"],
    },
)
TOOL_PROMPT = "Welcher Wochentag ist der 2026-10-08? Benutze dafür das Werkzeug weekday_of."


class CheckStep(BaseModel):
    name: StepName
    status: StepStatus
    code: str | None = None
    """Why it failed; worded through the codes catalog like any refusal."""
    cause: str | None = None
    """Verbatim reason (exception, HTTP status), never a response body (C13)."""
    details: dict[str, Any] = {}


class CheckResult(BaseModel):
    ok: bool
    tested_at: datetime
    steps: list[CheckStep]


ORDER: tuple[StepName, ...] = (
    "url", "reachable", "authorised", "model", "server", "json_schema", "tool_call",
)  # fmt: skip


def _failed(name: StepName, exc: LLMError, unsupported: str | None = None) -> CheckStep:
    """``unsupported``: the code for a 4xx at a generation step. Earlier steps showed
    the endpoint and model work, so a refusal there means the capability is missing
    (Ollama answers 400 when a model has no tool support)."""
    code = unsupported if unsupported and exc.code == "llm_rejected" else exc.code
    return CheckStep(name=name, status="failed", code=code, cause=exc.cause or None)


def run_check(
    endpoint: Endpoint,
    make_client: ClientFactory,
    *,
    credentials_unreadable: bool = False,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> CheckResult:
    """Run the steps in order; after the first failure the rest are skipped,
    except that a missing Ollama (``server``) is no failure."""
    steps: list[CheckStep] = []

    def finish() -> CheckResult:
        done = {s.name for s in steps}
        steps.extend(CheckStep(name=n, status="skipped") for n in ORDER if n not in done)
        return CheckResult(
            ok=all(s.status != "failed" for s in steps), tested_at=now(), steps=steps
        )

    try:
        host = host_of(endpoint.base_url)
    except LLMError as exc:
        steps.append(_failed("url", exc))
        return finish()
    steps.append(CheckStep(name="url", status="ok", details={"host": host}))

    probe = make_client(replace(endpoint, timeout_s=min(endpoint.timeout_s, REACH_TIMEOUT_S)))
    try:
        try:
            offered = probe.models()
        except LLMError as exc:
            if exc.code != "llm_unauthorized":
                steps.append(_failed("reachable", exc))
                return finish()
            steps.append(CheckStep(name="reachable", status="ok"))
            steps.append(_failed("authorised", exc))
            return finish()
        steps.append(CheckStep(name="reachable", status="ok", details={"models": len(offered)}))
        if credentials_unreadable:
            steps.append(
                CheckStep(name="authorised", status="failed", code="credentials_unreadable")
            )
            return finish()
        steps.append(CheckStep(name="authorised", status="ok"))

        match = next((m for m in offered if m.id == endpoint.model), None)
        if match is None:
            # Not which ones it does offer: the listing is a response body from
            # an admin-entered address, possibly inside the network (C13).
            steps.append(
                CheckStep(
                    name="model",
                    status="failed",
                    code="llm_model_missing",
                    details={"model": endpoint.model},
                )
            )
            return finish()
        found = {k: v for k, v in (("digest", match.digest), ("size", match.size)) if v}
        steps.append(CheckStep(name="model", status="ok", details=found))

        try:
            version = probe.server_version()
        except LLMError:
            version = None
        steps.append(
            CheckStep(name="server", status="ok", details={"ollama": version})
            if version
            else CheckStep(name="server", status="skipped")
        )
    finally:
        probe.close()

    generator = make_client(
        replace(endpoint, timeout_s=min(endpoint.timeout_s, GENERATION_TIMEOUT_S))
    )
    try:
        try:
            answer = generator.complete([Message("user", SCHEMA_PROMPT)], schema=SCHEMA)
        except LLMError as exc:
            steps.append(_failed("json_schema", exc, "llm_schema_unsupported"))
            return finish()
        result = answer.parsed.get("result") if isinstance(answer.parsed, dict) else None
        if not isinstance(result, int) or isinstance(result, bool):
            steps.append(
                CheckStep(
                    name="json_schema",
                    status="failed",
                    code="llm_schema_unsupported",
                    cause=answer.parse_error,
                    details={"latency_ms": answer.latency_ms},
                )
            )
            return finish()
        steps.append(
            CheckStep(name="json_schema", status="ok", details={"latency_ms": answer.latency_ms})
        )

        try:
            answer = generator.complete([Message("user", TOOL_PROMPT)], tools=[WEEKDAY_TOOL])
        except LLMError as exc:
            steps.append(_failed("tool_call", exc, "llm_tools_unsupported"))
            return finish()
        called = [c for c in answer.tool_calls if c.name == WEEKDAY_TOOL.name and c.parsed]
        steps.append(
            CheckStep(name="tool_call", status="ok", details={"latency_ms": answer.latency_ms})
            if called
            else CheckStep(
                name="tool_call",
                status="failed",
                code="llm_tools_unsupported",
                details={"latency_ms": answer.latency_ms},
            )
        )
    finally:
        generator.close()
    return finish()
