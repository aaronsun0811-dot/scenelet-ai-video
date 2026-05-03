"""
生成 API 路由

处理分镜图、视频、角色图、线索图的生成请求。
所有生成请求入队到 GenerationQueue，由 GenerationWorker 异步执行。
"""

import asyncio
import logging
from typing import Any, Literal
from urllib.parse import quote

logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from lib import PROJECT_ROOT
from lib.asset_types import ASSET_SPECS
from lib.config.registry import PROVIDER_REGISTRY
from lib.config.service import ConfigService
from lib.credit_utils import minimum_generation_balance
from lib.db import async_session_factory
from lib.db.base import PLATFORM_USER_ID
from lib.db.repositories.credit_repository import CreditRepository
from lib.generation_queue import get_generation_queue
from lib.i18n import Translator
from lib.model_rules import media_rule_key, normalize_model_rule_configs, resolve_model_rule_config
from lib.project_manager import ProjectManager
from lib.prompt_utils import (
    is_structured_image_prompt,
    is_structured_video_prompt,
)
from lib.storyboard_sequence import (
    find_storyboard_item,
    get_storyboard_items,
)
from server.auth import CurrentUser
from server.services.billing import (
    ensure_platform_credits_balance,
    estimate_generation_task_credits,
    is_platform_credits_project,
    reserve_platform_credits_for_task_or_cancel,
)
from server.services.project_access import load_project_for_user, project_manager_for_user

router = APIRouter()

# 初始化管理器
pm = ProjectManager(PROJECT_ROOT / "projects")


def get_project_manager() -> ProjectManager:
    return pm


def get_project_manager_for_user(user_id: str | None) -> ProjectManager:
    return project_manager_for_user(get_project_manager(), user_id)


# ==================== 请求模型 ====================


class GenerateStoryboardRequest(BaseModel):
    prompt: str | dict
    script_file: str


class GenerateVideoRequest(BaseModel):
    prompt: str | dict
    script_file: str
    duration_seconds: int | None = None  # 改为 None，由服务层解析
    seed: int | None = None


class GenerateCharacterRequest(BaseModel):
    prompt: str


class GenerateSceneRequest(BaseModel):
    prompt: str


class GeneratePropRequest(BaseModel):
    prompt: str


GenerationPreflightTaskType = Literal[
    "storyboard",
    "video",
    "character",
    "scene",
    "prop",
    "grid",
    "reference_video",
    "workflow",
]


class GenerationPreflightRequest(BaseModel):
    task_type: GenerationPreflightTaskType
    payload: dict[str, Any] = Field(default_factory=dict)
    resource_id: str | None = None
    count: int = Field(default=1, ge=1, le=500)


class GenerationPreflightIssue(BaseModel):
    code: str
    message: str


class GenerationPreflightCheck(BaseModel):
    code: str
    label: str
    status: Literal["ok", "warning", "blocking"]
    message: str
    action_label: str | None = None
    action_route: str | None = None
    action_kind: str | None = None
    action_payload: dict[str, Any] | None = None


class GenerationPreflightResponse(BaseModel):
    project_name: str
    task_type: GenerationPreflightTaskType
    resource_id: str | None = None
    billing_mode: Literal["byok", "platform_credits"]
    required_credits: int
    count: int
    balance: int | None = None
    available_balance: int | None = None
    reserved_generation_credits: int | None = None
    minimum_generation_balance: int
    can_submit: bool
    blocking: list[GenerationPreflightIssue]
    warnings: list[GenerationPreflightIssue]
    checks: list[GenerationPreflightCheck] = Field(default_factory=list)


_LEGACY_PROVIDER_NAMES: dict[str, str] = {
    "gemini": "gemini-aistudio",
    "aistudio": "gemini-aistudio",
    "vertex": "gemini-vertex",
}


def _normalize_provider_id(raw: str) -> str:
    """将旧格式 provider 名称归一化为标准 provider_id。"""
    return _LEGACY_PROVIDER_NAMES.get(raw, raw)


def _snapshot_image_backend(project_name: str, user_id: str | None = None) -> dict:
    """快照图片供应商配置，返回可合并到 payload 的字典。

    优先级：项目级 image_backend > 系统级 default_image_backend。
    """
    project = get_project_manager_for_user(user_id).load_project(project_name)
    project_image_backend = project.get("image_backend")  # 格式: "provider_id/model"
    if project_image_backend and "/" in project_image_backend:
        image_provider, image_model = project_image_backend.split("/", 1)
    elif project_image_backend:
        image_provider = _normalize_provider_id(project_image_backend)
        image_model = ""
    else:
        return {}  # 无项目级覆盖，使用全局默认
    return {
        "image_provider": image_provider,
        "image_model": image_model,
    }


