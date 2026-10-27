"""The messages a model gets for one prompt (D7, D8, P6, plan WP64).

Layout, in this order:

1. **system**, in sections:
   - the level's system prompt (H9), as the administrator wrote it;
   - *Layer-Steckbrief*: the account's layer profile in its canonical form,
     the very text its hash is taken over (S4), so the recorded hash names
     what the model saw;
   - *Antwortformat*: fixed text and the answer schema of the approach (D7),
     for the direct approach cut to what the controls can show, for the chain
     with its tools and their arguments (``chain.tools.tool_list``, P4);
     written by the application, never part of the editable system prompt.
2. the follow-up turns, oldest first, at most ``MAX_TURNS``: the user's prompt,
   then the assistant's answer in its own words (explanation, assumptions).
   What became of an answer (refused by the application, or the user's
   decision) is not the assistant's: it opens the next user message as a note.
   Never a query, never rows: ``Turn`` has no field that could hold either.
3. **user**: the note on the last turn, the current analysis as a query object
   when the prompt follows an answer (P6), a note when the user changed it by
   hand since (M11.2), and the prompt text.

A prompt with neither turns nor an analysis ends its system message with
``FIRST``: without it, models took the worked examples for earlier queries of
the conversation (testplan V-3).

The direct query is written after the connection's **prompt profile** (plan
E3, D9), measured presets of ``evals/`` (testplan-system-context 5, 8.2):

- *examples* ``standard`` (``_EXAMPLES``) or ``12`` (``examples/12.txt``, P6);
- *placement* ``P0`` as above; ``P5`` the examples right after the level's
  system prompt, before the layer profile; ``P9`` ``FIRST`` as a system
  message of its own right before the question (three messages, not two). The
  user message stays the prompt text and nothing else (E-8, extended
  2026-10-23);
- *output* ``constrained`` sends the schema as constrained output as well as
  text, ``text`` only as text in the prompt (``Prompt.constrained``, H-8).

``DEFAULT_PROMPT_PROFILE`` is the prompt above byte for byte; the chain keeps it
until the chain is evaluated (plan E3, 9).

The size is estimated as the layer profile is (S5, ``CHARS_PER_TOKEN``, erring
high) over every message, plus ``ANSWER_TOKENS`` for the answer. Over the
connection's declared context length ⇒ ``context_too_large`` before any call;
nothing is cut silently. Without a declared length there is nothing to check.
"""

import hashlib
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import cache
from importlib.resources import files
from typing import Any, Final, Literal

from geotandem.catalog import CHARS_PER_TOKEN, ModelProfile
from geotandem.levels import Level
from geotandem.llm import Message
from geotandem.model.chain.tools import tool_list
from geotandem.model.errors import ActionError
from geotandem.model.represent import ALLOWED_FIELDS
from geotandem.model.result import answer_format, format_text
from geotandem.model.schemas import (
    MAX_CONDITIONS,
    MAX_TURNS,
    Approach,
    CannotAnswer,
    Clarification,
    Decision,
    ExampleSet,
    OutputMode,
    PlanAnswer,
    PromptProfile,
    QueryAnswer,
    Reference,
    RefusalCode,
    RejectReason,
)
from geotandem_query import QueryObject, canonical_json

ANSWER_TOKENS: Final = 4_000
"""Room kept for the answer: the largest valid direct answer, an explanation
and eight assumptions of 600 characters each and a query of ``MAX_CONDITIONS``
conditions, is about 8 000 characters of JSON; 12 000 leave room for long value
lists. A full window leaves none, and a cut answer is unreadable."""

DECISIONS: Final[dict[Decision, str]] = {
    "accepted": "freigegeben",
    "adjusted": "angepasst übernommen",
    "rejected": "abgelehnt",
    "superseded": "ohne Entscheid übergangen",
    "auto": "automatisch ausgeführt",
    "proposal_only": "als Vorschlag gezeigt",
    "aborted": "abgebrochen",
    "failed": "fehlgeschlagen",
}
REASONS: Final[dict[RejectReason, str]] = {
    "misunderstood": "falsch verstanden",
    "wrong_layer": "falscher Layer",
    "wrong_value": "falscher Wert",
    "other": "anderer Grund",
}

