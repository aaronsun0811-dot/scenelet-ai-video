"""
项目管理路由

处理项目的 CRUD 操作，复用 lib/project_manager.py
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import shutil
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from fastapi import Path as FastAPIPath
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from lib import PROJECT_ROOT
from lib.asset_fingerprints import compute_asset_fingerprints
from lib.config.resolver import ConfigResolver
from lib.config.service import ConfigService
from lib.content_workflows import get_workflow_preset, is_known_content_type
from lib.db import async_session_factory, get_async_session
from lib.db.repositories.user_repository import UserRepository
from lib.httpx_shared import get_http_client
from lib.i18n import Translator
from lib.project_change_hints import project_change_source
from lib.project_manager import (
    PROJECT_ACCESS_FIELD,
    PROJECT_ACCESS_MEMBERS_FIELD,
    PROJECT_MEMBER_EDITOR_ROLE,
    ProjectManager,
)
from lib.script_generator import (
    ScriptGenerator as ScriptGenerator,  # noqa: PLC0414 — re-exported for tests/sub-routers that look it up via this module
)
from lib.status_calculator import StatusCalculator
from lib.style_templates import is_known_template, resolve_template_prompt
from server.auth import CurrentUser
from server.dependencies import get_config_service
from server.routers._validators import validate_backend_value
from server.services.project_access import (
    PROJECT_OWNER_FIELD,
    ensure_project_access,
    ensure_project_owner,
    project_manager_for_user,
    project_members,
    project_owner_user_id,
    user_can_access_project,
)
from server.services.project_archive import ProjectArchiveService
from server.services.project_cover import resolve_project_cover
from server.services.travel_route import build_travel_route_preview, fetch_travel_route_street_view_image

router = APIRouter()

# 初始化项目管理器和状态计算器
pm = ProjectManager(PROJECT_ROOT / "projects")
calc = StatusCalculator(pm)

# episode 字段白名单：只允许持久化合法的 on-disk 字段。
# StatusCalculator 注入的统计字段（scenes_count / status / storyboards / videos 等）
# 是读时计算值，禁止写回 project.json。
EPISODE_PERSIST_FIELDS = {"title", "script_file", "generation_mode"}
_VALID_CONTENT_MODES = {"narration", "drama"}
_VALID_GENERATION_MODES = {"storyboard", "grid", "reference_video"}
_LEGACY_GENERATION_MODE_ALIASES = {"single": "storyboard"}
MAX_TRAVEL_REFERENCE_IMAGES = 10


def get_project_manager() -> ProjectManager:
    return pm


def get_project_manager_for_user(user_id: str | None) -> ProjectManager:
    return project_manager_for_user(get_project_manager(), user_id)


def get_status_calculator() -> StatusCalculator:
    return calc


def get_status_calculator_for_manager(manager: ProjectManager) -> StatusCalculator:
    configured = get_status_calculator()
    if configured is not calc:
        return configured
    return StatusCalculator(manager)


def get_archive_service(user_id: str | None = None) -> ProjectArchiveService:
    return ProjectArchiveService(
        get_project_manager_for_user(user_id) if user_id is not None else get_project_manager()
    )


class TravelVideoSettings(BaseModel):
    """Project-level settings for route/street-view based travel videos."""

    model_config = ConfigDict(extra="ignore")

    origin: str | None = None
    destination: str | None = None
    route_source: Literal["google_street_view", "baidu_maps", "amap_maps", "manual", "reference_images"] | None = None
    route_notes: str | None = None
    reference_images: list[str] | None = None
    route_preview: dict[str, Any] | None = None
    narration_language: Literal["auto", "zh", "en", "ja"] | None = None
    target_duration: Literal["45s", "60s", "90s", "120s", "150s", "180s", "custom"] | None = None
    custom_duration_seconds: int | None = None
    camera_style: Literal["street_walk_turns", "street_drive", "landmark_focus", "cinematic_slow"] | None = None
    narrator_persona: Literal["enthusiastic_guide", "local_friend", "documentary", "calm_guide"] | None = None
    character_notes: str | None = None


class CreateProjectRequest(BaseModel):
    name: str | None = None
    title: str | None = None
    content_type: str | None = None
    billing_mode: Literal["byok", "platform_credits"] | None = None
    style: str | None = ""  # 保留但不再是用户入口
    content_mode: str | None = "narration"
    aspect_ratio: str | None = "9:16"
    default_duration: int | None = None
    generation_mode: str | None = None
    # ===== 新增 =====
    style_template_id: str | None = None
    video_backend: str | None = None
    image_backend: str | None = None
    text_backend_script: str | None = None
    text_backend_overview: str | None = None
    text_backend_style: str | None = None
    character_style_prompt: str | None = None
    model_settings: dict[str, dict[str, str | None]] | None = None
    travel_video_settings: TravelVideoSettings | None = None


class EpisodePatch(BaseModel):
    """PATCH body entry for a single episode.

    Only whitelisted fields persist; computed fields (scenes_count, status,
    storyboards, etc.) are silently dropped via extra='ignore'.
    """

    model_config = ConfigDict(extra="ignore")
    episode: int
    title: str | None = None
    script_file: str | None = None
    generation_mode: Literal["storyboard", "grid", "reference_video"] | None = None


class UpdateProjectRequest(BaseModel):
    title: str | None = None
    style: str | None = None
    content_type: str | None = None
    billing_mode: Literal["byok", "platform_credits"] | None = None
    content_mode: str | None = None
    aspect_ratio: str | None = None
    default_duration: int | None = None
    generation_mode: str | None = None
    video_backend: str | None = None
    image_backend: str | None = None
    video_generate_audio: bool | None = None
    text_backend_script: str | None = None
    text_backend_overview: str | None = None
    text_backend_style: str | None = None
    character_style_prompt: str | None = None
    style_template_id: str | None = None
    clear_style_image: bool | None = None
    episodes: list[EpisodePatch] | None = None
    model_settings: dict[str, dict[str, str | None]] | None = None
    travel_video_settings: TravelVideoSettings | None = None


class TravelRoutePreviewRequest(BaseModel):
    """Build and optionally persist a travel-video route preview."""

    travel_video_settings: TravelVideoSettings | None = None
    persist: bool = True


class ProjectMemberRequest(BaseModel):
    user_id: str
    username: str | None = None
    role: Literal["editor"] = PROJECT_MEMBER_EDITOR_ROLE


class ProjectMemberCreateRequest(BaseModel):
    identifier: str | None = None
    user_id: str | None = None
    username: str | None = None
    role: Literal["editor"] = PROJECT_MEMBER_EDITOR_ROLE


def _normalize_member_user_id(user_id: str) -> str:
    normalized = str(user_id).strip()
    if not normalized or len(normalized) > 128 or any(ord(ch) < 32 for ch in normalized):
        raise HTTPException(status_code=422, detail="invalid member user_id")
    return normalized


def _normalize_member_username(username: str | None) -> str | None:
    normalized = str(username or "").strip()
    if not normalized:
        return None
    if len(normalized) > 64 or any(ord(ch) < 32 for ch in normalized):
        raise HTTPException(status_code=422, detail="invalid member username")
    return normalized


async def _resolve_member_identity(
    req: ProjectMemberCreateRequest,
    session: AsyncSession,
) -> tuple[str, str | None]:
    repo = UserRepository(session)
    raw_identifier = str(req.identifier or "").strip()
    raw_user_id = str(req.user_id or "").strip()
    raw_username = _normalize_member_username(req.username)
    if not raw_identifier and not raw_user_id and not raw_username:
        raise HTTPException(status_code=422, detail="member identifier is required")

    if raw_username:
        user = await repo.get_by_username(raw_username)
        if not user or not user.get("is_active"):
            raise HTTPException(status_code=404, detail="user not found")
        return _normalize_member_user_id(str(user["id"])), str(user["username"])

    if raw_user_id:
        user = await repo.get_by_id(raw_user_id)
        if user and user.get("is_active"):
            return _normalize_member_user_id(str(user["id"])), str(user["username"])
        return _normalize_member_user_id(raw_user_id), None

    user = await repo.get_by_username(raw_identifier)
    if user and user.get("is_active"):
        return _normalize_member_user_id(str(user["id"])), str(user["username"])
    user = await repo.get_by_id(raw_identifier)
    if user and user.get("is_active"):
        return _normalize_member_user_id(str(user["id"])), str(user["username"])
    if raw_identifier.startswith("user_"):
        return _normalize_member_user_id(raw_identifier), None
    raise HTTPException(status_code=404, detail="user not found")


def _project_members_response(project: dict, *, current_user_id: str | None = None) -> dict[str, object]:
    members = project_members(project)
    owner_user_id = project_owner_user_id(project)
    current_user_role = None
    if current_user_id is not None:
        current_user_role = (
            "owner"
            if owner_user_id == str(current_user_id)
            else ProjectManager.project_member_role(project, current_user_id)
        )
    return {
        "owner_user_id": owner_user_id,
        "current_user_role": current_user_role,
        "members": [
            {
                "user_id": user_id,
                **entry,
            }
            for user_id, entry in sorted(members.items())
        ],
    }


def _grant_project_member(
    project: dict,
    *,
    user_id: str,
    role: Literal["editor"],
    username: str | None = None,
) -> None:
    if user_id == project_owner_user_id(project):
        raise HTTPException(status_code=400, detail="project owner is already a member")
    access = project.setdefault(PROJECT_ACCESS_FIELD, {})
    if not isinstance(access, dict):
        access = {}
        project[PROJECT_ACCESS_FIELD] = access
    members = access.setdefault(PROJECT_ACCESS_MEMBERS_FIELD, {})
    if not isinstance(members, dict):
        members = {}
        access[PROJECT_ACCESS_MEMBERS_FIELD] = members
    member = {
        "role": role,
        "added_at": datetime.now().isoformat(),
    }
    if username:
        member["username"] = username
    members[user_id] = member


def _normalize_content_type_or_400(content_type: str | None, _t: Callable[..., str]) -> str | None:
    if not content_type:
        return None
    normalized = str(content_type).strip()
    if not is_known_content_type(normalized):
        raise HTTPException(
            status_code=400,
            detail=_t("unknown_content_type", content_type=normalized),
        )
    return normalized


def _normalize_content_mode_or_400(content_mode: str | None, _t: Callable[..., str]) -> str | None:
    if content_mode is None:
        return None
    normalized = str(content_mode).strip()
    if not normalized:
        return None
    if normalized not in _VALID_CONTENT_MODES:
        raise HTTPException(
            status_code=400,
            detail=_t("unknown_content_mode", content_mode=str(content_mode)),
        )
    return normalized


def _normalize_generation_mode_or_400(generation_mode: str | None, _t: Callable[..., str]) -> str | None:
    if generation_mode is None:
        return None
    normalized = str(generation_mode).strip()
    if not normalized:
        return None
    normalized = _LEGACY_GENERATION_MODE_ALIASES.get(normalized, normalized)
    if normalized not in _VALID_GENERATION_MODES:
        raise HTTPException(
            status_code=400,
            detail=_t("unknown_generation_mode", generation_mode=str(generation_mode)),
        )
    return normalized


def _normalize_travel_video_settings(settings: TravelVideoSettings) -> dict[str, Any]:
    raw = settings.model_dump(exclude_none=True)
    normalized: dict[str, Any] = {}
    for key in (
        "origin",
        "destination",
        "route_notes",
        "character_notes",
        "route_source",
        "narration_language",
        "target_duration",
        "camera_style",
        "narrator_persona",
    ):
        value = raw.get(key)
        if not isinstance(value, str):
            continue
        normalized[key] = value.strip()
    reference_images = raw.get("reference_images")
    if isinstance(reference_images, list):
        normalized["reference_images"] = [
            item.strip() for item in reference_images if isinstance(item, str) and item.strip()
        ][:MAX_TRAVEL_REFERENCE_IMAGES]
    custom_duration_seconds = raw.get("custom_duration_seconds")
    if isinstance(custom_duration_seconds, int) and custom_duration_seconds > 0:
        normalized["custom_duration_seconds"] = custom_duration_seconds
    route_preview = raw.get("route_preview")
    if isinstance(route_preview, dict):
        normalized["route_preview"] = route_preview
    return normalized


# Export / import endpoints live in _projects_export.py; the include below
# merges them into this router so app.py wiring is unchanged.
from server.routers._projects_export import router as _export_router  # noqa: E402

router.include_router(_export_router)


@router.get("/projects")
async def list_projects(_user: CurrentUser):
    """列出所有项目"""

    def _sync():
        manager = get_project_manager_for_user(_user.id)
        calculator = get_status_calculator_for_manager(manager)
        projects = []
        for name in manager.list_projects():
            try:
                # 尝试加载项目元数据
                if manager.project_exists(name):
                    project = manager.load_project(name)
                    if not user_can_access_project(project, _user.id):
                        continue
                    # 一次性预加载每集剧本，喂给 cover + status 两路下游，去除重复 JSON I/O。
                    # key 为 episode['script_file'] 原值（match resolve_project_cover /
                    # StatusCalculator 对 key 的期望）。任何一集加载失败都不影响列表：
                    # 仅跳过入 map，下游消费者自然按"缺失"路径兜底。
                    preloaded_scripts: dict[str, dict] = {}
                    for ep in project.get("episodes") or []:
                        script_file = ep.get("script_file")
                        if not script_file:
                            continue
                        try:
                            preloaded_scripts[script_file] = manager.load_script(name, script_file)
                        except (FileNotFoundError, OSError, json.JSONDecodeError, ValueError) as load_err:
                            # 与 resolve_project_cover / StatusCalculator._load_episode_script
                            # 对齐：I/O 缺失 + JSON/schema 解析失败 → 跳过此集，继续预加载其他集；
                            # 非预期异常（RuntimeError/MemoryError 等）让其冒泡到外层 try，走 basic info 兜底行。
                            logger.debug(
                                "list_projects 预加载剧本失败 project=%s script=%s err=%s",
                                name,
                                script_file,
                                load_err,
                            )

                    # 封面走 resolve_project_cover fallback 链：
                    # video_thumbnail → storyboard_image → scene_sheet → character_sheet
                    # —— 兼顾 reference / grid / storyboard 三种生成模式。
                    thumbnail = resolve_project_cover(manager, name, project, preloaded_scripts=preloaded_scripts)

                    # 使用 StatusCalculator 计算进度（读时计算）
                    status = calculator.calculate_project_status(name, project, preloaded_scripts=preloaded_scripts)

                    projects.append(
                        {
                            "name": name,
                            "title": project.get("title", name),
                            "owner_user_id": project_owner_user_id(project),
                            "current_user_role": (
                                "owner"
                                if project_owner_user_id(project) == str(_user.id)
                                else ProjectManager.project_member_role(project, _user.id)
                            ),
                            "content_type": project.get("content_type"),
                            "billing_mode": project.get("billing_mode"),
                            "style": project.get("style", ""),
                            "style_template_id": project.get("style_template_id"),
                            "style_image": project.get("style_image"),
                            "travel_video_settings": project.get("travel_video_settings"),
                            "thumbnail": thumbnail,
                            "status": status,
                        }
                    )
                else:
                    # 没有 project.json 的项目
                    if _user.id != "default":
                        continue
                    projects.append(
                        {
                            "name": name,
                            "title": name,
                            "style": "",
                            "thumbnail": None,
                            "status": {},
                        }
                    )
            except Exception as e:
                if _user.id != "default":
                    continue
                # 出错时返回基本信息
                logger.warning("加载项目 '%s' 元数据失败: %s", name, e)
                projects.append(
                    {"name": name, "title": name, "style": "", "thumbnail": None, "status": {}, "error": str(e)}
                )

        return {"projects": projects}

    return await asyncio.to_thread(_sync)


@router.post("/projects")
async def create_project(
    req: CreateProjectRequest,
    _user: CurrentUser,
    _t: Translator,
):
    """创建新项目"""
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            title = (req.title or "").strip()
            manual_name = (req.name or "").strip()
            if not title and not manual_name:
                raise HTTPException(status_code=400, detail=_t("title_required"))
            project_name = manual_name or manager.generate_project_name(title)
            content_type = _normalize_content_type_or_400(req.content_type, _t)
            workflow_preset = get_workflow_preset(content_type)
            content_mode = _normalize_content_mode_or_400(req.content_mode, _t) or "narration"
            aspect_ratio = req.aspect_ratio or "9:16"
            generation_mode = _normalize_generation_mode_or_400(req.generation_mode, _t)
            default_duration = req.default_duration
            style_template_id = req.style_template_id
            travel_video_settings: dict[str, str] | None = None
            if workflow_preset is not None:
                content_mode = workflow_preset.content_mode
                if "aspect_ratio" not in req.model_fields_set or not aspect_ratio:
                    aspect_ratio = workflow_preset.aspect_ratio
                if generation_mode is None:
                    generation_mode = workflow_preset.generation_mode
                if "default_duration" not in req.model_fields_set:
                    default_duration = workflow_preset.default_duration
                if "style_template_id" not in req.model_fields_set:
                    style_template_id = workflow_preset.style_template_id

            if req.travel_video_settings is not None:
                travel_video_settings = _normalize_travel_video_settings(req.travel_video_settings)
                if workflow_preset is not None and workflow_preset.travel_video_settings:
                    travel_video_settings = {
                        **workflow_preset.travel_video_settings,
                        **travel_video_settings,
                    }
            elif workflow_preset is not None and workflow_preset.travel_video_settings:
                travel_video_settings = dict(workflow_preset.travel_video_settings)

            style_prompt = req.style or ""
            if style_template_id:
                if not is_known_template(style_template_id):
                    raise HTTPException(
                        status_code=400,
                        detail=_t("unknown_style_template", template_id=style_template_id),
                    )
                style_prompt = resolve_template_prompt(style_template_id)

            # 与 update 路径对称：校验所有 backend 字段
            for field_name in (
                "video_backend",
                "image_backend",
                "text_backend_script",
                "text_backend_overview",
                "text_backend_style",
            ):
                value = getattr(req, field_name)
                if value:
                    validate_backend_value(value, field_name, _t)

            try:
                manager.create_project(project_name)
            except FileExistsError:
                raise HTTPException(status_code=400, detail=_t("project_exists", name=project_name))
            extras = {
                field: value
                for field in (
                    "billing_mode",
                    "video_backend",
                    "image_backend",
                    "text_backend_script",
                    "text_backend_overview",
                    "text_backend_style",
                    "character_style_prompt",
                )
                if (value := getattr(req, field))
            }
            if content_type:
                extras["content_type"] = content_type
            if travel_video_settings is not None:
                extras["travel_video_settings"] = travel_video_settings
            if req.model_settings is not None:
                extras["model_settings"] = req.model_settings
            if default_duration is not None:
                extras["default_duration_explicit"] = True
            extras[PROJECT_OWNER_FIELD] = _user.id
            with project_change_source("webui"):
                project = manager.create_project_metadata(
                    project_name,
                    title or manual_name,
                    style_prompt,
                    content_mode,
                    aspect_ratio=aspect_ratio,
                    default_duration=default_duration,
                    style_template_id=style_template_id,
                    extras=extras or None,
                )
                if generation_mode is not None:
                    project["generation_mode"] = generation_mode
                    manager.save_project(project_name, project)
            return {"success": True, "name": project_name, "project": project}

        return await asyncio.to_thread(_sync)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{name}/video-capabilities")
async def get_video_capabilities(
    name: str,
    _user: CurrentUser,
    _t: Translator,
):
    """解析当前项目视频模型能力 + 用户项目偏好。

    三级模型选择（项目 > 系统设置 > 系统默认）后，读 model 的 `supported_durations`
    并派生 `max_duration`；同时带回 `project.json.default_duration`（用户偏好）。
    所有 generation_mode（storyboard/grid/reference_video）都可复用。
    """
    resolver = ConfigResolver(async_session_factory, user_id=_user.id)
    try:
        manager = get_project_manager_for_user(_user.id)
        project = await asyncio.to_thread(manager.load_project, name)
        ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
        result = resolver.video_capabilities_for_project(project)
        if inspect.isawaitable(result):
            return await result
        return await resolver.video_capabilities(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name)) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=_t("video_capabilities_unresolved", name=name, reason=str(exc)),
        ) from exc


@router.get("/projects/{name}/members")
async def list_project_members(name: str, _user: CurrentUser, _t: Translator):
    """List project owner and explicit collaborators."""
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            return _project_members_response(project, current_user_id=_user.id)

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/members")
async def create_project_member(
    name: str,
    req: ProjectMemberCreateRequest,
    _user: CurrentUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
):
    """Grant editor access by username or user id. Only the owner may change membership."""
    target_user_id, target_username = await _resolve_member_identity(req, session)
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            ensure_project_owner(project, user_id=_user.id)
            _grant_project_member(project, user_id=target_user_id, username=target_username, role=req.role)
            manager.save_project(name, project)
            return _project_members_response(project, current_user_id=_user.id)

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/projects/{name}/members/{member_user_id}")
async def upsert_project_member(
    name: str,
    member_user_id: str,
    req: ProjectMemberRequest,
    _user: CurrentUser,
    _t: Translator,
):
    """Grant editor access to a project collaborator. Only the owner may change membership."""
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            ensure_project_owner(project, user_id=_user.id)

            normalized_path_user_id = _normalize_member_user_id(member_user_id)
            normalized_body_user_id = _normalize_member_user_id(req.user_id)
            if normalized_path_user_id != normalized_body_user_id:
                raise HTTPException(status_code=422, detail="member user_id mismatch")
            username = _normalize_member_username(req.username)
            _grant_project_member(project, user_id=normalized_body_user_id, username=username, role=req.role)
            manager.save_project(name, project)
            return _project_members_response(project, current_user_id=_user.id)

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/projects/{name}/members/{member_user_id}")
async def delete_project_member(
    name: str,
    member_user_id: str,
    _user: CurrentUser,
    _t: Translator,
):
    """Revoke explicit collaborator access. Only the owner may change membership."""
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            ensure_project_owner(project, user_id=_user.id)

            normalized_user_id = _normalize_member_user_id(member_user_id)
            access = project.get(PROJECT_ACCESS_FIELD)
            members = access.get(PROJECT_ACCESS_MEMBERS_FIELD) if isinstance(access, dict) else None
            if isinstance(members, dict):
                members.pop(normalized_user_id, None)
                if not members:
                    project.pop(PROJECT_ACCESS_FIELD, None)
            manager.save_project(name, project)
            return _project_members_response(project, current_user_id=_user.id)

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{name}")
async def get_project(
    name: str,
    _user: CurrentUser,
    _t: Translator,
):
    """获取项目详情（含实时计算字段）"""
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            calculator = get_status_calculator_for_manager(manager)
            if not manager.project_exists(name):
                raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))

            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)

            # 注入计算字段（不写入 JSON，仅用于 API 响应）
            project = calculator.enrich_project(name, project)

            # 加载所有剧本并注入计算字段
            scripts = {}
            for ep in project.get("episodes", []):
                script_file = ep.get("script_file", "")
                if script_file:
                    try:
                        script = manager.load_script(name, script_file)
                        script = calculator.enrich_script(script)
                        key = (
                            script_file.replace("scripts/", "", 1)
                            if script_file.startswith("scripts/")
                            else script_file
                        )
                        scripts[key] = script
                    except FileNotFoundError:
                        logger.debug("剧本文件不存在，跳过: %s/%s", name, script_file)

            # 计算媒体文件指纹（用于前端内容寻址缓存）
            project_path = manager.get_project_path(name)
            fingerprints = compute_asset_fingerprints(project_path)

            return {
                "project": project,
                "scripts": scripts,
                "asset_fingerprints": fingerprints,
            }

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/travel-route/preview")
async def preview_travel_route(
    name: str,
    req: TravelRoutePreviewRequest,
    _user: CurrentUser,
    _t: Translator,
    svc: Annotated[ConfigService, Depends(get_config_service)],
):
    """Resolve a travel-video route into generation-ready nodes.

    Google Maps / Street View is optional. With a saved key and complete places,
    this endpoint resolves Google route steps and Street View metadata. Without
    a key, it returns a manual/reference-image preview instead of blocking.
    """

    try:

        def _load_settings() -> dict[str, Any]:
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            if project.get("content_type") != "travel_video":
                raise HTTPException(status_code=400, detail="not a travel video project")
            if req.travel_video_settings is not None:
                return _normalize_travel_video_settings(req.travel_video_settings)
            settings = project.get("travel_video_settings")
            return dict(settings) if isinstance(settings, dict) else {}

        settings = await asyncio.to_thread(_load_settings)
        google_key = (await svc.get_setting("google_maps_api_key", "")).strip()
        baidu_key = (await svc.get_setting("baidu_maps_api_key", "")).strip()
        amap_key = (await svc.get_setting("amap_maps_api_key", "")).strip()
        preview = await build_travel_route_preview(
            settings,
            google_maps_api_key=google_key,
            baidu_maps_api_key=baidu_key,
            amap_maps_api_key=amap_key,
            http_client=get_http_client() if google_key or baidu_key or amap_key else None,
        )

        if req.persist:

            def _persist_preview() -> None:
                manager = get_project_manager_for_user(_user.id)
                project = manager.load_project(name)
                ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
                current = project.get("travel_video_settings")
                merged = dict(current) if isinstance(current, dict) else {}
                merged.update(settings)
                merged["route_preview"] = preview
                project["travel_video_settings"] = merged
                with project_change_source("webui"):
                    manager.save_project(name, project)

            await asyncio.to_thread(_persist_preview)

        return preview
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{name}/travel-route/street-view/{node_id}")
async def get_travel_route_street_view_image(
    name: str,
    node_id: str,
    _user: CurrentUser,
    _t: Translator,
    svc: Annotated[ConfigService, Depends(get_config_service)],
):
    """Proxy a persisted Google Street View thumbnail for a travel route node."""

    try:

        def _load_node() -> dict[str, Any]:
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            if project.get("content_type") != "travel_video":
                raise HTTPException(status_code=400, detail="not a travel video project")
            settings = project.get("travel_video_settings")
            preview = settings.get("route_preview") if isinstance(settings, dict) else None
            nodes = preview.get("nodes") if isinstance(preview, dict) else None
            if not isinstance(nodes, list):
                raise HTTPException(status_code=404, detail="travel route preview not found")
            for raw_node in nodes:
                if isinstance(raw_node, dict) and str(raw_node.get("id") or "") == node_id:
                    return dict(raw_node)
            raise HTTPException(status_code=404, detail="travel route node not found")

        node = await asyncio.to_thread(_load_node)
        google_key = (await svc.get_setting("google_maps_api_key", "")).strip()
        try:
            http_client = get_http_client()
        except RuntimeError:
            http_client = None
        image_bytes, media_type = await fetch_travel_route_street_view_image(
            node,
            google_maps_api_key=google_key,
            http_client=http_client,
        )
        return Response(
            content=image_bytes,
            media_type=media_type,
            headers={"Cache-Control": "private, max-age=300"},
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except httpx.HTTPError as exc:
        logger.warning("Google Street View image proxy failed: %s", exc)
        raise HTTPException(status_code=502, detail="google street view image request failed")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/projects/{name}")
async def update_project(name: str, req: UpdateProjectRequest, _user: CurrentUser, _t: Translator):
    """更新项目元数据"""
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            requested_generation_mode = (
                _normalize_generation_mode_or_400(req.generation_mode, _t)
                if "generation_mode" in req.model_fields_set
                else None
            )

            if req.content_mode is not None:
                raise HTTPException(
                    status_code=400,
                    detail=_t("project_id_not_editable"),
                )

            if req.title is not None:
                project["title"] = req.title
            if req.style is not None:
                project["style"] = req.style
            if "content_type" in req.model_fields_set:
                content_type = _normalize_content_type_or_400(req.content_type, _t)
                if content_type:
                    workflow_preset = get_workflow_preset(content_type)
                    project["content_type"] = content_type
                    if workflow_preset:
                        project["content_mode"] = workflow_preset.content_mode
                        if "aspect_ratio" not in req.model_fields_set:
                            project["aspect_ratio"] = workflow_preset.aspect_ratio
                        if "generation_mode" not in req.model_fields_set:
                            project["generation_mode"] = workflow_preset.generation_mode
                        if (
                            "default_duration" not in req.model_fields_set
                            and project.get("default_duration_explicit") is not True
                        ):
                            project["default_duration"] = workflow_preset.default_duration
                            project["default_duration_explicit"] = True
                        if "style_template_id" not in req.model_fields_set and not project.get("style_image"):
                            current_template = project.get("style_template_id")
                            if current_template is None or str(current_template).startswith("content_"):
                                project["style_template_id"] = workflow_preset.style_template_id
                                project["style"] = resolve_template_prompt(workflow_preset.style_template_id)
                        if "travel_video_settings" not in req.model_fields_set:
                            if workflow_preset.travel_video_settings:
                                project["travel_video_settings"] = dict(workflow_preset.travel_video_settings)
                            else:
                                project.pop("travel_video_settings", None)
                else:
                    project.pop("content_type", None)
            if "billing_mode" in req.model_fields_set:
                if req.billing_mode:
                    project["billing_mode"] = req.billing_mode
                else:
                    project.pop("billing_mode", None)
            for field in (
                "video_backend",
                "image_backend",
                "text_backend_script",
                "text_backend_overview",
                "text_backend_style",
            ):
                if field in req.model_fields_set:
                    value = getattr(req, field)
                    if value:
                        validate_backend_value(value, field, _t)
                        project[field] = value
                    else:
                        project.pop(field, None)
            if "video_generate_audio" in req.model_fields_set:
                if req.video_generate_audio is None:
                    project.pop("video_generate_audio", None)
                else:
                    project["video_generate_audio"] = req.video_generate_audio
            if "character_style_prompt" in req.model_fields_set:
                if req.character_style_prompt:
                    project["character_style_prompt"] = req.character_style_prompt.strip()
                else:
                    project.pop("character_style_prompt", None)
            if "aspect_ratio" in req.model_fields_set and req.aspect_ratio is not None:
                project["aspect_ratio"] = req.aspect_ratio
            if "generation_mode" in req.model_fields_set:
                if requested_generation_mode is None:
                    project.pop("generation_mode", None)
                else:
                    project["generation_mode"] = requested_generation_mode
            if "default_duration" in req.model_fields_set:
                if req.default_duration is None:
                    project.pop("default_duration", None)
                    project.pop("default_duration_explicit", None)
                else:
                    project["default_duration"] = req.default_duration
                    project["default_duration_explicit"] = True

            if "style_template_id" in req.model_fields_set:
                if req.style_template_id is None:
                    # 取消模版选择：同时清掉展开的 style prompt，避免遗留孤儿文本
                    project.pop("style_template_id", None)
                    project["style"] = ""
                else:
                    if not is_known_template(req.style_template_id):
                        raise HTTPException(
                            status_code=400,
                            detail=_t("unknown_style_template", template_id=req.style_template_id),
                        )
                    project["style_template_id"] = req.style_template_id
                    project["style"] = resolve_template_prompt(req.style_template_id)
                    # 强互斥:模版与参考图二选一
                    project.pop("style_image", None)
                    project.pop("style_description", None)

            if req.clear_style_image:
                # 显式清除自定义参考图，用于"取消风格"流程
                project.pop("style_image", None)
                project.pop("style_description", None)

            if "model_settings" in req.model_fields_set:
                if req.model_settings is None:
                    project.pop("model_settings", None)
                else:
                    project["model_settings"] = req.model_settings

            if "travel_video_settings" in req.model_fields_set:
                if req.travel_video_settings is None:
                    project.pop("travel_video_settings", None)
                else:
                    project["travel_video_settings"] = _normalize_travel_video_settings(req.travel_video_settings)

            if "episodes" in req.model_fields_set and req.episodes is not None:
                # 合并 episodes：保留现有 episode 的完整数据，仅更新请求中显式提供的字段。
                # 使用 model_fields_set（而非 exclude_none）判断字段是否显式出现，使得
                # `generation_mode: null` 可用于清空集级覆盖、回退到项目级模式继承。
                # 白名单同时拦截 StatusCalculator 注入的计算字段（scenes_count / status
                # / storyboards / videos 等），防止写回 project.json。
                existing_list = project.get("episodes", [])
                patch_map: dict[int, EpisodePatch] = {}
                for ep in req.episodes:
                    patch_map[ep.episode] = ep  # 重复编号：后者覆盖前者

                new_episodes: list[dict] = []
                for existing_ep in existing_list:
                    ep_num = existing_ep.get("episode")
                    patch = patch_map.pop(ep_num, None)
                    if patch is None:
                        new_episodes.append(existing_ep)
                        continue
                    updated = dict(existing_ep)
                    for field_name in EPISODE_PERSIST_FIELDS:
                        if field_name not in patch.model_fields_set:
                            continue
                        value = getattr(patch, field_name)
                        if value is None:
                            updated.pop(field_name, None)
                        else:
                            updated[field_name] = value
                    new_episodes.append(updated)

                for unknown_ep in patch_map:
                    logger.warning("Skipping patch for unknown episode %s", unknown_ep)

                project["episodes"] = new_episodes

            with project_change_source("webui"):
                manager.save_project(name, project)
            return {"success": True, "project": project}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/projects/{name}")
async def delete_project(name: str, _user: CurrentUser, _t: Translator):
    """删除项目"""
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            ensure_project_owner(project, user_id=_user.id)
            shutil.rmtree(manager.get_project_path(name))
            return {"success": True, "message": _t("project_deleted", name=name)}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{name}/scripts/{script_file}")
async def get_script(name: str, script_file: str, _user: CurrentUser, _t: Translator):
    """获取剧本内容"""
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            return manager.load_script(name, script_file)

        script = await asyncio.to_thread(_sync)
        return {"script": script}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("script_not_found", name=script_file))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


class UpdateSceneRequest(BaseModel):
    script_file: str
    updates: dict


@router.patch("/projects/{name}/scenes/{scene_id}")
async def update_scene(name: str, scene_id: str, req: UpdateSceneRequest, _user: CurrentUser, _t: Translator):
    """更新场景"""
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            script = manager.load_script(name, req.script_file)

            # 找到并更新场景
            scene_found = False
            for scene in script.get("scenes", []):
                if scene.get("scene_id") == scene_id:
                    scene_found = True
                    # 更新允许的字段
                    for key, value in req.updates.items():
                        if key in [
                            "duration_seconds",
                            "image_prompt",
                            "video_prompt",
                            "characters_in_scene",
                            "scenes",
                            "props",
                            "segment_break",
                            "note",
                        ]:
                            if value is None and key != "note":
                                continue
                            scene[key] = value
                    break

            if not scene_found:
                raise HTTPException(status_code=404, detail=_t("scene_not_found", id=scene_id))

            with project_change_source("webui"):
                manager.save_script(name, script, req.script_file)
            return {"success": True, "scene": scene}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("script_not_found", name=req.script_file))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


class UpdateSegmentRequest(BaseModel):
    script_file: str
    duration_seconds: int | None = None
    segment_break: bool | None = None
    image_prompt: dict | str | None = None
    video_prompt: dict | str | None = None
    transition_to_next: str | None = None
    note: str | None = None
    characters_in_segment: list[str] | None = None
    scenes: list[str] | None = None
    props: list[str] | None = None


@router.patch("/projects/{name}/segments/{segment_id}")
async def update_segment(name: str, segment_id: str, req: UpdateSegmentRequest, _user: CurrentUser, _t: Translator):
    """更新说书模式片段"""
    try:

        def _sync():
            manager = get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            script = manager.load_script(name, req.script_file)

            # 检查是否为说书模式
            if script.get("content_mode") != "narration" and "segments" not in script:
                raise HTTPException(status_code=400, detail=_t("narration_mode_required"))

            # 找到并更新片段
            segment_found = False
            for segment in script.get("segments", []):
                if segment.get("segment_id") == segment_id:
                    segment_found = True
                    if req.duration_seconds is not None:
                        segment["duration_seconds"] = req.duration_seconds
                    if req.segment_break is not None:
                        segment["segment_break"] = req.segment_break
                    if req.image_prompt is not None:
                        segment["image_prompt"] = req.image_prompt
                    if req.video_prompt is not None:
                        segment["video_prompt"] = req.video_prompt
                    if req.transition_to_next is not None:
                        segment["transition_to_next"] = req.transition_to_next
                    if "note" in req.model_fields_set:
                        segment["note"] = req.note
                    for field in ("characters_in_segment", "scenes", "props"):
                        if field in req.model_fields_set:
                            segment[field] = getattr(req, field) or []
                    break

            if not segment_found:
                raise HTTPException(status_code=404, detail=_t("segment_not_found", id=segment_id))

            with project_change_source("webui"):
                manager.save_script(name, script, req.script_file)
            return {"success": True, "segment": segment}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("script_not_found", name=req.script_file))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 源文件管理 ====================


@router.post("/projects/{name}/source")
async def set_project_source(
    name: Annotated[str, FastAPIPath(pattern=r"^[a-zA-Z0-9_-]+$")],
    _user: CurrentUser,
    _t: Translator,
    generate_overview: Annotated[bool, Form()] = True,
    content: Annotated[str | None, Form()] = None,
    file: Annotated[UploadFile | None, File()] = None,
):
    """上传小说源文件或直接提交文本内容，可选触发 AI 概述生成。

    两种输入方式（互斥，均使用 multipart/form-data）：
    - file：上传 .txt/.md 文件，文件名取自上传文件
    - content：直接提交文本内容，自动命名为 novel.txt

    最大 200000 字符（约 10 万汉字）。
    """
    MAX_CHARS = 200_000
    ALLOWED_SUFFIXES = {".txt", ".md"}

    if not content and not file:
        raise HTTPException(status_code=400, detail=_t("content_or_file_required"))
    if content and file:
        raise HTTPException(status_code=400, detail=_t("one_of_content_or_file"))

    try:
        manager = get_project_manager_for_user(_user.id)

        # 异步读取上传文件
        raw: bytes | None = None
        if file:
            original_name = file.filename or "novel.txt"
            suffix = Path(original_name).suffix.lower()
            if suffix not in ALLOWED_SUFFIXES:
                raise HTTPException(status_code=400, detail=_t("unsupported_file_type", name=suffix))
            if file.size is not None and file.size > MAX_CHARS * 4:
                raise HTTPException(status_code=400, detail=_t("file_too_large", max_chars=MAX_CHARS))
            raw = await file.read()

        # 同步文件 I/O 在线程中执行
        def _sync_write():
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
            project_dir = manager.get_project_path(name)
            source_dir = project_dir / "source"
            source_dir.mkdir(parents=True, exist_ok=True)

            if raw is not None:
                safe_filename = Path(original_name).name
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    raise HTTPException(status_code=400, detail=_t("invalid_encoding"))
                if len(text) > MAX_CHARS:
                    raise HTTPException(status_code=400, detail=_t("file_too_large", max_chars=MAX_CHARS))
                (source_dir / safe_filename).write_text(text, encoding="utf-8")
                return safe_filename, len(text)
            else:
                if len(content) > MAX_CHARS:
                    raise HTTPException(status_code=400, detail=_t("file_too_large", max_chars=MAX_CHARS))
                safe_filename = "novel.txt"
                (source_dir / safe_filename).write_text(content, encoding="utf-8")
                return safe_filename, len(content)

        safe_filename, chars = await asyncio.to_thread(_sync_write)

        result: dict = {"success": True, "filename": safe_filename, "chars": chars}

        if generate_overview:
            try:
                with project_change_source("webui"):
                    overview = await manager.generate_overview(name, user_id=_user.id)
                result["overview"] = overview
            except Exception as ov_err:
                result["overview"] = None
                result["overview_error"] = str(ov_err)

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if file:
            await file.close()


# ==================== 项目概述管理 ====================


# Generation endpoints live in _projects_generation.py; the include below
# merges them into this router so app.py wiring is unchanged.
from server.routers._projects_generation import router as _generation_router  # noqa: E402

router.include_router(_generation_router)