def _load_project_for_user(project_name: str, user_id: str, _t: Translator) -> dict:
    return load_project_for_user(get_project_manager(), project_name, user_id=user_id, translate=_t)


async def _get_generation_preflight_credit_balance(user_id: str) -> dict[str, int]:
    async with async_session_factory() as session:
        repo = CreditRepository(session, user_id=user_id)
        balance = await repo.get_balance()
        reserved = await repo.get_reserved_generation_credits()
        return {
            "balance": balance,
            "available_balance": balance - reserved,
            "reserved_generation_credits": reserved,
        }


async def _is_google_maps_configured(user_id: str) -> bool:
    return await _is_map_provider_configured(user_id, "google_maps_api_key")


async def _is_map_provider_configured(user_id: str, setting_key: str) -> bool:
    async with async_session_factory() as session:
        svc = ConfigService(session, user_id=user_id)
        return bool((await svc.get_setting(setting_key, "")).strip())


def _travel_reference_images(settings: dict[str, Any]) -> list[str]:
    raw = settings.get("reference_images")
    if not isinstance(raw, list):
        return []
    return [item.strip() for item in raw if isinstance(item, str) and item.strip()]


def _unique_limited_refs(reference_images: list[str], limit: int = 10) -> list[str]:
    refs: list[str] = []
    seen: set[str] = set()
    for ref in reference_images:
        if ref in seen:
            continue
        seen.add(ref)
        refs.append(ref)
        if len(refs) >= limit:
            break
    return refs


def _format_limited_items(items: list[str], limit: int = 4) -> str:
    if not items:
        return "-"
    shown = items[:limit]
    suffix = f" 等 {len(items)} 项" if len(items) > limit else ""
    return "、".join(shown) + suffix


def _parse_backend_value(raw: Any) -> tuple[str | None, str | None]:
    if not isinstance(raw, str) or not raw.strip():
        return None, None
    value = raw.strip()
    if "/" in value:
        provider, model = value.split("/", 1)
        return provider.strip() or None, model.strip() or None
    return value, None


def _config_user_id_for_generation(project: dict[str, Any], user_id: str) -> str:
    return PLATFORM_USER_ID if is_platform_credits_project(project) else user_id


def _generation_rule_media_types(task_type: GenerationPreflightTaskType) -> list[str]:
    if task_type in {"storyboard", "character", "scene", "prop", "grid"}:
        return ["image"]
    if task_type in {"video", "reference_video"}:
        return ["video"]
    if task_type == "workflow":
        return ["image", "video"]
    return []


def _provider_model_label(provider_id: str, model_id: str | None) -> str:
    provider = provider_id.strip()
    model = (model_id or "").strip()
    if not provider and not model:
        return "自动选择"
    provider_label = PROVIDER_REGISTRY.get(provider).display_name if provider in PROVIDER_REGISTRY else provider
    if provider_label and model:
        return f"{provider_label} · {model}"
    return provider_label or model or "自动选择"


def _model_rule_mode_label(mode: str) -> str:
    return {
        "default": "默认规则",
        "prompt": "添加 Prompt",
        "github_skill": "GitHub Skill",
        "uploaded_skill": "上传 Skill",
    }.get(mode, "默认规则")


def _model_rule_target_key(
    configs: dict[str, dict[str, str]],
    provider_id: str,
    model_id: str | None,
    media_type: str,
) -> str:
    model = (model_id or "").strip()
    provider = provider_id.strip()
    media_key = media_rule_key(media_type) if media_type in {"image", "video"} else ""
    if model:
        exact_key = f"{provider}/{model}" if provider else model
        if exact_key in configs:
            return exact_key
        suffix = f"/{model}"
        for key in configs:
            if key.endswith(suffix):
                return key
    if media_key:
        return media_key
    return f"{provider}/{model}" if provider and model else model


