"""The arms of the measurement of examples (docs/plan-improve-examples.md,
6.5). The pool, the selector and the section are the application's
(``geotandem.model.pool``), so what ships is what was measured.

- **Arms:** ``a`` today's fixed set; ``b`` three pool cases drawn at random,
  seeded per case and seed; ``c`` three chosen by the selector (``choose``).
- A case is never its own example (leave one out); confirm cases never are.
"""

import random
from collections.abc import Sequence
from typing import Final, Literal

from variants import EXAMPLES, join, split

from geotandem.llm import Message
from geotandem.model.pool import (
    COUNT,
    Example,
    choose,
    pool_hash,
    pool_of,
    section,
)

__all__ = ["ARMS", "Arm", "Example", "choose", "draw", "pool_hash", "pool_of", "with_pool"]

Arm = Literal["a", "b", "c"]
ARMS: Final[tuple[Arm, ...]] = ("a", "b", "c")


def draw(pool: Sequence[Example], case: str, seed: int, k: int = COUNT) -> list[Example]:
    """Arm B: ``k`` pool cases at random, not ``case`` itself; the same for a
    case and seed in every run, model and approach."""
    others = [e for e in pool if e.case != case]
    return random.Random(f"{case}:{seed}").sample(others, k)


def with_pool(
    messages: Sequence[Message], examples: Sequence[Example], approach: Literal["direct", "chain"]
) -> list[Message]:
    """The messages with their ``# Beispiele`` section rebuilt by ``section``."""
    system, *rest = messages
    sections = split(system.content)
    sections[EXAMPLES] = section(sections[EXAMPLES], examples, approach)
    return [Message("system", join(sections)), *rest]
