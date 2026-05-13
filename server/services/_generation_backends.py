"""Backend resolution + MediaGenerator construction.

Extracted from ``generation_tasks.py`` so the main service module stays focused
on task executors. Owns the cross-task backend cache, the provider→registry
name mapping, and the assembly of :class:`MediaGenerator` instances.

All public symbols are re-exported from ``generation_tasks`` so existing
imports (routers, worker, tests, sub-modules) keep working unchanged.

``get_project_manager_for_user`` is looked up via the main module so test
monkeypatches on ``generation_tasks.get_project_manager`` apply here too.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from lib.custom_provider import is_custom_provider
from lib.db.base import DEFAULT_USER_ID, PLATFORM_USER_ID
from lib.gemini_shared import get_shared_rate_limiter
from lib.media_generator import MediaGenerator
from lib.provider_base_urls import resolve_provider_base_url
from lib.providers import PROVIDER_ARK, PROVIDER_GEMINI, PROVIDER_GROK, PROVIDER_NEWAPI, PROVIDER_OPENAI

if TYPE_CHECKING:
    from lib.config.resolver import ConfigResolver

logger = logging.getLogger(__name__)

rate_limiter = get_shared_rate_limiter()

# 按 (channel, provider_name, model) 缓存 Backend 实例，避免每次任务重建 API 客户端
_backend_cache: dict[tuple[str, ...], Any] = {}

# 新 provider_id → 旧 backend registry name 的映射
_PROVIDER_ID_TO_BACKEND: dict[str, str] = {
    "gemini-aistudio": PROVIDER_GEMINI,
    "gemini-vertex": PROVIDER_GEMINI,
    PROVIDER_GEMINI: PROVIDER_GEMINI,
    PROVIDER_ARK: PROVIDER_ARK,
    PROVIDER_GROK: PROVIDER_GROK,
    PROVIDER_OPENAI: PROVIDER_OPENAI,
    "baidu": PROVIDER_OPENAI,
    "qwen": PROVIDER_OPENAI,
    "zhipu": PROVIDER_OPENAI,
    "deepseek": PROVIDER_OPENAI,
    "moonshot": PROVIDER_OPENAI,
    "minimax": PROVIDER_OPENAI,
    "hunyuan": PROVIDER_OPENAI,
    "anthropic": PROVIDER_OPENAI,
    "midjourney": PROVIDER_OPENAI,
    "jimeng": PROVIDER_OPENAI,
}
_VIDEO_PROVIDER_ID_TO_BACKEND: dict[str, str] = {
    **_PROVIDER_ID_TO_BACKEND,
    "luma": PROVIDER_NEWAPI,
    "pika": PROVIDER_NEWAPI,
    "runway": PROVIDER_NEWAPI,
    "kling": PROVIDER_NEWAPI,
    "minimax": PROVIDER_NEWAPI,
    "jimeng": PROVIDER_NEWAPI,
}
_IMAGE_PROVIDER_ID_TO_BACKEND: dict[str, str] = {
    **_PROVIDER_ID_TO_BACKEND,
    "midjourney": PROVIDER_OPENAI,
    "jimeng": PROVIDER_OPENAI,
}


def _gt():
    """Deferred lookup of generation_tasks helpers to avoid circular import."""
    from server.services import generation_tasks as _main

    return _main


def invalidate_backend_cache() -> None:
    """清空 VideoBackend 实例缓存。在配置变更后调用。"""
    _backend_cache.clear()


def resolve_credential_user_id(project: dict, user_id: str = DEFAULT_USER_ID) -> str:
    """Return whose provider credentials should be used for this project."""
    return PLATFORM_USER_ID if project.get("billing_mode") == "platform_credits" else user_id


def _parse_project_backend(raw: str | None) -> tuple[str | None, str | None]:
    """解析 project.json 中 ``video_backend`` / ``image_backend`` 的 ``"provider/model"`` 格式。"""
    if not raw:
        return None, None
    if "/" in raw:
        provider, model = raw.split("/", 1)
        return provider, model
    return raw, None


async def _resolve_effective_image_backend(
    project: dict,
    payload: dict | None,
    *,
    user_id: str = DEFAULT_USER_ID,
) -> tuple[str, str]:
    """payload 覆盖 > project.image_backend > resolver 全局默认。

    返回 (provider_id, model_id)。供 resolve_resolution 构 key 使用，
    确保 payload 缺失 image_provider 时也能命中 project.model_settings。
    全局默认失败（未配置供应商）时返回空串，调用方按 None 处理。
    """
    if payload:
        provider = payload.get("image_provider") or ""
        if provider:
            return provider, payload.get("image_model") or ""
    proj_provider, proj_model = _parse_project_backend(project.get("image_backend"))
    if proj_provider:
        return proj_provider, proj_model or ""
    from lib.config.resolver import ConfigResolver
    from lib.db import async_session_factory

    resolver = ConfigResolver(async_session_factory, user_id=resolve_credential_user_id(project, user_id))
    try:
        async with resolver.session() as r:
            provider, model = await r.default_image_backend()
    except Exception:
        return "", ""
    return provider or "", model or ""


async def _create_custom_backend(
    provider_name: str,
    model_id: str | None,
    media_type: str,
    *,
    user_id: str = DEFAULT_USER_ID,
):
    """自定义供应商的 backend 创建路径。

    media_type 仅用于回退到默认模型时分组（仍接收以兼容调用方调用语义）。
    实际派发以 model.endpoint 为准；若 endpoint 推算 media_type 与 caller 传入不符 → 视为模型不存在并 fallback。
    """
    from lib.custom_provider import parse_provider_id
    from lib.custom_provider.endpoints import endpoint_to_media_type
    from lib.custom_provider.factory import create_custom_backend
    from lib.db import async_session_factory
    from lib.db.repositories.custom_provider_repo import CustomProviderRepository

    async with async_session_factory() as session:
        repo = CustomProviderRepository(session, user_id=user_id)
        db_id = parse_provider_id(provider_name)
        provider = await repo.get_provider(db_id)
        if provider is None:
            raise ValueError(f"自定义供应商 {provider_name} 不存在")

        model = None
        if model_id:
            candidate = await repo.get_model_by_ids(db_id, model_id)
            if candidate and candidate.is_enabled and endpoint_to_media_type(candidate.endpoint) == media_type:
                model = candidate
            else:
                logger.warning(
                    "自定义模型 %s/%s 已不存在 / 已禁用 / 媒体类型不符（期望 %s），回退到默认模型",
                    provider_name,
                    model_id,
                    media_type,
                )
                model_id = None

        if model is None:
            default_model = await repo.get_default_model(db_id, media_type)
            if default_model is None:
                raise ValueError(f"自定义供应商 {provider_name} 没有默认 {media_type} 模型")
            model = default_model
            model_id = default_model.model_id

        return create_custom_backend(provider=provider, model_id=model_id, endpoint=model.endpoint)


async def _fill_simple_provider_kwargs(
    config_provider_id: str,
    backend_name: str,
    resolver: ConfigResolver,
    kwargs: dict,
    effective_model: str | None,
) -> None:
    """Ark/Grok/OpenAI 等简单供应商的通用配置填充。"""
    db_config = await resolver.provider_config(config_provider_id)
    kwargs["api_key"] = db_config.get("api_key")
    kwargs["model"] = effective_model
    base_url = (
        resolve_provider_base_url(config_provider_id, db_config.get("base_url"))
        if backend_name == PROVIDER_OPENAI
        else db_config.get("base_url")
    )
    if base_url:
        kwargs["base_url"] = base_url


async def _get_or_create_video_backend(
    provider_name: str,
    provider_settings: dict,
    resolver: ConfigResolver,
    *,
    default_video_model: str | None = None,
):
    """获取或创建 VideoBackend 实例（带缓存）。

    provider_name 可以是旧格式（gemini/seedance/grok）或新格式（gemini-aistudio/gemini-vertex）。
    通过 resolver 按需加载供应商配置。
    default_video_model: 全局默认视频模型，当 provider_settings 中无 model 时作为 fallback。
    """
    from lib.video_backends import create_backend

    effective_model = provider_settings.get("model") or default_video_model or None
    cache_key = (resolver.user_id, "video", provider_name, effective_model)
    if cache_key in _backend_cache:
        return _backend_cache[cache_key]

    # 自定义供应商走独立工厂路径
    if is_custom_provider(provider_name):
        backend = await _create_custom_backend(
            provider_name,
            effective_model,
            "video",
            user_id=resolver.user_id,
        )
        _backend_cache[cache_key] = backend
        return backend

    # 解析 provider_id → backend registry name
    backend_name = _VIDEO_PROVIDER_ID_TO_BACKEND.get(provider_name, provider_name)

    kwargs: dict = {}
    if backend_name == PROVIDER_GEMINI:
        # 确定 backend_type（aistudio 或 vertex）
        if provider_name == "gemini-vertex":
            kwargs["backend_type"] = "vertex"
        elif provider_name == "gemini-aistudio":
            kwargs["backend_type"] = "aistudio"
        else:
            kwargs["backend_type"] = "aistudio"

        config_provider_id = "gemini-vertex" if kwargs["backend_type"] == "vertex" else "gemini-aistudio"
        db_config = await resolver.provider_config(config_provider_id)
        kwargs["api_key"] = db_config.get("api_key")
        kwargs["rate_limiter"] = rate_limiter
        kwargs["video_model"] = effective_model
    else:
        await _fill_simple_provider_kwargs(provider_name, backend_name, resolver, kwargs, effective_model)

    backend = create_backend(backend_name, **kwargs)
    _backend_cache[cache_key] = backend
    return backend


async def _get_or_create_image_backend(
    provider_name: str,
    provider_settings: dict,
    resolver: ConfigResolver,
    *,
    default_image_model: str | None = None,
):
    """获取或创建 ImageBackend 实例（带缓存）。"""
    from lib.image_backends import create_backend

    effective_model = provider_settings.get("model") or default_image_model or None
    cache_key = (resolver.user_id, "image", provider_name, effective_model)
    if cache_key in _backend_cache:
        return _backend_cache[cache_key]

    # 自定义供应商走独立工厂路径
    if is_custom_provider(provider_name):
        backend = await _create_custom_backend(
            provider_name,
            effective_model,
            "image",
            user_id=resolver.user_id,
        )
        _backend_cache[cache_key] = backend
        return backend

    backend_name = _IMAGE_PROVIDER_ID_TO_BACKEND.get(provider_name, provider_name)

    kwargs: dict = {}
    if backend_name == PROVIDER_GEMINI:
        if provider_name == "gemini-vertex":
            kwargs["backend_type"] = "vertex"
        else:
            kwargs["backend_type"] = "aistudio"
        config_id = "gemini-vertex" if kwargs["backend_type"] == "vertex" else "gemini-aistudio"
        db_config = await resolver.provider_config(config_id)
        kwargs["api_key"] = db_config.get("api_key")
        kwargs["base_url"] = db_config.get("base_url")
        kwargs["rate_limiter"] = rate_limiter
        kwargs["image_model"] = effective_model
    else:
        await _fill_simple_provider_kwargs(provider_name, backend_name, resolver, kwargs, effective_model)

    backend = create_backend(backend_name, **kwargs)
    _backend_cache[cache_key] = backend
    return backend


async def _resolve_video_backend(
    project_name: str,
    resolver: ConfigResolver,
    payload: dict | None,
    *,
    user_id: str = DEFAULT_USER_ID,
) -> tuple[Any | None, str, str]:
    """解析视频后端，返回 (video_backend, video_backend_type, video_model)。

    仅在 payload 存在时创建 VideoBackend，避免图片任务因视频配置缺失而报错。
    注意：video_backend_type 仅在 video_backend 为 None（回退到 GeminiClient）时生效，
    因此只需要在全局默认回退分支中设置。
    """
    default_video_provider_id, video_model = await resolver.default_video_backend()
    video_backend = None
    video_backend_type = "aistudio"

    if payload:
        # provider 统一从项目配置 → 全局默认解析，调用方无需传递
        manager = _gt().get_project_manager_for_user(user_id)
        project = await asyncio.to_thread(manager.load_project, project_name)

        # 从 project.json 的 video_backend（"provider/model" 格式）解析
        provider_name, project_model = _parse_project_backend(project.get("video_backend"))

        if not provider_name:
            provider_name = default_video_provider_id
            mapped = _VIDEO_PROVIDER_ID_TO_BACKEND.get(provider_name, provider_name)
            if mapped == PROVIDER_GEMINI:
                video_backend_type = "vertex" if default_video_provider_id == "gemini-vertex" else "aistudio"

        provider_settings: dict = {"model": project_model} if project_model else {}
        video_backend = await _get_or_create_video_backend(
            provider_name,
            provider_settings,
            resolver,
            default_video_model=video_model,
        )

    return video_backend, video_backend_type, video_model


async def get_media_generator(
    project_name: str,
    payload: dict | None = None,
    *,
    user_id: str = DEFAULT_USER_ID,
    require_image_backend: bool = True,
) -> MediaGenerator:
    """创建 MediaGenerator。仅按调用场景初始化所需的 backend。"""
    from lib.config.resolver import ConfigResolver
    from lib.db import async_session_factory

    manager = _gt().get_project_manager_for_user(user_id)
    project_path = await asyncio.to_thread(manager.get_project_path, project_name)
    project = await asyncio.to_thread(manager.load_project, project_name)
    resolver = ConfigResolver(async_session_factory, user_id=resolve_credential_user_id(project, user_id))

    # 初始化阶段共享单一 session
    async with resolver.session() as r:
        image_backend = None
        if require_image_backend:
            image_provider_id, image_model = await r.default_image_backend()
            # payload 中的 image_provider（由入队时 _snapshot_image_backend 注入）
            if payload and payload.get("image_provider"):
                image_provider_id = payload["image_provider"]
                image_model = payload.get("image_model", "") or image_model
            else:
                # 直接从 project.json 的 image_backend（"provider/model" 格式）读取
                proj_provider, proj_model = _parse_project_backend(project.get("image_backend"))
                if proj_provider:
                    # 仅当 provider 相同时才复用全局默认 model，避免跨 provider model 不匹配
                    image_model = proj_model or (image_model if proj_provider == image_provider_id else None)
                    image_provider_id = proj_provider
            image_backend = await _get_or_create_image_backend(
                image_provider_id,
                {},
                r,
                default_image_model=image_model,
            )

        # 解析 video backend（保持现有逻辑）
        # Looked up via main module so test monkeypatches on
        # generation_tasks._resolve_video_backend apply.
        _resolve_video_backend_fn = _gt()._resolve_video_backend
        try:
            video_backend, _, _ = await _resolve_video_backend_fn(
                project_name,
                r,
                payload,
                user_id=user_id,
            )
        except TypeError as exc:
            if "user_id" not in str(exc):
                raise
            video_backend, _, _ = await _resolve_video_backend_fn(project_name, r, payload)

    # 传原始 resolver 给 MediaGenerator（后续调用在 session scope 外）
    return MediaGenerator(
        project_path,
        rate_limiter=rate_limiter,
        image_backend=image_backend,
        video_backend=video_backend,
        config_resolver=resolver,
        project_config=project,
        user_id=user_id,
    )


__all__ = [
    "_IMAGE_PROVIDER_ID_TO_BACKEND",
    "_PROVIDER_ID_TO_BACKEND",
    "_VIDEO_PROVIDER_ID_TO_BACKEND",
    "_backend_cache",
    "_create_custom_backend",
    "_fill_simple_provider_kwargs",
    "_get_or_create_image_backend",
    "_get_or_create_video_backend",
    "_parse_project_backend",
    "_resolve_effective_image_backend",
    "_resolve_video_backend",
    "get_media_generator",
    "invalidate_backend_cache",
    "rate_limiter",
    "resolve_credential_user_id",
]
