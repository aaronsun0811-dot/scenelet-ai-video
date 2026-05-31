"""LLM-driven generation endpoints for projects.

Extracted from ``projects.py``. Endpoints are included into the main router via
``router.include_router`` — all paths keep their existing URLs and the app.py
wiring is untouched.

See ``_projects_export.py`` for the rationale behind the deferred-module-attribute
``_projects_main()`` accessor pattern.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lib.i18n import Translator
from lib.project_change_hints import project_change_source
from server.auth import CurrentUser
from server.services.project_access import ensure_project_access

logger = logging.getLogger(__name__)

router = APIRouter()


class UpdateOverviewRequest(BaseModel):
    synopsis: str | None = None
    genre: str | None = None
    theme: str | None = None
    world_setting: str | None = None


class GenerateEpisodeDraftRequest(BaseModel):
    episode: int = 1


class GenerateEpisodeScriptRequest(BaseModel):
    episode: int = 1


def _projects_main():
    from server.routers import projects as _main

    return _main


def _get_project_manager_for_user(user_id: str | None):
    return _projects_main().get_project_manager_for_user(user_id)


@router.post("/projects/{name}/generate-overview")
async def generate_overview(name: str, _user: CurrentUser, _t: Translator):
    """使用 AI 生成项目概述"""
    try:
        manager = _get_project_manager_for_user(_user.id)
        project = await asyncio.to_thread(manager.load_project, name)
        ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
        with project_change_source("webui"):
            overview = await manager.generate_overview(name, user_id=_user.id)
        return {"success": True, "overview": overview}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/generate-characters")
async def generate_characters(name: str, _user: CurrentUser, _t: Translator):
    """使用 AI 从项目素材生成/补全角色库"""
    try:
        manager = _get_project_manager_for_user(_user.id)
        project = await asyncio.to_thread(manager.load_project, name)
        ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
        with project_change_source("webui"):
            result = await manager.generate_characters(name, user_id=_user.id)
        return {"success": True, **result}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/generate-scenes")
async def generate_scenes(name: str, _user: CurrentUser, _t: Translator):
    """使用 AI 从项目素材生成/补全场景库"""
    try:
        manager = _get_project_manager_for_user(_user.id)
        project = await asyncio.to_thread(manager.load_project, name)
        ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
        with project_change_source("webui"):
            result = await manager.generate_scenes(name, user_id=_user.id)
        return {"success": True, **result}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/generate-props")
async def generate_props(name: str, _user: CurrentUser, _t: Translator):
    """使用 AI 从项目素材生成/补全道具库"""
    try:
        manager = _get_project_manager_for_user(_user.id)
        project = await asyncio.to_thread(manager.load_project, name)
        ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
        with project_change_source("webui"):
            result = await manager.generate_props(name, user_id=_user.id)
        return {"success": True, **result}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/generate-episode-draft")
async def generate_episode_draft(name: str, req: GenerateEpisodeDraftRequest, _user: CurrentUser, _t: Translator):
    """使用 AI 从项目素材生成分集 Step1 草稿"""
    try:
        manager = _get_project_manager_for_user(_user.id)
        project = await asyncio.to_thread(manager.load_project, name)
        ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
        with project_change_source("webui"):
            result = await manager.generate_episode_draft(name, req.episode, user_id=_user.id)
        return {"success": True, **result}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/generate-episode-script")
async def generate_episode_script(name: str, req: GenerateEpisodeScriptRequest, _user: CurrentUser, _t: Translator):
    """使用 AI 将分集 Step1 草稿生成最终 JSON 剧本"""
    try:
        manager = _get_project_manager_for_user(_user.id)
        project = await asyncio.to_thread(manager.load_project, name)
        ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))

    try:
        project_path = await asyncio.to_thread(manager.get_project_path, name)
        # ScriptGenerator looked up via main module so tests can monkeypatch projects.ScriptGenerator.
        ScriptGenerator = _projects_main().ScriptGenerator
        with project_change_source("webui"):
            generator = await ScriptGenerator.create(project_path, user_id=_user.id)
            output_path = await generator.generate(req.episode)
            script_filename = Path(output_path).name
            await asyncio.to_thread(manager.sync_episode_from_script, name, script_filename)
        script = await asyncio.to_thread(manager.load_script, name, script_filename)
        return {
            "success": True,
            "episode": req.episode,
            "script_file": f"scripts/{script_filename}",
            "script": script,
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/projects/{name}/overview")
async def update_overview(name: str, req: UpdateOverviewRequest, _user: CurrentUser, _t: Translator):
    """更新项目概述（手动编辑）"""
    try:

        def _sync():
            manager = _get_project_manager_for_user(_user.id)
            project = manager.load_project(name)
            ensure_project_access(project, user_id=_user.id, project_name=name, translate=_t)

            if "overview" not in project:
                project["overview"] = {}

            if req.synopsis is not None:
                project["overview"]["synopsis"] = req.synopsis
            if req.genre is not None:
                project["overview"]["genre"] = req.genre
            if req.theme is not None:
                project["overview"]["theme"] = req.theme
            if req.world_setting is not None:
                project["overview"]["world_setting"] = req.world_setting

            with project_change_source("webui"):
                manager.save_project(name, project)
            return {"success": True, "overview": project["overview"]}

        return await asyncio.to_thread(_sync)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))