async def _load_preflight_model_rule_configs(user_id: str) -> dict[str, dict[str, str]]:
    try:
        async with async_session_factory() as session:
            svc = ConfigService(session, user_id=user_id)
            raw = await svc.get_setting("model_rule_configs", "{}")
        return normalize_model_rule_configs(raw)
    except Exception:
        logger.exception("读取生成规则配置失败，预检将按默认规则展示")
        return {}


async def _resolve_preflight_backend(
    project: dict[str, Any],
    payload: dict[str, Any],
    *,
    media_type: str,
    user_id: str,
) -> tuple[str, str | None]:
    if media_type == "image":
        provider = payload.get("image_provider")
        model = payload.get("image_model")
        if isinstance(provider, str) and provider.strip():
            return provider.strip(), str(model).strip() if model else None

        project_provider, project_model = _parse_backend_value(project.get("image_backend"))
        if project_provider and project_model:
            return project_provider, project_model

        from lib.config.resolver import ConfigResolver

        resolver = ConfigResolver(async_session_factory, user_id=_config_user_id_for_generation(project, user_id))
        try:
            async with resolver.session() as r:
                default_provider, default_model = await r.default_image_backend()
        except Exception:
            logger.exception("解析图片默认模型失败，生成预检将显示自动选择")
            return project_provider or "", project_model

        if project_provider:
            return project_provider, project_model or (
                default_model if project_provider == default_provider else None
            )
        return default_provider or "", default_model or None

    if media_type == "video":
        provider = payload.get("video_provider")
        model = payload.get("video_model") or payload.get("model")
        if isinstance(provider, str) and provider.strip():
            return provider.strip(), str(model).strip() if model else None

        project_provider, project_model = _parse_backend_value(project.get("video_backend"))
        if project_provider and project_model:
            return project_provider, project_model

        from lib.config.resolver import ConfigResolver

        resolver = ConfigResolver(async_session_factory, user_id=_config_user_id_for_generation(project, user_id))
        try:
            async with resolver.session() as r:
                default_provider, default_model = await r.default_video_backend()
        except Exception:
            logger.exception("解析视频默认模型失败，生成预检将显示自动选择")
            return project_provider or "", project_model

        if project_provider:
            return project_provider, project_model or (
                default_model if project_provider == default_provider else None
            )
        return default_provider or "", default_model or None

    return "", None


async def _append_model_rule_preflight(
    project: dict[str, Any],
    payload: dict[str, Any],
    task_type: GenerationPreflightTaskType,
    user_id: str,
    checks: list[GenerationPreflightCheck],
) -> None:
    media_types = _generation_rule_media_types(task_type)
    if not media_types:
        return

    config_user_id = _config_user_id_for_generation(project, user_id)
    configs = await _load_preflight_model_rule_configs(config_user_id)
    for media_type in media_types:
        snapshot = await _model_rule_snapshot_for_media(
            project,
            payload,
            media_type=media_type,
            user_id=user_id,
            configs=configs,
        )
        if not snapshot:
            continue
        mode_label = snapshot["mode_label"]
        media_label = snapshot["media_label"]
        target_label = snapshot["target_label"]
        skill_name = snapshot.get("skill_name") or ""
        mode = snapshot["mode"]
        suffix = f"，Skill：{skill_name}" if mode in {"github_skill", "uploaded_skill"} and skill_name else ""
        rule_target = (snapshot.get("rule_target") or "").strip()
        action_route = "/app/settings?section=media"
        if rule_target:
            action_route = f"{action_route}&ruleTarget={quote(rule_target, safe='')}"
        checks.append(
            GenerationPreflightCheck(
                code=f"model_rule_{media_type}",
                label="生成规则",
                status="ok",
                message=f"{media_label}将使用「{mode_label}」，目标模型：{target_label}{suffix}。",
                action_label="打开模型规则",
                action_route=action_route,
                action_kind="model_rule_summary",
                action_payload={
                    **snapshot,
                    "billing_mode": "platform_credits" if is_platform_credits_project(project) else "byok",
                },
            )
        )


