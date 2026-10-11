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

The size is estimated as the layer profile is (S5, ``CHARS_PER_TOKEN``, erring
high) over every message, plus ``ANSWER_TOKENS`` for the answer. Over the
connection's declared context length ⇒ ``context_too_large`` before any call;
nothing is cut silently. Without a declared length there is nothing to check.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Final

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
    PlanAnswer,
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
        "Attributbedingung. Sonst antworte mit cannot_answer und other_approach chain."
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
        "Direktabfrage sie lösen kann.\n" + tool_list()
    ),
}


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
    reference: Reference = "none"
    turns: Sequence[Turn] = field(default_factory=tuple)


@dataclass(frozen=True)
class Prompt:
    messages: tuple[Message, ...]
    schema: dict[str, Any]
    """The answer format, also sent as constrained output."""
    profile_hash: str
    tokens_estimate: int


def system_message(level: Level, profile: ModelProfile, approach: Approach) -> str:
    if not profile.text:
        raise ValueError("the profile carries its text only from catalog.model_profile")
    sections = [level.system_prompt.strip()] if level.system_prompt.strip() else []
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
    return "\n\n".join(sections)


def _assistant(turn: Turn) -> str:
    lines = [turn.answer or "(keine Antwort)"]
    if turn.assumptions:
        lines.append("Annahmen: " + "; ".join(turn.assumptions))
    return "\n".join(lines)


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
                "Der Anwender hat die Analyse seit deiner letzten Antwort von Hand geändert."
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
) -> Prompt:
    """The messages for ``text``; ``context_too_large`` if they do not fit."""
    messages = [Message("system", system_message(level, profile, approach))]
    previous: Turn | None = None
    for turn in list(follow_up.turns if follow_up else ())[-MAX_TURNS:]:
        messages.append(Message("user", _user(turn.prompt, previous)))
        messages.append(Message("assistant", _assistant(turn)))
        previous = turn
    messages.append(Message("user", _user(text, previous, follow_up)))
    return Prompt(
        messages=tuple(messages),
        schema=answer_format(approach),
        profile_hash=profile.hash,
        tokens_estimate=fit(messages, context_length),
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
