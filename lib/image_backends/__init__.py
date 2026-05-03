"""图片生成服务层公共 API。"""

from __future__ import annotations

from importlib import import_module
from typing import Any

from lib.image_backends.base import (
    ImageBackend,
    ImageCapability,
    ImageGenerationRequest,
    ImageGenerationResult,
    ReferenceImage,
)
from lib.image_backends.registry import create_backend, get_registered_backends, register_backend

__all__ = [
    "ImageBackend",
    "ImageCapability",
    "ImageGenerationRequest",
    "ImageGenerationResult",
    "ReferenceImage",
    "create_backend",
    "get_registered_backends",
    "register_backend",
]

from lib.providers import PROVIDER_ARK, PROVIDER_GEMINI, PROVIDER_GROK, PROVIDER_OPENAI

_BACKEND_EXPORTS = {
    "GeminiImageBackend": ("lib.image_backends.gemini", "GeminiImageBackend"),
    "ArkImageBackend": ("lib.image_backends.ark", "ArkImageBackend"),
    "GrokImageBackend": ("lib.image_backends.grok", "GrokImageBackend"),
    "OpenAIImageBackend": ("lib.image_backends.openai", "OpenAIImageBackend"),
}


def _lazy_backend_factory(module_name: str, class_name: str):
    def _factory(**kwargs: Any) -> ImageBackend:
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
register_backend(PROVIDER_GEMINI, _lazy_backend_factory("lib.image_backends.gemini", "GeminiImageBackend"))
register_backend(PROVIDER_ARK, _lazy_backend_factory("lib.image_backends.ark", "ArkImageBackend"))
register_backend(PROVIDER_GROK, _lazy_backend_factory("lib.image_backends.grok", "GrokImageBackend"))
register_backend(PROVIDER_OPENAI, _lazy_backend_factory("lib.image_backends.openai", "OpenAIImageBackend"))
