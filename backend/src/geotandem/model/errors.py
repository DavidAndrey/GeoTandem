"""Errors of the model path that are not refusals (plan E2.3-E2.6, WP64).

A refusal (``Refusal``) is the application's verdict on an answer the model
gave: the record keeps the answer and its query. An ``ActionError`` means
there is no answer to judge (the request was too large to send, the model's
reply could not be read), no record to act on (``not_found``), or a step the
record does not allow (``already_decided``, ``not_approved``, ...; the store,
WP63). Transport failures stay ``LLMError`` from the seam (``llm_*``). One
handler in ``api/errors.py`` turns it into the common error body.
"""

from typing import Any, Literal

from geotandem.model.schemas import ActionErrorCode

ErrorCode = ActionErrorCode | Literal["not_found", "bad_request"]


class ActionError(Exception):
    """``{code, message, details}`` as every error body; ``status`` is the HTTP
    status a route answers with when the error ends the request itself. The
    keyword is ``http_status`` because ``details.status`` names a record's
    status in several codes (``already_decided``, ``not_approved``)."""

    def __init__(
        self, code: ErrorCode, message: str, *, http_status: int = 400, **details: Any
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = http_status
        self.details = details
