"""Model-specific generation rule helpers."""

from __future__ import annotations

import json
import logging
from html import escape
from typing import Any

from lib.config.service import ConfigService
from lib.db import async_session_factory
from lib.db.base import DEFAULT_USER_ID

logger = logging.getLogger(__name__)

_RULE_MODES = frozenset({"default", "prompt", "github_skill", "uploaded_skill"})
_SKILL_RUNTIMES = frozenset({"openai", "hermes_agent", "openclaw", "claude_code"})
_MEDIA_TYPES = frozenset({"image", "video"})
MEDIA_RULE_PREFIX = "__media__/"


def media_rule_key(media_type: str) -> str:
    return f"{MEDIA_RULE_PREFIX}{media_type}"


def normalize_model_rule_configs(raw: str | dict[str, Any] | None) -> dict[str, dict[str, str]]:
    if raw is None or raw == "":
        return {}
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Ignoring invalid model_rule_configs JSON")
            return {}
    else:
        parsed = raw
    if not isinstance(parsed, dict):
        return {}

    normalized: dict[str, dict[str, str]] = {}
    for model_key, config in parsed.items():
        key = str(model_key or "").strip()
        if not key or not isinstance(config, dict):
            continue
        mode = str(config.get("mode") or "default").strip()
        if mode not in _RULE_MODES:
            mode = "default"

        if mode == "default":
            normalized[key] = {"mode": "default"}
            continue
        if mode == "prompt":
            normalized[key] = {
                "mode": "prompt",
                "prompt": str(config.get("prompt") or "").strip(),
            }
            continue

        runtime = str(config.get("skill_runtime") or "").strip()
        if runtime not in _SKILL_RUNTIMES:
            runtime = "openai"
        rule: dict[str, str] = {
            "mode": mode,
            "skill_runtime": runtime,
        }
        if mode == "github_skill":
            github_url = str(config.get("skill_github_url") or "").strip()
            if github_url:
                rule["skill_github_url"] = github_url
        skill_name = str(config.get("skill_name") or "").strip()
        skill_content = str(config.get("skill_content") or "").strip()
        if skill_name:
            rule["skill_name"] = skill_name
        if skill_content:
            rule["skill_content"] = skill_content
        normalized[key] = rule
    return normalized


def resolve_model_rule_config(
    configs: dict[str, dict[str, str]],
    provider_id: str,
    model_id: str,
    *,
    backend_name: str | None = None,
    media_type: str | None = None,
) -> dict[str, str] | None:
    provider_id = str(provider_id or "").strip()
    model_id = str(model_id or "").strip()
    normalized_media_type = str(media_type or "").strip()

    if model_id:
        exact_key = f"{provider_id}/{model_id}" if provider_id else model_id
        if exact_key in configs:
            return configs[exact_key]

        if backend_name:
            backend_key = f"{backend_name.strip()}/{model_id}"
            if backend_key in configs:
                return configs[backend_key]

        suffix = f"/{model_id}"
        for key, config in configs.items():
            if key.endswith(suffix):
                return config
    if normalized_media_type in _MEDIA_TYPES:
        if config := configs.get(media_rule_key(normalized_media_type)):
            return config
    return None


def render_model_rule_appendix(config: dict[str, str] | None) -> str:
    if not config:
        return ""
    mode = config.get("mode") or "default"
    if mode == "default":
        return ""
    if mode == "prompt":
        prompt = (config.get("prompt") or "").strip()
        if not prompt:
            return ""
        return f"\n\n<model_rule source=\"prompt\">\n{prompt}\n</model_rule>"
    if mode in {"github_skill", "uploaded_skill"}:
        content = (config.get("skill_content") or "").strip()
        if not content:
            return ""
        source = "github_skill" if mode == "github_skill" else "uploaded_skill"
        runtime = config.get("skill_runtime") or "openai"
        safe_runtime = escape(runtime, quote=True)
        safe_name = escape(config.get("skill_name") or "SKILL.md", quote=True)
        url_attr = ""
        if mode == "github_skill" and config.get("skill_github_url"):
            url_attr = f' url="{escape(config["skill_github_url"], quote=True)}"'
        return (
            f"\n\n<model_rule source=\"{source}\" runtime=\"{safe_runtime}\" name=\"{safe_name}\"{url_attr}>\n"
            f"{content}\n"
            "</model_rule>"
        )
    return ""


async def load_model_rule_config(
    *,
    provider_id: str,
    model_id: str,
    backend_name: str | None = None,
    media_type: str | None = None,
    user_id: str = DEFAULT_USER_ID,
) -> dict[str, str] | None:
    async with async_session_factory() as session:
        svc = ConfigService(session, user_id=user_id)
        raw = await svc.get_setting("model_rule_configs", "{}")
    configs = normalize_model_rule_configs(raw)
    return resolve_model_rule_config(
        configs,
        provider_id,
        model_id,
        backend_name=backend_name,
        media_type=media_type,
    )


async def append_model_rule_for_model(
    prompt: str,
    *,
    provider_id: str,
    model_id: str,
    backend_name: str | None = None,
    media_type: str | None = None,
    user_id: str = DEFAULT_USER_ID,
) -> str:
    config = await load_model_rule_config(
        provider_id=provider_id,
        model_id=model_id,
        backend_name=backend_name,
        media_type=media_type,
        user_id=user_id,
    )
    appendix = render_model_rule_appendix(config)
    if not appendix:
        return prompt
    return f"{prompt}{appendix}"
