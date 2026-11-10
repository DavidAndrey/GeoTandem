"""The comprehension probe of a layer (plan-attribute-metadata C).

What does a model read from a layer's metadata? It gets the layer's profile,
exactly as a query sends it (F-2.9), and says per attribute what it takes the
attribute to mean, its unit, its plausible values and whether it identifies
something. The administrator reads that beside the curated metadata and sees
where they part. Nothing is graded and the answer is not kept.

Metadata only, no content: allowed on an external connection without data
release, as every query's profile is. Not a model action (Q5): its own entry
(``MetadataProbe``) and a security event, and the connection's request limit
counts it (P5). ``MetadataCall`` is that call, shared with the proposals of
missing metadata (``layer_proposals``, part D).
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from datetime import datetime, tzinfo
from typing import Any, TypeVar

from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.orm import Session

from geotandem import audit
from geotandem.auth.accounts import Account
from geotandem.catalog import LayerProfile
from geotandem.connections import ConnectionInfo, ConnectionProblem, Connections
from geotandem.db.orm import MetadataProbe
from geotandem.llm import ClientFactory, Completion, Endpoint, LLMError, Message
from geotandem.llm.hosts import Locality
from geotandem.model.errors import ActionError
from geotandem.model.record.store import utc_now
from geotandem.model.result import loose_json
from geotandem.model.service import ModelCalls, day_start, within_limit

log = logging.getLogger(__name__)

T = TypeVar("T")

MAX_TEXT = 400
"""A reading's text is cut here: it is shown, never stored, and a model that
runs on must not fill the page."""

SYSTEM = """\
Du bekommst den Steckbrief eines Layers, so wie ihn ein Sprachmodell für eine \
Abfrage bekommt: Name, Titel, Beschreibung und je Attribut Name, Datentyp und, \
soweit vorhanden, Beschriftung, Beschreibung, Einheit, Codeliste, Wertebereich \
und Verweis.

Sag, was du daraus verstehst, ohne etwas dazuzuerfinden:
- layer: in einem Satz, was ein Objekt dieses Layers ist.
- je Attribut, in der Reihenfolge des Steckbriefs:
  - meaning: in einem Satz, was der Wert bedeutet.
  - unit: die Einheit, in der du den Wert lesen würdest; leer, wenn er keine hat \
oder du sie nicht erkennst.
  - values: welche Werte du erwartest (Bereich, Beispiele, Codes); leer, wenn du \
es nicht weisst.
  - identifier: true, wenn der Wert ein Objekt kennzeichnet (Nummer, Schlüssel), \
statt etwas zu messen oder zu beschreiben.
Schreibe Deutsch. Antworte nur mit JSON nach dem Schema."""

_READING = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "meaning": {"type": "string"},
        "unit": {"type": "string"},
        "values": {"type": "string"},
        "identifier": {"type": "boolean"},
    },
    "required": ["name", "meaning", "unit", "values", "identifier"],
    "additionalProperties": False,
}

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "layer": {"type": "string"},
        "attributes": {"type": "array", "items": _READING},
    },
    "required": ["layer", "attributes"],
    "additionalProperties": False,
}


class ProbeRequest(BaseModel):
    connection_id: int | None = Field(
        default=None, description="None: the connection the account's model actions use."
    )


class AttributeReading(BaseModel):
    """What the model read for one attribute of the profile; ``answered`` false
    when its answer left the attribute out (the other fields then empty)."""

    name: str
    answered: bool
    meaning: str = ""
    unit: str = ""
    values: str = ""
    identifier: bool = False


class ProbeConnection(BaseModel):
    id: int
    name: str
    model: str
    host: str
    locality: Locality


class ProbeResult(BaseModel):
    layer: str
    """The layer's name."""
    meaning: str
    """The model's sentence on what an object of the layer is."""
    attributes: list[AttributeReading]
    """Every attribute of the profile, in its order."""
    unknown: list[str]
    """Names the model answered for that the profile does not have."""
    connection: ProbeConnection
    probed_at: datetime
    latency_ms: int
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


def _text(value: Any) -> str:
    text = value.strip() if isinstance(value, str) else ""
    return text if len(text) <= MAX_TEXT else text[: MAX_TEXT - 1] + "…"