_FORMAT: Final[dict[Approach, str]] = {
    "direct": (
        "Antworte mit genau einem JSON-Objekt nach dem Schema unten, ohne weiteren Text.\n"
        '- "query": ein Abfrageobjekt, das die Frage beantwortet. "explanation" sagt in '
        "ein bis drei Sätzen, wie du die Frage verstanden hast; jede Annahme steht in "
        '"assumptions", "condition" zeigt auf die Bedingung in "where", die sie betrifft.\n'
        '- "clarification": nur wenn keine vernünftige Annahme möglich ist, mit zwei bis '
        "vier Antwortmöglichkeiten.\n"
        '- "cannot_answer": wenn die Layer die Frage nicht beantworten; "missing" nennt, '
        'was fehlt. Mit "other_approach": "chain", wenn eine Werkzeugkette sie lösen kann.\n'
        "Die Abfrage muss sich in den Bedienelementen zeigen lassen: höchstens "
        f"{MAX_CONDITIONS} Bedingungen, nur die Felder {', '.join(ALLOWED_FIELDS)}, "
        '"output" immer "map"; keine Sortierung, keine Begrenzung, keine berechneten '
        'Spalten, kein Puffer, keine Verknüpfung, keine Zusammenfassung und kein "not" '
        'direkt in einem "not". Bedingungen '
        'auf einem Bezugslayer stehen in dessen "where" als eine einzige, nicht verneinte '
        "Attributbedingung. Sonst antworte mit cannot_answer und other_approach chain: "
        "Die Werkzeugkette filtert, puffert und verbindet Schritte räumlich (nahe, in, "
        "ausserhalb, schneidet), auch mit mehreren Bedingungen auf einem Layer.\n"
        'Attribute eines Layers mit "kind": "table" lassen sich in keinem Ansatz abfragen, '
        "auch nicht über einen anderen Layer. Verknüpfen und Zusammenfassen oder Zählen je "
        "Gruppe («je Gemeinde», «pro …») kann auch die Werkzeugkette nicht. Dann antworte "
        'mit cannot_answer ohne other_approach und nenne in "missing", was fehlt.\n'
        "«Wie viele …?» ohne «je» oder «pro» ist kein Zählen je Gruppe: Beantworte sie mit "
        '"query" für diese Objekte, die Anwendung zeigt ihre Anzahl. Das ist kein Grund '
        "für cannot_answer."
    ),
    "chain": (
        "Antworte mit genau einem JSON-Objekt nach dem Schema unten, ohne weiteren Text.\n"
        '- "plan": die Schritte einer Werkzeugkette, die die Frage beantwortet. "explanation" '
        "sagt in ein bis drei Sätzen, wie du vorgehst; jede Annahme steht in "
        '"assumptions". Die Anwendung führt die Schritte aus, nicht du.\n'
        '- "clarification": nur wenn keine vernünftige Annahme möglich ist, mit zwei bis '
        "vier Antwortmöglichkeiten.\n"
        '- "cannot_answer": wenn die Werkzeuge und Layer die Frage nicht beantworten; '
        '"missing" nennt, was fehlt. Mit "other_approach": "direct", wenn eine '
        "Direktabfrage sie lösen kann.\n"
        'Layer mit "kind": "table" kann kein Werkzeug verwenden. Verknüpfen und '
        "Zusammenfassen oder Zählen je Gruppe gibt es nicht: Dann antworte mit "
        "cannot_answer ohne other_approach.\n" + tool_list()
    ),
}


FIRST: Final = (
    "# Gespräch\n"
    "Die folgende Frage ist die erste des Gesprächs. Es gibt keine frühere Abfrage und "
    "keine Analyse, auf die sie sich beziehen kann."
)
"""Closes the system message of a prompt that builds on nothing (V-3). In the
system message, not the user's: the user message stays the prompt text and
nothing else (security review, prompt injection)."""

