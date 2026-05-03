"""
System configuration APIs.

Handles non-provider global settings: default backends, audio, anthropic config.
Provider-specific configuration (API keys, rate limits, credentials, connection test)
is managed by the providers router.
"""

from __future__ import annotations

import asyncio
import json
import logging
import tomllib
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal, TypedDict
from urllib.parse import unquote, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException
from packaging.version import InvalidVersion, Version
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from lib import PROJECT_ROOT
from lib.config.registry import PROVIDER_REGISTRY
from lib.config.repository import mask_secret
from lib.config.resolver import ConfigResolver
from lib.config.service import (
    ConfigService,
    sync_anthropic_env,
)
from lib.db import get_async_session
from lib.httpx_shared import get_http_client
from lib.i18n import Translator
from lib.project_manager import ProjectManager
from server.auth import CurrentUser
from server.dependencies import get_config_service
from server.routers._validators import validate_backend_value
from server.services.travel_route import test_travel_map_provider

logger = logging.getLogger(__name__)

router = APIRouter()
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
pm = ProjectManager(PROJECT_ROOT / "projects")
_PYPROJECT_PATH = _PROJECT_ROOT / "pyproject.toml"
_GITHUB_RELEASE_LATEST_URL = "https://api.github.com/repos/ArcReel/ArcReel/releases/latest"
_GITHUB_USER_AGENT = "ArcReel"
_VERSION_CACHE_TTL_SECONDS = 300
_MAX_GITHUB_SKILL_BYTES = 512 * 1024
_latest_release_cache: dict[str, datetime | dict[str, str] | None] = {
    "expires_at": None,
    "payload": None,
    "fetched_at": None,
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def get_project_manager() -> ProjectManager:
    return pm


def _ensure_admin(user: CurrentUser) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin required")


class _OptionsDict(TypedDict):
    video_backends: list[str]
    image_backends: list[str]
    text_backends: list[str]
    agent_backends: list[str]
    provider_names: dict[str, str]


@lru_cache(maxsize=1)
def _read_app_version() -> str:
    with _PYPROJECT_PATH.open("rb") as f:
        data = tomllib.load(f)

    version = str(data["project"]["version"]).strip()
    if not version:
        raise RuntimeError("project.version is empty")
    return version


def _parse_version(raw: str) -> Version | None:
    text = raw.strip().removeprefix("v")
    if not text:
        return None
    try:
        return Version(text)
    except InvalidVersion:
        return None


def _build_latest_release_payload(data: dict[str, Any]) -> dict[str, str]:
    raw_version = str(data.get("name") or data.get("tag_name") or "").strip()
    return {
        "version": raw_version.removeprefix("v"),
        "tag_name": str(data.get("tag_name") or ""),
        "name": str(data.get("name") or ""),
        "body": str(data.get("body") or ""),
        "html_url": str(data.get("html_url") or ""),
        "published_at": str(data.get("published_at") or ""),
    }


async def _get_latest_release() -> tuple[dict[str, str], datetime]:
    """Fetch latest GitHub release with a 5-minute cache.

    Returns (payload, fetched_at) where fetched_at is the timestamp of the
    actual successful HTTP fetch (not the current request time). This makes
    the value safe to surface as `checked_at` to clients without misleading
    them about cache freshness.
    """
    now = datetime.now(UTC)
    expires_at = _latest_release_cache.get("expires_at")
    payload = _latest_release_cache.get("payload")
    fetched_at = _latest_release_cache.get("fetched_at")
    if (
        isinstance(expires_at, datetime)
        and expires_at > now
        and isinstance(payload, dict)
        and isinstance(fetched_at, datetime)
    ):
        return payload, fetched_at

    response = await get_http_client().get(
        _GITHUB_RELEASE_LATEST_URL,
        headers={"Accept": "application/vnd.github+json", "User-Agent": _GITHUB_USER_AGENT},
        timeout=5.0,
    )
    response.raise_for_status()
    payload = _build_latest_release_payload(response.json())

    _latest_release_cache["payload"] = payload
    _latest_release_cache["fetched_at"] = now
    _latest_release_cache["expires_at"] = now + timedelta(seconds=_VERSION_CACHE_TTL_SECONDS)
    return payload, now


async def _build_options(svc: ConfigService, session: AsyncSession) -> _OptionsDict:
    """Compute selectable backends from built-in and enabled custom providers."""
    buckets: dict[str, list[str]] = {
        "video_backends": [],
        "image_backends": [],
        "text_backends": [],
        "agent_backends": [],
    }
    provider_names: dict[str, str] = {}
    _MEDIA_TO_BUCKET = {"video": "video_backends", "image": "image_backends", "text": "text_backends"}

    for provider_id, meta in PROVIDER_REGISTRY.items():
        for model_id, model_info in meta.models.items():
            bucket = _MEDIA_TO_BUCKET.get(model_info.media_type)
            if bucket:
                buckets[bucket].append(f"{provider_id}/{model_id}")
            if model_info.media_type == "text":
                buckets["agent_backends"].append(f"{provider_id}/{model_id}")

    from lib.custom_provider import make_provider_id
    from lib.custom_provider.endpoints import endpoint_to_media_type
    from lib.db.repositories.custom_provider_repo import CustomProviderRepository

    try:
        repo = CustomProviderRepository(session, user_id=getattr(svc, "user_id", "default"))
        providers = await repo.list_providers()
        provider_name_map = {p.id: p.display_name for p in providers}
        enabled_models = await repo.list_all_enabled_models()
        for model in enabled_models:
            pid = make_provider_id(model.provider_id)
            media_type = endpoint_to_media_type(model.endpoint)
            bucket = _MEDIA_TO_BUCKET.get(media_type)
            if bucket:
                buckets[bucket].append(f"{pid}/{model.model_id}")
            if media_type == "text":
                buckets["agent_backends"].append(f"{pid}/{model.model_id}")
            if pid not in provider_names and model.provider_id in provider_name_map:
                provider_names[pid] = provider_name_map[model.provider_id]
    except Exception:
        pass  # Non-fatal: custom providers unavailable shouldn't break the options endpoint

    return {**buckets, "provider_names": provider_names}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class SystemConfigPatchRequest(BaseModel):
    default_video_backend: str | None = None
    default_image_backend: str | None = None
    default_text_backend: str | None = None
    video_generate_audio: bool | None = None
    anthropic_api_key: str | None = None
    google_maps_api_key: str | None = None
    baidu_maps_api_key: str | None = None
    amap_maps_api_key: str | None = None
    anthropic_base_url: str | None = None
    anthropic_model: str | None = None
    agent_model_backend: str | None = None
    anthropic_default_haiku_model: str | None = None
    anthropic_default_opus_model: str | None = None
    anthropic_default_sonnet_model: str | None = None
    claude_code_subagent_model: str | None = None
    agent_session_cleanup_delay_seconds: int | None = None
    agent_max_concurrent_sessions: int | None = None
    about_title: str | None = None
    about_subtitle: str | None = None
    about_body: str | None = None
    about_contact_label: str | None = None
    about_contact_url: str | None = None
    model_rule_configs: dict[str, Any] | None = None
    text_backend_script: str | None = None
    text_backend_overview: str | None = None
    text_backend_style: str | None = None


class MapProviderTestRequest(BaseModel):
    provider: Literal["google", "baidu", "amap"]
    api_key: str | None = None


class MapProviderTestResponse(BaseModel):
    success: bool
    provider: str
    message: str


class GithubSkillImportRequest(BaseModel):
    url: str


class GithubSkillImportResponse(BaseModel):
    skill_name: str
    skill_content: str
    raw_url: str


# Setting keys that map directly to string DB settings
_STRING_SETTINGS = (
    "anthropic_base_url",
    "anthropic_model",
    "agent_model_backend",
    "anthropic_default_haiku_model",
    "anthropic_default_opus_model",
    "anthropic_default_sonnet_model",
    "claude_code_subagent_model",
    "about_title",
    "about_subtitle",
    "about_body",
    "about_contact_label",
    "about_contact_url",
    "text_backend_script",
    "text_backend_overview",
    "text_backend_style",
)

_ABOUT_SETTINGS = frozenset(
    {
        "about_title",
        "about_subtitle",
        "about_body",
        "about_contact_label",
        "about_contact_url",
    }
)

_MODEL_RULE_MODES = frozenset({"default", "prompt", "github_skill", "uploaded_skill"})
_MODEL_SKILL_RUNTIMES = frozenset({"openai", "hermes_agent", "openclaw", "claude_code"})


def _parse_model_rule_configs(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Ignoring invalid model_rule_configs JSON")
        return {}
    if not isinstance(parsed, dict):
        return {}
    return _normalize_model_rule_configs(parsed)


def _normalize_model_rule_configs(value: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for model_key, config in value.items():
        model_id = str(model_key or "").strip()
        if not model_id or not isinstance(config, dict):
            continue

        mode = str(config.get("mode") or "default").strip()
        if mode not in _MODEL_RULE_MODES:
            mode = "default"

        runtime = str(config.get("skill_runtime") or "").strip()
        if runtime not in _MODEL_SKILL_RUNTIMES:
            runtime = "openai"

        prompt = str(config.get("prompt") or "").strip()
        github_url = str(config.get("skill_github_url") or "").strip()
        skill_name = str(config.get("skill_name") or "").strip()
        skill_content = str(config.get("skill_content") or "").strip()

        next_config: dict[str, str] = {"mode": mode}
        if mode == "default":
            normalized[model_id] = next_config
            continue

        if mode == "prompt":
            next_config["prompt"] = prompt
            normalized[model_id] = next_config
            continue

        next_config["skill_runtime"] = runtime
        if mode == "github_skill" and github_url:
            next_config["skill_github_url"] = github_url
        if skill_name:
            next_config["skill_name"] = skill_name
        if skill_content:
            next_config["skill_content"] = skill_content

        normalized[model_id] = next_config
    return normalized


def _raw_github_url(owner: str, repo: str, ref: str, file_path: str) -> str:
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{file_path.lstrip('/')}"


def _github_skill_candidates(input_url: str) -> list[tuple[str, str]]:
    """Resolve common GitHub Skill links into raw file candidates.

    Supports:
    - raw.githubusercontent.com/owner/repo/ref/path/SKILL.md
    - github.com/owner/repo/blob/ref/path/SKILL.md
    - github.com/owner/repo/tree/ref/path/to/skill-dir
    - github.com/owner/repo
    """
    text = input_url.strip()
    parsed = urlparse(text)
    if parsed.scheme not in {"https", "http"}:
        return []

    candidates: list[tuple[str, str]] = []
    if parsed.hostname == "raw.githubusercontent.com":
        path = unquote(parsed.path.lstrip("/"))
        name = path.split("/", 3)[-1] if path.count("/") >= 3 else path.rsplit("/", 1)[-1]
        return [(text, name or "SKILL.md")]

    if parsed.hostname != "github.com":
        return []

    parts = [unquote(p) for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        return []

    owner, repo = parts[0], parts[1]
    if len(parts) == 2:
        candidates.append((_raw_github_url(owner, repo, "main", "SKILL.md"), "SKILL.md"))
        candidates.append((_raw_github_url(owner, repo, "master", "SKILL.md"), "SKILL.md"))
        return candidates

    mode = parts[2]
    if mode == "blob" and len(parts) >= 5:
        ref = parts[3]
        file_path = "/".join(parts[4:])
        candidates.append((_raw_github_url(owner, repo, ref, file_path), file_path))
        return candidates

    if mode == "tree" and len(parts) >= 4:
        ref = parts[3]
        dir_path = "/".join(parts[4:])
        skill_path = f"{dir_path.rstrip('/')}/SKILL.md" if dir_path else "SKILL.md"
        candidates.append((_raw_github_url(owner, repo, ref, skill_path), skill_path))
        return candidates

    return []


async def _download_github_skill(input_url: str, _t: Translator) -> GithubSkillImportResponse:
    candidates = _github_skill_candidates(input_url)
    if not candidates:
        raise HTTPException(status_code=422, detail=_t("model_rule_github_url_invalid"))

    try:
        client = get_http_client()
    except RuntimeError:
        client = httpx.AsyncClient(timeout=10.0, follow_redirects=True)
        should_close = True
    else:
        should_close = False

    try:
        last_error = ""
        for raw_url, skill_name in candidates:
            try:
                response = await client.get(
                    raw_url,
                    headers={"Accept": "text/plain,*/*", "User-Agent": _GITHUB_USER_AGENT},
                    follow_redirects=True,
                    timeout=10.0,
                )
            except Exception as exc:
                last_error = str(exc)
                continue

            if response.status_code == 404:
                last_error = "404"
                continue
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                last_error = f"{exc.response.status_code} {exc.response.reason_phrase}"
                continue

            content = response.content
            if len(content) > _MAX_GITHUB_SKILL_BYTES:
                raise HTTPException(status_code=413, detail=_t("model_rule_github_too_large"))

            text = response.text
            if not text.strip():
                raise HTTPException(status_code=422, detail=_t("model_rule_github_empty"))

            return GithubSkillImportResponse(
                skill_name=skill_name or "SKILL.md",
                skill_content=text,
                raw_url=raw_url,
            )

        detail = _t("model_rule_github_not_found")
        if last_error and last_error != "404":
            detail = _t("model_rule_github_fetch_failed", message=last_error)
        raise HTTPException(status_code=422, detail=detail)
    finally:
        if should_close:
            await client.aclose()


# ---------------------------------------------------------------------------
# GET /system/config
# ---------------------------------------------------------------------------


@router.get("/system/config")
async def get_system_config(
    _user: CurrentUser,
    svc: Annotated[ConfigService, Depends(get_config_service)],
    session: AsyncSession = Depends(get_async_session),
) -> dict[str, Any]:
    # Read all settings in a single query
    all_s = await svc.get_all_settings()
    video_generate_audio_raw = all_s.get("video_generate_audio", "")
    video_generate_audio = (
        video_generate_audio_raw.lower() in ("true", "1", "yes")
        if video_generate_audio_raw
        else ConfigResolver._DEFAULT_VIDEO_GENERATE_AUDIO
    )
    anthropic_key = all_s.get("anthropic_api_key", "")
    google_maps_key = all_s.get("google_maps_api_key", "")
    baidu_maps_key = all_s.get("baidu_maps_api_key", "")
    amap_maps_key = all_s.get("amap_maps_api_key", "")

    settings: dict[str, Any] = {
        "default_video_backend": all_s.get("default_video_backend", ""),
        "default_image_backend": all_s.get("default_image_backend", ""),
        "default_text_backend": all_s.get("default_text_backend", ""),
        "video_generate_audio": video_generate_audio,
        "anthropic_api_key": {
            "is_set": bool(anthropic_key),
            "masked": mask_secret(anthropic_key) if anthropic_key else None,
        },
        "google_maps_api_key": {
            "is_set": bool(google_maps_key),
            "masked": mask_secret(google_maps_key) if google_maps_key else None,
        },
        "baidu_maps_api_key": {
            "is_set": bool(baidu_maps_key),
            "masked": mask_secret(baidu_maps_key) if baidu_maps_key else None,
        },
        "amap_maps_api_key": {
            "is_set": bool(amap_maps_key),
            "masked": mask_secret(amap_maps_key) if amap_maps_key else None,
        },
        "anthropic_base_url": all_s.get("anthropic_base_url") or None,
        "anthropic_model": all_s.get("anthropic_model") or None,
        "agent_model_backend": all_s.get("agent_model_backend") or "",
        "anthropic_default_haiku_model": all_s.get("anthropic_default_haiku_model") or None,
        "anthropic_default_opus_model": all_s.get("anthropic_default_opus_model") or None,
        "anthropic_default_sonnet_model": all_s.get("anthropic_default_sonnet_model") or None,
        "claude_code_subagent_model": all_s.get("claude_code_subagent_model") or None,
        "agent_session_cleanup_delay_seconds": int(all_s.get("agent_session_cleanup_delay_seconds") or "300"),
        "agent_max_concurrent_sessions": int(all_s.get("agent_max_concurrent_sessions") or "5"),
        "about_title": all_s.get("about_title") or "",
        "about_subtitle": all_s.get("about_subtitle") or "",
        "about_body": all_s.get("about_body") or "",
        "about_contact_label": all_s.get("about_contact_label") or "",
        "about_contact_url": all_s.get("about_contact_url") or "",
        "model_rule_configs": _parse_model_rule_configs(all_s.get("model_rule_configs")),
        "text_backend_script": all_s.get("text_backend_script") or "",
        "text_backend_overview": all_s.get("text_backend_overview") or "",
        "text_backend_style": all_s.get("text_backend_style") or "",
    }

    options = await _build_options(svc, session)

    return {"settings": settings, "options": options}


@router.get("/system/version")
async def get_system_version(
    _user: CurrentUser,
    _t: Translator,
) -> dict[str, Any]:
    try:
        current_version = _read_app_version()
    except Exception as exc:
        logger.exception("Failed to read app version")
        raise HTTPException(status_code=500, detail=_t("about_version_read_failed")) from exc

    latest: dict[str, str] | None = None
    has_update = False
    update_check_error: str | None = None
    checked_at: datetime = datetime.now(UTC)
    try:
        latest, checked_at = await _get_latest_release()
        latest_v = _parse_version(latest["version"])
        current_v = _parse_version(current_version)
        if latest_v is not None and current_v is not None:
            has_update = latest_v > current_v
    except Exception as exc:
        logger.warning("Failed to fetch latest release: %s", exc)
        update_check_error = _t("about_update_check_failed")

    return {
        "current": {"version": current_version},
        "latest": latest,
        "has_update": has_update,
        "checked_at": checked_at.isoformat(),
        "update_check_error": update_check_error,
    }


@router.post("/system/maps/test", response_model=MapProviderTestResponse)
async def test_system_map_provider(
    req: MapProviderTestRequest,
    _user: CurrentUser,
    svc: Annotated[ConfigService, Depends(get_config_service)],
) -> MapProviderTestResponse:
    provider = req.provider
    setting_by_provider = {
        "google": "google_maps_api_key",
        "baidu": "baidu_maps_api_key",
        "amap": "amap_maps_api_key",
    }
    api_key = (req.api_key or "").strip()
    if not api_key:
        api_key = (await svc.get_setting(setting_by_provider[provider], "")).strip()

    result = await test_travel_map_provider(provider, api_key=api_key)
    return MapProviderTestResponse(**result)


@router.post("/system/model-rules/import-github-skill", response_model=GithubSkillImportResponse)
async def import_github_skill(
    req: GithubSkillImportRequest,
    _user: CurrentUser,
    _t: Translator,
) -> GithubSkillImportResponse:
    return await _download_github_skill(req.url, _t)


# ---------------------------------------------------------------------------
# Legacy Project Namespace Migration
# ---------------------------------------------------------------------------


@router.get("/system/project-namespace-migration")
async def preview_project_namespace_migration(
    _user: CurrentUser,
) -> dict[str, Any]:
    _ensure_admin(_user)
    return await asyncio.to_thread(get_project_manager().migrate_legacy_user_namespaces, dry_run=True)


@router.post("/system/project-namespace-migration")
async def run_project_namespace_migration(
    _user: CurrentUser,
) -> dict[str, Any]:
    _ensure_admin(_user)
    return await asyncio.to_thread(get_project_manager().migrate_legacy_user_namespaces, dry_run=False)


# ---------------------------------------------------------------------------
# PATCH /system/config
# ---------------------------------------------------------------------------


@router.patch("/system/config")
async def patch_system_config(
    req: SystemConfigPatchRequest,
    _user: CurrentUser,
    svc: Annotated[ConfigService, Depends(get_config_service)],
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    for field_name in req.model_fields_set:
        patch[field_name] = getattr(req, field_name)

    if _ABOUT_SETTINGS.intersection(patch):
        _ensure_admin(_user)

    # Validate backend references (empty string = auto-resolve)
    for backend_key in ("default_video_backend", "default_image_backend", "default_text_backend", "agent_model_backend"):
        if backend_key in patch:
            value = str(patch[backend_key] or "").strip()
            if value:
                validate_backend_value(value, backend_key, _t)
            if backend_key == "agent_model_backend":
                patch[backend_key] = value
            else:
                await svc.set_setting(backend_key, value)

    # Boolean settings
    if "video_generate_audio" in patch and patch["video_generate_audio"] is not None:
        await svc.set_setting("video_generate_audio", "true" if patch["video_generate_audio"] else "false")

    # Anthropic API key (secret)
    if "anthropic_api_key" in patch:
        value = patch["anthropic_api_key"]
        if value:
            await svc.set_setting("anthropic_api_key", str(value).strip())
        else:
            await svc.set_setting("anthropic_api_key", "")

    # Map provider API keys (optional secrets for travel-video enrichment)
    for maps_key in ("google_maps_api_key", "baidu_maps_api_key", "amap_maps_api_key"):
        if maps_key in patch:
            value = patch[maps_key]
            if value:
                await svc.set_setting(maps_key, str(value).strip())
            else:
                await svc.set_setting(maps_key, "")

    # Integer settings with range validation
    _INT_SETTINGS_RANGES = {
        "agent_session_cleanup_delay_seconds": (10, 3600),
        "agent_max_concurrent_sessions": (1, 20),
    }
    for key, (min_val, max_val) in _INT_SETTINGS_RANGES.items():
        if key in patch and patch[key] is not None:
            value = int(patch[key])
            if not (min_val <= value <= max_val):
                raise HTTPException(
                    status_code=422,
                    detail=f"{key} 应在 {min_val}-{max_val} 之间",
                )
            await svc.set_setting(key, str(value))

    if "model_rule_configs" in patch:
        raw_value = patch["model_rule_configs"]
        if raw_value is not None and not isinstance(raw_value, dict):
            raise HTTPException(status_code=422, detail="model_rule_configs must be an object")
        normalized = _normalize_model_rule_configs(raw_value or {})
        await svc.set_setting("model_rule_configs", json.dumps(normalized, ensure_ascii=False))

    # String settings
    for key in _STRING_SETTINGS:
        if key in patch:
            value = patch[key]
            await svc.set_setting(key, str(value).strip() if value else "")

    await session.commit()

    # Sync Anthropic settings to env vars so Claude Agent SDK picks them up
    all_settings = await svc.get_all_settings()
    sync_anthropic_env(all_settings)

    # Return updated config
    return await get_system_config(_user=_user, svc=svc, session=session)
