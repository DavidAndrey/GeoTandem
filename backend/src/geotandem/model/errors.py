"""Errors of the model path that are not refusals (plan E2.3-E2.6, WP64).

A refusal (``Refusal``) is the application's verdict on an answer the model
gave: the record keeps the answer and its query. An ``ActionError`` means
there is no answer to judge: the request was too large to send, or the
model's reply could not be read. Transport failures stay ``LLMError`` from
the seam (``llm_*``).
"""

from typing import Any

from geotandem.model.schemas import ActionErrorCode


class ActionError(Exception):
    """``{code, message, details}`` as every error body; ``status`` is the HTTP
    status a route answers with when the error ends the request itself."""

    def __init__(
        self, code: ActionErrorCode, message: str, *, status: int = 400, **details: Any
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details