async def _model_rule_snapshot_for_media(
    project: dict[str, Any],
    payload: dict[str, Any],
    *,
    media_type: str,
    user_id: str,
    configs: dict[str, dict[str, str]] | None = None,
) -> dict[str, str] | None:
    if media_type not in {"image", "video"}:
        return None
    provider_id, model_id = await _resolve_preflight_backend(
        project,
        payload,
        media_type=media_type,
        user_id=user_id,
    )
    if configs is None:
        configs = await _load_preflight_model_rule_configs(_config_user_id_for_generation(project, user_id))
    config = resolve_model_rule_config(
        configs,
        provider_id,
        model_id or "",
        media_type=media_type,
    ) or {"mode": "default"}
    mode = config.get("mode") or "default"
    return {
        "media_type": media_type,
        "media_label": "生成图片" if media_type == "image" else "生成视频",
        "rule_target": _model_rule_target_key(configs, provider_id, model_id, media_type),
        "mode": mode,
        "mode_label": _model_rule_mode_label(mode),
        "provider_id": provider_id,
        "model_id": model_id or "",
        "target_label": _provider_model_label(provider_id, model_id),
        "skill_name": (config.get("skill_name") or "").strip(),
    }


async def _payload_with_model_rule_summary(
    project: dict[str, Any],
    payload: dict[str, Any],
    *,
    task_type: GenerationPreflightTaskType | str,
    media_type: str,
    user_id: str,
    replace_existing: bool = False,
) -> dict[str, Any]:
    if payload.get("model_rule_summary") and not replace_existing:
        return payload
    base_payload = dict(payload)
    if replace_existing:
        base_payload.pop("model_rule_summary", None)
    snapshot = await _model_rule_snapshot_for_media(
        project,
        base_payload,
        media_type=media_type,
        user_id=user_id,
    )
    if not snapshot:
        return base_payload if replace_existing else payload
    return {
        **base_payload,
        "model_rule_summary": {
            **snapshot,
            "task_type": task_type,
            "billing_mode": "platform_credits" if is_platform_credits_project(project) else "byok",
        },
    }


def _travel_reference_scene_asset_coverage(
    project: dict[str, Any],
    reference_images: list[str],
) -> tuple[dict[str, list[str]], list[str]]:
    refs = _unique_limited_refs(reference_images)
    refs_set = set(refs)
    applied: dict[str, list[str]] = {}

    scenes = project.get("scenes")
    if not isinstance(scenes, dict):
        return applied, refs

    for scene_name, scene in scenes.items():
        if not isinstance(scene, dict):
            continue
        source = scene.get("asset_source")
        if not isinstance(source, dict):
            continue
        if str(source.get("source_kind") or "").strip() != "travel_reference":
            continue
        source_file = str(source.get("source_file") or "").strip()
        if source_file in refs_set:
            applied.setdefault(source_file, []).append(str(scene_name))

    missing = [ref for ref in refs if ref not in applied]
    return applied, missing


def _append_travel_reference_scene_asset_preflight(
    project_name: str,
    project: dict[str, Any],
    reference_images: list[str],
    warnings: list[GenerationPreflightIssue],
    checks: list[GenerationPreflightCheck],
) -> None:
    refs = _unique_limited_refs(reference_images)
    if not refs:
        return

    applied, missing = _travel_reference_scene_asset_coverage(project, refs)
    total = len(refs)
    applied_count = len(applied)
    applied_pairs = [
        f"{ref} → {', '.join(names[:2])}{' 等' if len(names) > 2 else ''}"
        for ref, names in applied.items()
    ]

    if missing:
        action_route = f"/app/projects/{quote(project_name, safe='')}?openTravelRouteAssets=1"
        message = (
            f"旅游参考图已有 {applied_count}/{total} 张应用为项目场景素材；"
            f"未应用：{_format_limited_items(missing)}。"
            "可在生成前检查里一键入库并应用回项目。"
        )
        warnings.append(
            GenerationPreflightIssue(
                code="travel_reference_scene_assets_incomplete",
                message=message,
            )
        )
        checks.append(
            GenerationPreflightCheck(
                code="travel_reference_scene_assets_incomplete",
                label="参考图场景素材",
                status="warning",
                message=message,
                action_label="一键应用场景素材",
                action_route=action_route,
                action_kind="apply_travel_scene_assets",
                action_payload={
                    "missing_reference_images": missing,
                    "applied_reference_images": list(applied.keys()),
                    "total_reference_images": total,
                },
            )
        )
        return

    message = (
        f"旅游参考图已全部应用为项目场景素材：{applied_count}/{total}。"
        f"已应用：{_format_limited_items(applied_pairs)}。"
    )
    checks.append(
        GenerationPreflightCheck(
            code="travel_reference_scene_assets_ready",
            label="参考图场景素材",
            status="ok",
            message=message,
        )
    )


