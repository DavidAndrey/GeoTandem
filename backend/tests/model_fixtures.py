"""The contract fixture of Modus B (``schema/model-cases/v1.json``, plan WP62).

One truth for the backend, the frontend's fake API and the e2e model stub. A
case's ``answer`` is what the model returns; ``completion`` turns it into what
``FakeLLMClient`` hands the service, so every later test scripts the model
from the same cases.
"""

import json
from functools import cache
from pathlib import Path
from typing import Any

from geotandem.llm import Completion, LLMError
from geotandem.llm.fake import FakeLLMClient

REPO = Path(__file__).parents[2]
CASES_FILE = REPO / "schema" / "model-cases" / "v1.json"

Case = dict[str, Any]


@cache
def fixture() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(CASES_FILE.read_text(encoding="utf-8"))
    return data


def cases() -> list[Case]:
    return list(fixture()["cases"])


def case(case_id: str) -> Case:
    found = next((c for c in cases() if c["id"] == case_id), None)
    if found is None:
        raise KeyError(f"no model case '{case_id}' in {CASES_FILE.name}")
    return found


def completion(c: Case) -> Completion | LLMError:
    """What the model gives back for ``c``: its answer as JSON text, its raw text,
    or the transport error it ends in."""
    if "llm_error" in c:
        return LLMError(c["llm_error"], f"scripted {c['llm_error']}")
    if "raw" in c:
        return Completion(text=c["raw"], parse_error="not JSON")
    text = json.dumps(c["answer"], ensure_ascii=False)
    return Completion(text=text, parsed=c["answer"])


def scripted(*case_ids: str) -> FakeLLMClient:
    """A fake model that answers the given cases in order."""
    return FakeLLMClient(script=[completion(case(i)) for i in case_ids])