def _unreadable(cause: str) -> ActionError:
    return ActionError(
        "model_unreadable",
        "The model's answer is not the probe's JSON.",
        http_status=502,
        cause=cause,
    )


def parsed_of(completion: Completion) -> Any:
    """The answer's JSON; an endpoint that gets the schema only as text (Anthropic's
    compatibility) may fence it or explain itself after it."""
    try:
        return loose_json(completion)
    except json.JSONDecodeError as exc:
        # The decoder's message names a position, never the text.
        raise _unreadable(f"not JSON: {exc.msg} at char {exc.pos}") from None


def attribute_items(parsed: Any) -> list[Any] | None:
    """The answer's per-attribute items, or None when it has none. An endpoint
    that gets the schema only as text sometimes keys them by name instead of
    listing them: ``{"gem_nr": {...}}`` is read as ``[{"name": "gem_nr", ...}]``."""
    if not isinstance(parsed, dict):
        return None
    items = parsed.get("attributes")
    if isinstance(items, list):
        return items
    if isinstance(items, dict) and all(isinstance(v, dict) for v in items.values()):
        return [{**value, "name": key} for key, value in items.items()]
    return None


def by_name(profile: LayerProfile, items: list[Any]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Each attribute's first reading by name; names the profile lacks apart.
    Readings without a name take the attribute at their place, but only when
    the answer has one reading per attribute: an unconstrained model sometimes
    drops the names and keeps the order."""
    names = [a.name for a in profile.attributes]
    by_place = len(items) == len(names)
    given: dict[str, dict[str, Any]] = {}
    unknown: list[str] = []
    for place, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        raw = item.get("name")
        name = raw.strip() if isinstance(raw, str) else ""
        if not name and by_place:
            name = names[place]
        if name in names:
            given.setdefault(name, item)
        elif name and _text(name) not in unknown:
            unknown.append(_text(name))
    return given, unknown


def readings(profile: LayerProfile, parsed: Any) -> tuple[str, list[AttributeReading], list[str]]:
    """The model's answer laid over the profile: every profile attribute once,
    in the profile's order; names the profile lacks apart. ``ActionError``
    (``model_unreadable``) when it is no answer."""
    items = attribute_items(parsed)
    if items is None:
        raise _unreadable("no list of attributes")
    given, unknown = by_name(profile, items)
    out = []
    for attribute in profile.attributes:
        item = given.get(attribute.name)
        out.append(
            AttributeReading(
                name=attribute.name,
                answered=True,
                meaning=_text(item.get("meaning")),
                unit=_text(item.get("unit")),
                values=_text(item.get("values")),
                identifier=item.get("identifier") is True,
            )
            if item is not None
            else AttributeReading(name=attribute.name, answered=False)
        )
    return _text(parsed.get("layer")), out, unknown


def prompt(profile: LayerProfile) -> list[Message]:
    body = json.dumps(profile.model_dump(mode="json", exclude_none=True), ensure_ascii=False)
    return [Message("system", SYSTEM), Message("user", body)]


def connection_of(connection: ConnectionInfo) -> ProbeConnection:
    return ProbeConnection(
        id=connection.id,
        name=connection.name,
        model=connection.model,
        host=connection.host,
        locality=connection.locality,
    )


class MetadataCall:
    """One model call about a layer's metadata for one account: the probe (C) and
    the proposals (D). Each is its own entry (``MetadataProbe`` with its
    ``kind``) and security event, not a model action (Q5), and counts toward
    the connection's request limit (P5). It runs in the request, within the
    connection's timeout, and holds one of the instance's model-call slots."""

    kind: str
    event: str
    schema: dict[str, Any]

    def __init__(
        self,
        engine: Any,
        connections: Connections,
        client_factory: ClientFactory,
        calls: ModelCalls,
        *,
        clock: Callable[[], datetime] = utc_now,
        tz: tzinfo | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.engine = engine
        self.connections = connections
        self.client_factory = client_factory
        self.calls = calls
        self.clock = clock
        self.tz = tz
        self.monotonic = monotonic

    def _connection(
        self, caller: Account, connection_id: int | None
    ) -> tuple[ConnectionInfo, Endpoint]:
        if connection_id is None:
            found = self.connections.active_call(caller.id)
        else:
            found = self.connections.enabled_call(connection_id)
        if found is None:
            raise ConnectionProblem(
                409,
                "connection_not_available",
                "No enabled model connection to ask.",
                reason="none" if connection_id is None else "disabled",
            )
        return found

    def _record(self, caller: Account, connection: ConnectionInfo, layer: str) -> int:
        """Admit and record in one step, under the admission lock model actions
        take, so the limit is never passed by two at once."""
        with self.calls.admission, Session(self.engine) as db, db.begin():
            within_limit(db, connection, day_start(self.clock(), self.tz))
            row = MetadataProbe(
                user_id=caller.id,
                account=caller.username,
                connection_id=connection.id,
                layer=layer,
                kind=self.kind,
                called_at=self.clock(),
                status="asked",
            )
            db.add(row)
            db.flush()
            return row.id

    def _finish(self, probe_id: int, **values: Any) -> None:
        with Session(self.engine) as db, db.begin():
            db.execute(update(MetadataProbe).where(MetadataProbe.id == probe_id).values(**values))

    def ask(
        self,
        caller: Account,
        layer: str,
        connection_id: int | None,
        messages: list[Message],
        read: Callable[[Any], T],
    ) -> tuple[T, Completion, ConnectionInfo]:
        """Send ``messages``, read the answer's JSON with ``read`` (which raises
        ``model_unreadable`` as ``ActionError``) and keep the entry and event."""
        connection, endpoint = self._connection(caller, connection_id)
        self.calls.take()  # ModelCallsBusy: the instance's model calls are all in use
        try:
            probe_id = self._record(caller, connection, layer)
            client = self.client_factory(endpoint)
            try:
                answer = client.complete(
                    messages,
                    schema=self.schema,
                    schema_name=self.kind,
                    deadline=self.monotonic() + endpoint.timeout_s,
                )
            except LLMError as exc:
                self._finish(probe_id, status="failed", error_code=exc.code)
                self._event(caller, connection, layer, ok=False, code=exc.code)
                # The seam's code and its cause, never a response body (C13).
                raise ConnectionProblem(
                    502, exc.code, exc.message, connection=connection.name
                ) from exc
            finally:
                client.close()
        finally:
            self.calls.give_back()
        tokens = {
            "prompt_tokens": answer.prompt_tokens,
            "completion_tokens": answer.completion_tokens,
            "latency_ms": answer.latency_ms,
        }
        try:
            if answer.finish_reason == "length":
                raise ActionError(
                    "model_truncated",
                    "The model's answer was cut off at its length limit.",
                    http_status=502,
                )
            result = read(parsed_of(answer))
        except ActionError as exc:
            self._finish(probe_id, status="failed", error_code=exc.code, **tokens)
            self._event(caller, connection, layer, ok=False, code=exc.code)
            raise
        self._finish(probe_id, status="ok", **tokens)
        self._event(caller, connection, layer, ok=True, **tokens)
        return result, answer, connection

    def _event(
        self, caller: Account, connection: ConnectionInfo, layer: str, *, ok: bool, **fields: Any
    ) -> None:
        audit.event(
            self.event,
            username=caller.username,
            layer=layer,
            connection=connection.id,
            host=connection.host,
            ok=ok,
            **fields,
        )


class Probe(MetadataCall):
    """Probe one layer for one account; the route's whole work."""

    kind = "probe"
    event = "layer_probed"
    schema = SCHEMA

    def run(self, caller: Account, profile: LayerProfile, connection_id: int | None) -> ProbeResult:
        (meaning, attributes, unknown), answer, connection = self.ask(
            caller,
            profile.name,
            connection_id,
            prompt(profile),
            lambda parsed: readings(profile, parsed),
        )
        return ProbeResult(
            layer=profile.name,
            meaning=meaning,
            attributes=attributes,
            unknown=unknown,
            connection=connection_of(connection),
            probed_at=self.clock(),
            latency_ms=answer.latency_ms,
            prompt_tokens=answer.prompt_tokens,
            completion_tokens=answer.completion_tokens,
        )
