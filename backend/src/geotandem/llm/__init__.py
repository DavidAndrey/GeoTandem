"""The model seam (F-7.3, plan E2.1): services use ``LLMClient``; only
``openai_compat`` knows the wire protocol."""

from geotandem.llm.client import (
    EFFORTS,
    ClientFactory,
    Completion,
    Effort,
    Endpoint,
    LLMClient,
    LLMError,
    Message,
    ModelInfo,
    ToolCall,
    ToolSpec,
)
from geotandem.llm.hosts import LOCAL_HOSTS, Locality, classify_host, host_of

__all__ = [
    "EFFORTS",
    "LOCAL_HOSTS",
    "ClientFactory",
    "Completion",
    "Effort",
    "Endpoint",
    "LLMClient",
    "LLMError",
    "Locality",
    "Message",
    "ModelInfo",
    "ToolCall",
    "ToolSpec",
    "classify_host",
    "host_of",
]
