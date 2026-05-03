"""视频生成服务层公共 API。"""

from __future__ import annotations

from importlib import import_module
from typing import Any

from lib.providers import (
    PROVIDER_ARK,
    PROVIDER_GEMINI,
    PROVIDER_GROK,
    PROVIDER_NEWAPI,
    PROVIDER_OPENAI,
    PROVIDER_QA_FAKE,
)
from lib.video_backends.base import (
    VideoBackend,
    VideoCapability,
    VideoGenerationRequest,
    VideoGenerationResult,
)
from lib.video_backends.registry import create_backend, get_registered_backends, register_backend

__all__ = [
    "PROVIDER_ARK",
    "PROVIDER_GEMINI",
    "PROVIDER_GROK",
    "PROVIDER_NEWAPI",
    "PROVIDER_OPENAI",
    "PROVIDER_QA_FAKE",
    "VideoBackend",
    "VideoCapability",
    "VideoGenerationRequest",
    "VideoGenerationResult",
    "create_backend",
    "get_registered_backends",
    "register_backend",
]

_BACKEND_EXPORTS = {
    "GeminiVideoBackend": ("lib.video_backends.gemini", "GeminiVideoBackend"),
    "ArkVideoBackend": ("lib.video_backends.ark", "ArkVideoBackend"),
    "GrokVideoBackend": ("lib.video_backends.grok", "GrokVideoBackend"),
    "OpenAIVideoBackend": ("lib.video_backends.openai", "OpenAIVideoBackend"),
    "NewAPIVideoBackend": ("lib.video_backends.newapi", "NewAPIVideoBackend"),
    "QAFakeVideoBackend": ("lib.video_backends.qa_fake", "QAFakeVideoBackend"),
}


def _lazy_backend_factory(module_name: str, class_name: str):
    def _factory(**kwargs: Any) -> VideoBackend:
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


# Auto-register backend names without importing provider SDKs at package import time.
register_backend(PROVIDER_GEMINI, _lazy_backend_factory("lib.video_backends.gemini", "GeminiVideoBackend"))
register_backend(PROVIDER_ARK, _lazy_backend_factory("lib.video_backends.ark", "ArkVideoBackend"))
register_backend(PROVIDER_GROK, _lazy_backend_factory("lib.video_backends.grok", "GrokVideoBackend"))
register_backend(PROVIDER_OPENAI, _lazy_backend_factory("lib.video_backends.openai", "OpenAIVideoBackend"))
register_backend(PROVIDER_NEWAPI, _lazy_backend_factory("lib.video_backends.newapi", "NewAPIVideoBackend"))
register_backend(PROVIDER_QA_FAKE, _lazy_backend_factory("lib.video_backends.qa_fake", "QAFakeVideoBackend"))
