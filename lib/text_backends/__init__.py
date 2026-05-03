"""文本生成服务层公共 API。"""

from __future__ import annotations

from importlib import import_module
from typing import Any

from lib.text_backends.base import (
    ImageInput,
    TextBackend,
    TextCapability,
    TextGenerationRequest,
    TextGenerationResult,
    TextTaskType,
)
from lib.text_backends.registry import create_backend, get_registered_backends, register_backend

__all__ = [
    "ImageInput",
    "TextBackend",
    "TextCapability",
    "TextGenerationRequest",
    "TextGenerationResult",
    "TextTaskType",
    "create_backend",
    "get_registered_backends",
    "register_backend",
]

from lib.providers import PROVIDER_ARK, PROVIDER_GEMINI, PROVIDER_GROK, PROVIDER_OPENAI, PROVIDER_QA_FAKE

_BACKEND_EXPORTS = {
    "GeminiTextBackend": ("lib.text_backends.gemini", "GeminiTextBackend"),
    "ArkTextBackend": ("lib.text_backends.ark", "ArkTextBackend"),
    "GrokTextBackend": ("lib.text_backends.grok", "GrokTextBackend"),
    "OpenAITextBackend": ("lib.text_backends.openai", "OpenAITextBackend"),
    "QAFakeTextBackend": ("lib.text_backends.qa_fake", "QAFakeTextBackend"),
}


def _lazy_backend_factory(module_name: str, class_name: str):
    def _factory(**kwargs: Any) -> TextBackend:
        backend_cls = getattr(import_module(module_name), class_name)
        return backend_cls(**kwargs)

    return _factory


def __getattr__(name: str):
    if name not in _BACKEND_EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, class_name = _BACKEND_EXPORTS[name]
    attr = getattr(import_module(module_name), class_name)
    globals()[name] = attr
    return attr


# Backend auto-registration without importing provider SDKs at package import time.
register_backend(PROVIDER_GEMINI, _lazy_backend_factory("lib.text_backends.gemini", "GeminiTextBackend"))
register_backend(PROVIDER_ARK, _lazy_backend_factory("lib.text_backends.ark", "ArkTextBackend"))
register_backend(PROVIDER_GROK, _lazy_backend_factory("lib.text_backends.grok", "GrokTextBackend"))
register_backend(PROVIDER_OPENAI, _lazy_backend_factory("lib.text_backends.openai", "OpenAITextBackend"))
register_backend(PROVIDER_QA_FAKE, _lazy_backend_factory("lib.text_backends.qa_fake", "QAFakeTextBackend"))