_EXAMPLES: Final[dict[Approach, str]] = {
    "direct": (
        "# Beispiele\n"
        "Erfundene Beispiele an erfundenen Layern. Sie sind kein Teil des Gesprächs: Der "
        "Anwender hat diese Fragen nie gestellt, und es gibt keine frühere Abfrage dazu. "
        "Verwende nur die Layer und Attribute des Layer-Steckbriefs. Erfundener Steckbrief "
        'der Beispiele: baeume.art codes {"qu":"Eiche","ti":"Linde"}; quartiere.name (Text); '
        'schulhaeuser.stufe codes {"prim":"Primarschule","sek":"Sekundarschule"}; '
        "schulhaeuser.oeffentlich (Ja/Nein); "
        'parzellen.zone codes {"W2":"Wohnzone 2","GE":"Gewerbezone"}; spielplaetze; '
        "wanderwege (Linien); orte.name (Gemeinden, Text).\n"
        "- Ein Ort, der ein Objekt eines anderen Layers ist («in der Altstadt»): Bedingung "
        '"related" mit "within" auf diesen Layer und einer Bedingung auf seinen Namen. '
        "Rate nie eine Nummer oder Kennung.\n"
        '- Ein Objekt mit Namen (Gemeinde, Quartier, Gewässer, Haltestelle): "compare" mit '
        '"eq" auf den Namen, nie "text_match": «Altstadt» träfe sonst auch «Altstadt-Nord». '
        '"text_match" nur, wenn nach einem Teil gefragt ist («beginnt mit», «enthält»).\n'
        "- Linien (Strassen, Flüsse, Wege) zu Flächen: «durch», «entlang», «in» heisst "
        '"intersects"; "within" nur, wenn die Linie ganz in der Fläche liegen soll.\n'
        '- Nähe zu Objekten eines Layers: "related" mit "dwithin" und "distance_m"; '
        '«weiter als» ist "not" um diese Bedingung. Ohne Zahl («nahe», «in der Nähe») '
        'nimm 300 m an und nenne es als Annahme. "near_feature" meint ein einzelnes '
        "Objekt mit bekannter fid; du kennst keine fids, verwende es nicht.\n"
        "- Eine Bedingung auf die Objekte des anderen Layers («Primarschulen», «die Aare») "
        'steht im "where" des "related", mit dessen Attributen.\n'
        '- Werte mit "codes": der Schlüssel links, nie die Beschriftung rechts '
        '(«Eiche» ⇒ "qu"). Ja/Nein-Attribute vergleichst du mit true oder false. '
        '«Von … bis …» auf einem Attribut mit "codes": "in" mit allen Codes dazwischen, in '
        'der Reihenfolge der Codeliste, nie "between" (Codes sind Text). «A oder B» auf '
        'demselben Attribut ist "in" mit beiden Werten, nie "and".\n'
        "- Höchstens eine Rückfrage: Folgt die Frage auf deine Rückfrage, antworte mit einer "
        'Annahme. Zahlen in Optionen nur innerhalb von "range", wenn es sie gibt. «Stadt X» '
        "oder «Dorf X» ist die Gemeinde X, ohne Rückfrage.\n"
        "- Nur Bedingungen, nach denen gefragt ist; keine zusätzlichen «ist nicht leer».\n"
        '- Eine einzige Bedingung steht direkt in "where", nicht in einem "and" oder "or" '
        "mit nur einem Argument.\n"
        "\nFrage: Welche Eichen stehen in der Altstadt?\n"
        '{"kind":"query","explanation":"Bäume der Art Eiche, die im Quartier Altstadt liegen.",'
        '"assumptions":[],"query":{"source":"baeume","where":{"op":"and","args":['
        '{"op":"compare","attr":"art","cmp":"eq","value":"qu"},'
        '{"op":"related","layer":"quartiere","predicate":"within",'
        '"where":{"op":"compare","attr":"name","cmp":"eq","value":"Altstadt"}}]},'
        '"output":"map"}}\n'
        "\nFrage: Spielplätze in der Nähe von Primarschulen\n"
        '{"kind":"query","explanation":"Spielplätze, die nahe bei mindestens einer '
        'Primarschule liegen.","assumptions":[{"text":"«In der Nähe» heisst höchstens 300 m.",'
        '"condition":[]}],"query":{"source":"spielplaetze","where":{"op":"related",'
        '"layer":"schulhaeuser","predicate":"dwithin","distance_m":300,'
        '"where":{"op":"compare","attr":"stufe","cmp":"eq","value":"prim"}},"output":"map"}}\n'
        "\nFrage: Parzellen in der Wohnzone 2, die mehr als 1 km vom nächsten Spielplatz "
        "entfernt sind\n"
        '{"kind":"query","explanation":"Parzellen der Wohnzone 2 ohne Spielplatz im Umkreis '
        'von 1 km.","assumptions":[],"query":{"source":"parzellen","where":{"op":"and",'
        '"args":[{"op":"compare","attr":"zone","cmp":"eq","value":"W2"},'
        '{"op":"not","arg":{"op":"related","layer":"spielplaetze","predicate":"dwithin",'
        '"distance_m":1000}}]},"output":"map"}}\n'
        "\nFrage: Quartiere ohne öffentliches Schulhaus\n"
        '{"kind":"query","explanation":"Quartiere, in denen kein öffentliches Schulhaus '
        'liegt.","assumptions":[],"query":{"source":"quartiere","where":{"op":"not","arg":'
        '{"op":"related","layer":"schulhaeuser","predicate":"contains",'
        '"where":{"op":"compare","attr":"oeffentlich","cmp":"eq","value":true}}},'
        '"output":"map"}}\n'
        "\nFrage: Welche Wanderwege führen durch die Altstadt?\n"
        '{"kind":"query","explanation":"Wanderwege, die das Quartier Altstadt schneiden.",'
        '"assumptions":[],"query":{"source":"wanderwege","where":{"op":"related",'
        '"layer":"quartiere","predicate":"intersects","where":{"op":"compare","attr":"name",'
        '"cmp":"eq","value":"Altstadt"}},"output":"map"}}\n'
        "\nFrage: Spielplätze ausserhalb der Stadt Seedorf\n"
        '{"kind":"query","explanation":"Spielplätze, die nicht in der Gemeinde Seedorf '
        'liegen.","assumptions":[{"text":"«Stadt Seedorf» ist die Gemeinde Seedorf.",'
        '"condition":[]}],"query":{"source":"spielplaetze","where":{"op":"not","arg":'
        '{"op":"related","layer":"orte","predicate":"within","where":{"op":"compare",'
        '"attr":"name","cmp":"eq","value":"Seedorf"}}},"output":"map"}}\n'
        "\nFrage: Wie viele Sitzbänke gibt es?\n"
        '{"kind":"cannot_answer","explanation":"Kein Layer beschreibt Sitzbänke.",'
        '"missing":["ein Layer mit Sitzbänken"]}'
    ),
    "chain": (
        "# Beispiele\n"
        "Erfundene Beispiele an erfundenen Layern. Sie sind kein Teil des Gesprächs: Der "
        "Anwender hat diese Fragen nie gestellt, und es gibt keine frühere Abfrage dazu. "
        "Verwende nur die Layer und Attribute des Layer-Steckbriefs. Erfundener Steckbrief "
        'der Beispiele: baeume.art codes {"qu":"Eiche","ti":"Linde"} (Punkte); quartiere.name '
        '(Flächen, Text); schulhaeuser.stufe codes {"prim":"Primarschule","sek":'
        '"Sekundarschule"} (Punkte); schulhaeuser.oeffentlich (Ja/Nein); wanderwege (Linien); '
        "orte.name (Gemeinden, Flächen, Text).\n"
        "- Zuerst die Schritte, auf die sich ein räumlicher Schritt bezieht, dann der "
        'räumliche Schritt: "of", "in", "to", "with" und "has" nennen frühere Schritte, nie '
        "den eigenen oder einen späteren. Gilt der räumliche Schritt allen Objekten eines "
        'Layers, nennen sie den Layer mit seinem Namen («Wanderwege» ⇒ "wanderwege"); '
        "schreibe dafür keine Bedingung, die alle erfüllen sollen.\n"
        "- Schränkt die Frage die Objekte ein («Bushaltestellen», «Nebengewässer»), braucht "
        'es dafür einen "filter"-Schritt; der ganze Layer wäre zu viel.\n'
        "- Nur der letzte Schritt ist das Ergebnis. Jeder andere Schritt wird von einem "
        "späteren genannt: Eine weitere Bedingung auf denselben Objekten nimmt den Schritt "
        'davor in "of", auch eine zweite räumliche; zwei Ergebnisse verbindet kein Schritt.\n'
        "- Ein Ort, der ein Objekt eines anderen Layers ist («in der Altstadt»): ein Schritt "
        '"filter" auf diesen Layer mit einer Bedingung auf seinen Namen, dann "within" mit '
        'den gesuchten Objekten in "of" und dem Ort in "in". Rate nie eine Nummer, einen '
        "Code oder eine Kennung, auch keine Gemeindenummer.\n"
        '- In einem Punkt oder einer Linie liegt nichts: "within" und "outside" nur mit '
        'Flächen oder einem Puffer in "in". Flächen mit Objekten darin («Quartiere mit einer '
        'Eiche»): "contains" mit den Flächen in "of" und den Objekten in "has".\n'
        '- Ein Objekt mit Namen (Gemeinde, Quartier, Gewässer, Haltestelle): "compare" mit '
        '"eq" auf den Namen, nie "text_match": «Altstadt» träfe sonst auch «Altstadt-Nord». '
        '"text_match" nur, wenn nach einem Teil gefragt ist («beginnt mit», «enthält»).\n'
        "- Linien (Strassen, Flüsse, Wege) zu Flächen: «durch», «entlang», «in» heisst "
        '"intersects"; "within" nur, wenn die Linie ganz in der Fläche liegen soll.\n'
        '- Nähe: "near" mit "distance_m". «Weiter als» von Punkten: "buffer" um die anderen '
        'Objekte und "outside". Ohne Zahl («nahe», «in der Nähe») nimm 300 m an und nenne '
        'es als Annahme. "near_feature" meint ein einzelnes Objekt mit bekannter fid; du '
        "kennst keine fids, verwende es nicht.\n"
        '- Werte mit "codes": der Schlüssel links, nie die Beschriftung rechts '
        '(«Eiche» ⇒ "qu"). Ja/Nein-Attribute vergleichst du mit true oder false. '
        '«Von … bis …» auf einem Attribut mit "codes": "in" mit allen Codes dazwischen, in '
        'der Reihenfolge der Codeliste, nie "between" (Codes sind Text). «A oder B» auf '
        'demselben Attribut ist "in" mit beiden Werten, nie "and".\n'
        "- Höchstens eine Rückfrage: Folgt die Frage auf deine Rückfrage, antworte mit einer "
        'Annahme. Zahlen in Optionen nur innerhalb von "range", wenn es sie gibt. «Stadt X» '
        "oder «Dorf X» ist die Gemeinde X, ohne Rückfrage.\n"
        "- Nur Bedingungen, nach denen gefragt ist; keine zusätzlichen «ist nicht leer».\n"
        "\nFrage: Welche Eichen stehen in der Altstadt?\n"
        '{"kind":"plan","explanation":"Das Quartier Altstadt, die Eichen, dann die Eichen '
        'darin.","assumptions":[],"steps":['
        '{"text":"Quartier Altstadt","tool":"filter","arguments":{"layer":"quartiere",'
        '"where":{"op":"compare","attr":"name","cmp":"eq","value":"Altstadt"}}},'
        '{"text":"Eichen","tool":"filter","arguments":{"layer":"baeume",'
        '"where":{"op":"compare","attr":"art","cmp":"eq","value":"qu"}}},'
        '{"text":"Eichen in der Altstadt","tool":"within","arguments":{"of":2,"in":1}}]}\n'
        "\nFrage: Primarschulhäuser in der Nähe von Linden\n"
        '{"kind":"plan","explanation":"Linden, Primarschulhäuser, dann die '
        'Primarschulhäuser nahe einer Linde.","assumptions":[{"text":"«In der Nähe» heisst '
        'höchstens 300 m.","condition":[]}],"steps":['
        '{"text":"Linden","tool":"filter","arguments":{"layer":"baeume",'
        '"where":{"op":"compare","attr":"art","cmp":"eq","value":"ti"}}},'
        '{"text":"Primarschulhäuser","tool":"filter","arguments":{"layer":"schulhaeuser",'
        '"where":{"op":"compare","attr":"stufe","cmp":"eq","value":"prim"}}},'
        '{"text":"Primarschulhäuser höchstens 300 m von einer Linde","tool":"near",'
        '"arguments":{"of":2,"to":1,"distance_m":300}}]}\n'
        "\nFrage: Linden, die mehr als 1 km von jedem öffentlichen Schulhaus entfernt sind\n"
        '{"kind":"plan","explanation":"Ein Puffer von 1 km um die öffentlichen Schulhäuser, '
        'dann die Linden ausserhalb.","assumptions":[],"steps":['
        '{"text":"1 km um öffentliche Schulhäuser","tool":"buffer","arguments":{"layer":'
        '"schulhaeuser","distance_m":1000,"where":{"op":"compare","attr":"oeffentlich",'
        '"cmp":"eq","value":true}}},'
        '{"text":"Linden","tool":"filter","arguments":{"layer":"baeume",'
        '"where":{"op":"compare","attr":"art","cmp":"eq","value":"ti"}}},'
        '{"text":"Linden ausserhalb des Puffers","tool":"outside","arguments":{"of":2,'
        '"in":1}}]}\n'
        "\nFrage: Welche Wanderwege führen durch die Altstadt?\n"
        '{"kind":"plan","explanation":"Das Quartier Altstadt, dann die Wanderwege, die es '
        'schneiden.","assumptions":[],"steps":['
        '{"text":"Quartier Altstadt","tool":"filter","arguments":{"layer":"quartiere",'
        '"where":{"op":"compare","attr":"name","cmp":"eq","value":"Altstadt"}}},'
        '{"text":"Wanderwege durch die Altstadt","tool":"intersects","arguments":'
        '{"of":"wanderwege","with":1}}]}\n'
        "\nFrage: In welchen Quartieren steht eine Eiche?\n"
        '{"kind":"plan","explanation":"Die Eichen, dann die Quartiere, die eine enthalten.",'
        '"assumptions":[],"steps":['
        '{"text":"Eichen","tool":"filter","arguments":{"layer":"baeume",'
        '"where":{"op":"compare","attr":"art","cmp":"eq","value":"qu"}}},'
        '{"text":"Quartiere mit einer Eiche","tool":"contains","arguments":'
        '{"of":"quartiere","has":1}}]}\n'
        "\nFrage: Öffentliche Sekundarschulhäuser\n"
        '{"kind":"plan","explanation":"Sekundarschulhäuser, davon die öffentlichen.",'
        '"assumptions":[],"steps":['
        '{"text":"Sekundarschulhäuser","tool":"filter","arguments":{"layer":"schulhaeuser",'
        '"where":{"op":"compare","attr":"stufe","cmp":"eq","value":"sek"}}},'
        '{"text":"davon die öffentlichen","tool":"filter","arguments":{"of":1,'
        '"where":{"op":"compare","attr":"oeffentlich","cmp":"eq","value":true}}}]}\n'
        "\nFrage: Wie viele Sitzbänke gibt es?\n"
        '{"kind":"cannot_answer","explanation":"Kein Layer beschreibt Sitzbänke.",'
        '"missing":["ein Layer mit Sitzbänken"]}'
    ),
}
"""Worked examples after the answer format: invented layers, so they fit any
data core and name no layer an account may not see (S3); the harness in
``evals/`` measures what they change. The chain's are the direct query's rules
as steps (plan-chain-eval, F10): without them a chain was planned with none of
them."""

