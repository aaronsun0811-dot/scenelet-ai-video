"""Built-in provider Base URL defaults.

Only include providers whose official text API is intentionally consumed
through an OpenAI-compatible endpoint. Mixed text/video gateway providers stay
manual so a text default does not accidentally break video routing.
"""

from __future__ import annotations

from lib.config.url_utils import normalize_base_url

DEFAULT_PROVIDER_BASE_URLS: dict[str, str] = {
    "deepseek": "https://api.deepseek.com/",
    "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1/",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4/",
    "moonshot": "https://api.moonshot.cn/v1/",
}


def resolve_provider_base_url(provider_id: str, base_url: str | None) -> str | None:
    """Return a user-provided Base URL or a conservative built-in default."""
    if base_url:
        return normalize_base_url(base_url)
    return DEFAULT_PROVIDER_BASE_URLS.get(provider_id)