async def _append_travel_video_route_preflight(
    project_name: str,
    project: dict[str, Any],
    user_id: str,
    blocking: list[GenerationPreflightIssue],
    warnings: list[GenerationPreflightIssue],
    checks: list[GenerationPreflightCheck],
) -> None:
    if project.get("content_type") != "travel_video":
        return

    settings = project.get("travel_video_settings")
    if not isinstance(settings, dict):
        settings = {}

    route_source = str(settings.get("route_source") or "google_street_view")
    origin = str(settings.get("origin") or "").strip()
    destination = str(settings.get("destination") or "").strip()
    route_notes = str(settings.get("route_notes") or "").strip()
    reference_images = _travel_reference_images(settings)
    has_text_route = bool(route_notes or (origin and destination))
    has_reference_images = len(reference_images) > 0

    if not has_text_route and not has_reference_images:
        message = "旅游视频需要先填写出发地+目的地、手动路线说明，或上传至少一张路线参考图。"
        blocking.append(
            GenerationPreflightIssue(
                code="travel_route_missing",
                message=message,
            )
        )
        checks.append(
            GenerationPreflightCheck(
                code="travel_route_missing",
                label="旅游路线",
                status="blocking",
                message=message,
            )
        )
        return

    route_preview = settings.get("route_preview")
    if isinstance(route_preview, dict):
        preview_ready = bool(route_preview.get("route_ready"))
        preview_warnings = route_preview.get("warnings")
        warning_message = ""
        if isinstance(preview_warnings, list):
            for item in preview_warnings:
                if isinstance(item, dict) and str(item.get("message") or "").strip():
                    warning_message = str(item["message"]).strip()
                    break

        if preview_ready:
            summary = str(route_preview.get("summary") or "").strip()
            distance = str(route_preview.get("distance_text") or "").strip()
            duration = str(route_preview.get("duration_text") or "").strip()
            metrics = " / ".join(item for item in [distance, duration] if item)
            suffix = f"（{metrics}）" if metrics else ""
            checks.append(
                GenerationPreflightCheck(
                    code="travel_route_preview_ready",
                    label="旅游路线",
                    status="ok",
                    message=f"路线已预检：{summary or '已生成路线依据'}{suffix}",
                )
            )
        else:
            message = warning_message or "旅游路线预检未通过，请先补充路线说明、地点或参考图。"
            blocking.append(
                GenerationPreflightIssue(
                    code="travel_route_preview_not_ready",
                    message=message,
                )
            )
            checks.append(
                GenerationPreflightCheck(
                    code="travel_route_preview_not_ready",
                    label="旅游路线",
                    status="blocking",
                    message=message,
                )
            )
            return
    else:
        message = "旅游路线尚未运行预检；建议先在项目总览或路线设置中预检，确认路线节点后再生成。"
        warnings.append(
            GenerationPreflightIssue(
                code="travel_route_preview_missing",
                message=message,
            )
        )
        checks.append(
            GenerationPreflightCheck(
                code="travel_route_preview_missing",
                label="旅游路线",
                status="warning",
                message=message,
            )
        )

    if route_source == "google_street_view" and not await _is_google_maps_configured(user_id):
        warnings.append(
            GenerationPreflightIssue(
                code="google_maps_optional_missing",
                message="Google 街景/地图 API Key 未配置，本次会使用手动地点、路线说明或参考图继续生成。",
            )
        )
    elif route_source == "baidu_maps" and not await _is_map_provider_configured(user_id, "baidu_maps_api_key"):
        warnings.append(
            GenerationPreflightIssue(
                code="baidu_maps_optional_missing",
                message="百度地图 API Key 未配置，本次会使用手动地点、路线说明或参考图继续生成。",
            )
        )
    elif route_source == "amap_maps" and not await _is_map_provider_configured(user_id, "amap_maps_api_key"):
        warnings.append(
            GenerationPreflightIssue(
                code="amap_maps_optional_missing",
                message="高德地图 API Key 未配置，本次会使用手动地点、路线说明或参考图继续生成。",
            )
        )

    if route_source == "reference_images" and not has_reference_images:
        warnings.append(
            GenerationPreflightIssue(
                code="travel_reference_images_empty",
                message="当前路线来源选择了多图参考，但还没有上传参考图；会退回到已填写的地点或路线说明。",
            )
        )

    if len(reference_images) > 10:
        warnings.append(
            GenerationPreflightIssue(
                code="travel_reference_images_limit",
                message="旅游视频参考图最多使用 10 张，本次会优先使用前 10 张。",
            )
        )

    _append_travel_reference_scene_asset_preflight(project_name, project, reference_images, warnings, checks)