DEFAULT_PROMPT_PROFILE: Final = PromptProfile()
"""Today's prompt (D9): standard examples, P0, constrained output."""

EXAMPLES_HEADING: Final = "# Beispiele"


@cache
def examples_section(examples: ExampleSet) -> str:
    """The ``# Beispiele`` section of a direct query for the profile's example
    set: ``_EXAMPLES`` or ``examples/<name>.txt`` of this package, invented
    layers alike (S3). Every worked answer of a set is a valid answer (tested)."""
    if examples == "standard":
        return _EXAMPLES["direct"]
    text = files("geotandem.model").joinpath(f"examples/{examples}.txt")
    section = text.read_text(encoding="utf-8").strip()
    if not section.startswith(EXAMPLES_HEADING + "\n"):
        raise ValueError(f"examples/{examples}.txt must start with {EXAMPLES_HEADING!r}")
    return section


@dataclass(frozen=True)
class Turn:
    """An earlier prompt and what came of it (P6): text only, never a query or rows."""

    prompt: str
    answer: str | None = None
    """The explanation, a clarification's question with its options, or why the
    model could not answer; ``None`` when no answer came."""
    assumptions: tuple[str, ...] = ()
    refusal: RefusalCode | None = None
    """The application refused the answer (D1, D3)."""
    decision: Decision | None = None
    reject_reason: RejectReason | None = None

    @classmethod
    def of(
        cls,
        prompt: str,
        answer: QueryAnswer | Clarification | CannotAnswer | PlanAnswer | None,
        *,
        refusal: RefusalCode | None = None,
        decision: Decision | None = None,
        reject_reason: RejectReason | None = None,
    ) -> "Turn":
        """The turn of a stored answer: its words, never its query or steps."""
        text: str | None = None
        assumptions: tuple[str, ...] = ()
        match answer:
            case QueryAnswer() | PlanAnswer():
                text = answer.explanation
                assumptions = tuple(a.text for a in answer.assumptions)
            case Clarification():
                text = f"{answer.question} ({' · '.join(answer.options)})"
            case CannotAnswer():
                missing = f" Es fehlt: {'; '.join(answer.missing)}." if answer.missing else ""
                text = answer.explanation + missing
        return cls(prompt, text, assumptions, refusal, decision, reject_reason)