@router.post(
    "/projects/{project_name}/generate/preflight",
    response_model=GenerationPreflightResponse,
)
async def generation_preflight(
    project_name: str,
    req: GenerationPreflightRequest,
    _user: CurrentUser,
    _t: Translator,
):
    """Estimate generation credits and explain which billing path will be used."""
    try:
        project = await asyncio.to_thread(_load_project_for_user, project_name, _user.id, _t)
        billing_mode: Literal["byok", "platform_credits"] = (
            "platform_credits" if is_platform_credits_project(project) else "byok"
        )
        min_balance = minimum_generation_balance()
        required_per_task = await estimate_generation_task_credits(
            project,
            req.task_type,
            req.payload,
            user_id=_user.id,
            project_name=project_name,
        )
        required_credits = max(0, int(required_per_task or 0)) * req.count
        blocking: list[GenerationPreflightIssue] = []
        warnings: list[GenerationPreflightIssue] = []
        checks: list[GenerationPreflightCheck] = []
        balance_info: dict[str, int | None] = {
            "balance": None,
            "available_balance": None,
            "reserved_generation_credits": None,
        }

        if billing_mode == "platform_credits":
            required_credits = max(min_balance * req.count, required_credits)
            balance_info = await _get_generation_preflight_credit_balance(_user.id)
            available = int(balance_info["available_balance"] or 0)
            if available < required_credits:
                blocking.append(
                    GenerationPreflightIssue(
                        code="insufficient_platform_credits",
                        message=f"积分余额不足，本次预计至少需要 {required_credits} 积分。",
                    )
                )
        else:
            required_credits = 0
            warnings.append(
                GenerationPreflightIssue(
                    code="byok_uses_user_api",
                    message="本次生成将使用用户自己的 API Key，不扣平台积分。",
                )
            )

        await _append_model_rule_preflight(project, req.payload, req.task_type, _user.id, checks)
        await _append_travel_video_route_preflight(project_name, project, _user.id, blocking, warnings, checks)

        return GenerationPreflightResponse(
            project_name=project_name,
            task_type=req.task_type,
            resource_id=req.resource_id,
            billing_mode=billing_mode,
            required_credits=required_credits,
            count=req.count,
            minimum_generation_balance=min_balance,
            can_submit=len(blocking) == 0,
            blocking=blocking,
            warnings=warnings,
            checks=checks,
            **balance_info,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("生成预检失败")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 分镜图生成 ====================


@router.post("/projects/{project_name}/generate/storyboard/{segment_id}")
async def generate_storyboard(
    project_name: str,
    segment_id: str,
    req: GenerateStoryboardRequest,
    _user: CurrentUser,
    _t: Translator,
):
    """
    提交分镜图生成任务到队列，立即返回 task_id。

    生成由 GenerationWorker 异步执行，状态通过 SSE 推送。
    """
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            project = _load_project_for_user(project_name, _user.id, _t)
            script = manager.load_script(project_name, req.script_file)
            items, id_field, _, _, _ = get_storyboard_items(script)
            resolved = find_storyboard_item(items, id_field, segment_id)
            if resolved is None:
                raise HTTPException(status_code=404, detail=_t("segment_not_found", id=segment_id))
            return project, _snapshot_image_backend(project_name, _user.id)

        project, image_snapshot = await asyncio.to_thread(_sync)

        # 验证 prompt 格式
        if isinstance(req.prompt, dict):
            if not is_structured_image_prompt(req.prompt):
                raise HTTPException(
                    status_code=400,
                    detail=_t("prompt_must_be_string_or_scene_object"),
                )
            scene_text = str(req.prompt.get("scene", "")).strip()
            if not scene_text:
                raise HTTPException(status_code=400, detail=_t("prompt_scene_empty"))
        elif isinstance(req.prompt, str):
            if not req.prompt.strip():
                raise HTTPException(status_code=400, detail=_t("prompt_text_empty"))
        else:
            raise HTTPException(status_code=400, detail=_t("prompt_must_be_string_or_object"))

        payload = {
            "prompt": req.prompt,
            "script_file": req.script_file,
            **image_snapshot,
        }
        required_credits = await estimate_generation_task_credits(
            project,
            "storyboard",
            payload,
            user_id=_user.id,
            project_name=project_name,
        )
        await ensure_platform_credits_balance(project, _user.id, required_credits=required_credits)
        task_payload = await _payload_with_model_rule_summary(
            project,
            payload,
            task_type="storyboard",
            media_type="image",
            user_id=_user.id,
        )

        # 入队
        queue = get_generation_queue()
        result = await queue.enqueue_task(
            project_name=project_name,
            task_type="storyboard",
            media_type="image",
            resource_id=segment_id,
            script_file=req.script_file,
            payload=task_payload,
            source="webui",
            user_id=_user.id,
        )
        if not result.get("deduped"):
            await reserve_platform_credits_for_task_or_cancel(
                project,
                _user.id,
                task_id=result["task_id"],
                required_credits=required_credits,
                task_type="storyboard",
                project_name=project_name,
                queue=queue,
            )

        return {
            "success": True,
            "task_id": result["task_id"],
            "message": _t("storyboard_task_submitted", segment_id=segment_id),
        }

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 视频生成 ====================


@router.post("/projects/{project_name}/generate/video/{segment_id}")
async def generate_video(
    project_name: str,
    segment_id: str,
    req: GenerateVideoRequest,
    _user: CurrentUser,
    _t: Translator,
):
    """
    提交视频生成任务到队列，立即返回 task_id。

    需要先有分镜图作为起始帧。生成由 GenerationWorker 异步执行。
    """
    try:

        def _sync():
            pm_local = get_project_manager_for_user(_user.id)
            project = _load_project_for_user(project_name, _user.id, _t)
            project_path = pm_local.get_project_path(project_name)

            # 与 worker 一致：优先读取 generated_assets.storyboard_image，回退默认路径。
            # 旧宫格项目 storyboard_image 指向 scene_{id}_first.png，仍可正常解析。
            storyboard_rel: str | None = None
            try:
                script = pm_local.load_script(project_name, req.script_file)
                items, id_field, _, _, _ = get_storyboard_items(script)
                resolved = find_storyboard_item(items, id_field, segment_id)
                if resolved:
                    assets = resolved[0].get("generated_assets") or {}
                    if isinstance(assets, dict):
                        storyboard_rel = assets.get("storyboard_image")
            except FileNotFoundError:
                # 脚本不存在交由后续流程报错；此处只负责存在性检查
                pass

            storyboard_file = (
                project_path / storyboard_rel
                if storyboard_rel
                else project_path / "storyboards" / f"scene_{segment_id}.png"
            )
            if not storyboard_file.exists():
                raise HTTPException(status_code=400, detail=_t("generate_storyboard_first", segment_id=segment_id))
            return project

        project = await asyncio.to_thread(_sync)

        # 验证 prompt 格式
        if isinstance(req.prompt, dict):
            if not is_structured_video_prompt(req.prompt):
                raise HTTPException(
                    status_code=400,
                    detail=_t("video_prompt_must_be_string_or_action_object"),
                )
            action_text = str(req.prompt.get("action", "")).strip()
            if not action_text:
                raise HTTPException(status_code=400, detail=_t("video_prompt_action_empty"))
            dialogue = req.prompt.get("dialogue", [])
            if dialogue is not None and not isinstance(dialogue, list):
                raise HTTPException(status_code=400, detail=_t("video_prompt_dialogue_array"))
        elif isinstance(req.prompt, str):
            if not req.prompt.strip():
                raise HTTPException(status_code=400, detail=_t("prompt_text_empty"))
        else:
            raise HTTPException(status_code=400, detail=_t("prompt_must_be_string_or_object"))

        payload = {
            "prompt": req.prompt,
            "script_file": req.script_file,
            "duration_seconds": req.duration_seconds,
            "seed": req.seed,
        }
        required_credits = await estimate_generation_task_credits(
            project,
            "video",
            payload,
            user_id=_user.id,
            project_name=project_name,
        )
        await ensure_platform_credits_balance(project, _user.id, required_credits=required_credits)
        task_payload = await _payload_with_model_rule_summary(
            project,
            payload,
            task_type="video",
            media_type="video",
            user_id=_user.id,
        )

        # 入队（provider 由服务层根据配置自动解析，调用方无需传递）
        queue = get_generation_queue()
        result = await queue.enqueue_task(
            project_name=project_name,
            task_type="video",
            media_type="video",
            resource_id=segment_id,
            script_file=req.script_file,
            payload=task_payload,
            source="webui",
            user_id=_user.id,
        )
        if not result.get("deduped"):
            await reserve_platform_credits_for_task_or_cancel(
                project,
                _user.id,
                task_id=result["task_id"],
                required_credits=required_credits,
                task_type="video",
                project_name=project_name,
                queue=queue,
            )

        return {
            "success": True,
            "task_id": result["task_id"],
            "message": _t("video_task_submitted", segment_id=segment_id),
        }

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 资产设计图生成（character / scene / prop 共用） ====================


# i18n key 命名差异：scene 用历史前缀 "project_scene_*"
_ASSET_GENERATE_I18N: dict[str, dict[str, str]] = {
    "character": {"not_found": "character_not_found", "submitted": "character_task_submitted"},
    "scene": {"not_found": "project_scene_not_found", "submitted": "scene_task_submitted"},
    "prop": {"not_found": "prop_not_found", "submitted": "prop_task_submitted"},
}


async def _enqueue_asset_generation(
    *,
    asset_type: str,
    project_name: str,
    resource_name: str,
    prompt: str,
    user_id: str,
    _t: Translator,
) -> dict:
    """三类资产（character / scene / prop）设计图生成共用入队逻辑。"""
    spec = ASSET_SPECS[asset_type]
    keys = _ASSET_GENERATE_I18N[asset_type]

    def _sync():
        project = _load_project_for_user(project_name, user_id, _t)
        if resource_name not in project.get(spec.bucket_key, {}):
            raise HTTPException(status_code=404, detail=_t(keys["not_found"], name=resource_name))
        return project, _snapshot_image_backend(project_name, user_id)

    project, image_snapshot = await asyncio.to_thread(_sync)
    payload = {"prompt": prompt, **image_snapshot}
    required_credits = await estimate_generation_task_credits(
        project,
        asset_type,
        payload,
        user_id=user_id,
        project_name=project_name,
    )
    await ensure_platform_credits_balance(project, user_id, required_credits=required_credits)
    task_payload = await _payload_with_model_rule_summary(
        project,
        payload,
        task_type=asset_type,
        media_type="image",
        user_id=user_id,
    )

    queue = get_generation_queue()
    result = await queue.enqueue_task(
        project_name=project_name,
        task_type=asset_type,
        media_type="image",
        resource_id=resource_name,
        payload=task_payload,
        source="webui",
        user_id=user_id,
    )
    if not result.get("deduped"):
        await reserve_platform_credits_for_task_or_cancel(
            project,
            user_id,
            task_id=result["task_id"],
            required_credits=required_credits,
            task_type=asset_type,
            project_name=project_name,
            queue=queue,
        )

    return {
        "success": True,
        "task_id": result["task_id"],
        "message": _t(keys["submitted"], name=resource_name),
    }


@router.post("/projects/{project_name}/generate/character/{char_name}")
async def generate_character(
    project_name: str,
    char_name: str,
    req: GenerateCharacterRequest,
    _user: CurrentUser,
    _t: Translator,
):
    """提交角色设计图生成任务到队列，立即返回 task_id。"""
    try:
        return await _enqueue_asset_generation(
            asset_type="character",
            project_name=project_name,
            resource_name=char_name,
            prompt=req.prompt,
            user_id=_user.id,
            _t=_t,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{project_name}/generate/scene/{scene_name}")
async def generate_scene(
    project_name: str,
    scene_name: str,
    req: GenerateSceneRequest,
    _user: CurrentUser,
    _t: Translator,
):
    """提交场景设计图生成任务到队列，立即返回 task_id。"""
    try:
        return await _enqueue_asset_generation(
            asset_type="scene",
            project_name=project_name,
            resource_name=scene_name,
            prompt=req.prompt,
            user_id=_user.id,
            _t=_t,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{project_name}/generate/prop/{prop_name}")
async def generate_prop(
    project_name: str,
    prop_name: str,
    req: GeneratePropRequest,
    _user: CurrentUser,
    _t: Translator,
):
    """提交道具设计图生成任务到队列，立即返回 task_id。"""
    try:
        return await _enqueue_asset_generation(
            asset_type="prop",
            project_name=project_name,
            resource_name=prop_name,
            prompt=req.prompt,
            user_id=_user.id,
            _t=_t,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))