@dataclass(frozen=True)
class FollowUp:
    """What a prompt builds on (P6): the caller loads it, the builder only writes it."""

    analysis: QueryObject | None = None
    """The current analysis, without the map's restriction (``restriction``)."""
    reference: Reference = "none"
    turns: Sequence[Turn] = field(default_factory=tuple)
    restriction: Literal["view", "shape"] | None = None
    """"Nur in" on the analysis: the user's, never the model's (D3)."""


@dataclass(frozen=True)
class Prompt:
    messages: tuple[Message, ...]
    schema: dict[str, Any]
    """The answer format; always in the system message as text."""
    profile_hash: str
    tokens_estimate: int
    output: OutputMode = "constrained"
    """Whether ``schema`` also goes as constrained output (D9)."""

    @property
    def constrained(self) -> dict[str, Any] | None:
        """What the client is asked to constrain the answer to; ``None``: the
        schema only as text, as for an endpoint that ignores it (H-8)."""
        return self.schema if self.output == "constrained" else None


def prompt_hash(messages: Sequence[Message], schema: object) -> str:
    """Over every message and the schema, as sent: the same hash, the same
    prompt. The harness's ``prompt_sha256`` (H-5); the output mode is not in it."""
    sent = [{"role": m.role, "content": m.content} for m in messages]
    blob = json.dumps({"messages": sent, "schema": schema}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def system_message(
    level: Level,
    profile: ModelProfile,
    approach: Approach,
    prompt_profile: PromptProfile = DEFAULT_PROMPT_PROFILE,
) -> str:
    """The first system message, without ``FIRST``; ``prompt_profile`` chooses
    the examples and, for ``P5``, puts them before the layer profile."""
    if not profile.text:
        raise ValueError("the profile carries its text only from catalog.model_profile")
    if approach != "direct" and prompt_profile != DEFAULT_PROMPT_PROFILE:
        raise ValueError("a prompt profile other than the default is for the direct query only")
    sections = [level.system_prompt.strip()] if level.system_prompt.strip() else []
    examples = [
        examples_section(prompt_profile.examples) if approach == "direct" else _EXAMPLES["chain"]
    ]
    if prompt_profile.placement == "P5":
        sections += examples
    sections.append(
        "# Layer-Steckbrief\n"
        "Die Layer, die du kennst: nur ihre Metadaten, nie ihre Inhalte.\n" + profile.text
    )
    sections.append(
        "# Antwortformat\n"
        + _FORMAT[approach]
        + "\nJSON-Schema der Antwort:\n"
        + format_text(approach)
    )
    if prompt_profile.placement != "P5":
        sections += examples
    return "\n\n".join(sections)


def _assistant(turn: Turn) -> str:
    lines = [turn.answer or "(keine Antwort)"]
    if turn.assumptions:
        lines.append("Annahmen: " + "; ".join(turn.assumptions))
    return "\n".join(lines)


RESTRICTIONS: Final[dict[str, str]] = {
    "view": "den Kartenausschnitt",
    "shape": "eine gezeichnete Fläche",
}
"""The map's restriction in the words of a follow-up (WP81)."""


def _note(turn: Turn | None) -> str | None:
    """What became of the last answer, as the application tells it."""
    if turn is None:
        return None
    notes = []
    if turn.refusal is not None:
        notes.append(f"Deine Antwort wurde von der Anwendung abgewiesen ({turn.refusal}).")
    if turn.decision is not None:
        decided = DECISIONS[turn.decision]
        if turn.reject_reason is not None:
            decided += f" ({REASONS[turn.reject_reason]})"
        notes.append(f"Entscheid des Anwenders zu deiner Antwort: {decided}.")
    return "Hinweis: " + " ".join(notes) if notes else None


def _user(text: str, previous: Turn | None, follow_up: FollowUp | None = None) -> str:
    parts = [note] if (note := _note(previous)) else []
    if follow_up is not None and follow_up.analysis is not None:
        parts.append("Aktuelle Analyse als Abfrageobjekt:\n" + canonical_json(follow_up.analysis))
        if follow_up.reference == "hand_edited":
            parts.append(
                "Die aktuelle Analyse ist nicht die deiner letzten Antwort: Der Anwender hat "
                "sie von Hand geändert oder deine Antwort nicht übernommen."
            )
        if follow_up.restriction is not None:
            where = RESTRICTIONS[follow_up.restriction]
            parts.append(
                f"Der Anwender hat das Ergebnis zusätzlich auf {where} beschränkt («Nur in»). "
                "Diese Beschränkung setzt er selbst, sie bleibt bestehen; nimm sie nicht in "
                "deine Abfrage auf."
            )
    if not parts:
        return text
    return "\n\n".join([*parts, "Frage: " + text])


def estimate_tokens(messages: Sequence[Message]) -> int:
    """As the profile's estimate (S5), over all messages, plus room for the answer."""
    chars = sum(len(m.content) for m in messages)
    return math.ceil(chars / CHARS_PER_TOKEN) + ANSWER_TOKENS


def build_prompt(
    text: str,
    *,
    approach: Approach,
    level: Level,
    profile: ModelProfile,
    follow_up: FollowUp | None = None,
    context_length: int | None = None,
    prompt_profile: PromptProfile = DEFAULT_PROMPT_PROFILE,
) -> Prompt:
    """The messages for ``text``; ``context_too_large`` if they do not fit. A
    prompt profile other than the default is for the direct query only."""
    system = system_message(level, profile, approach, prompt_profile)
    first = not (follow_up and (follow_up.turns or follow_up.analysis is not None))
    apart = prompt_profile.placement == "P9"
    if first and not apart:
        system += "\n\n" + FIRST
    messages = [Message("system", system)]
    previous: Turn | None = None
    for turn in list(follow_up.turns if follow_up else ())[-MAX_TURNS:]:
        messages.append(Message("user", _user(turn.prompt, previous)))
        messages.append(Message("assistant", _assistant(turn)))
        previous = turn
    if first and apart:
        messages.append(Message("system", FIRST))
    messages.append(Message("user", _user(text, previous, follow_up)))
    return Prompt(
        messages=tuple(messages),
        schema=answer_format(approach),
        profile_hash=profile.hash,
        tokens_estimate=fit(messages, context_length),
        output=prompt_profile.output,
    )


def fit(messages: Sequence[Message], context_length: int | None) -> int:
    """The size estimate of ``messages``; ``context_too_large`` if it exceeds the
    connection's context length. Every call of a prompt is held to it, a
    chain's re-plan too."""
    estimate = estimate_tokens(messages)
    if context_length is not None and estimate > context_length:
        raise ActionError(
            "context_too_large",
            f"Prompt, layer profile and context need about {estimate} tokens; "
            f"the connection takes {context_length}.",
            tokens_estimate=estimate,
            context_length=context_length,
        )
    return estimate
