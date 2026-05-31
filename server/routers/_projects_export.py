"""Export / import endpoints for projects.

Extracted from ``projects.py`` so the main router stops being a god file.
Endpoints are included into the main router via ``router.include_router`` —
all routes keep their existing paths and the app.py wiring is untouched.

Helpers from the main router (``get_project_manager``, ``get_project_manager_for_user``,
``get_archive_service``) are accessed through deferred module-attribute lookups
so that test ``monkeypatch.setattr(projects, "get_project_manager", ...)`` calls
keep working — both the main router and these endpoints read the same name from
the same module object.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

from lib.i18n import Translator
from server.auth import CurrentUser, CurrentUserInfo, create_download_token, verify_download_token
from server.services.project_access import PROJECT_OWNER_FIELD, ensure_project_access
from server.services.project_archive import ProjectArchiveService, ProjectArchiveValidationError

if TYPE_CHECKING:
    from lib.project_manager import ProjectManager
    from server.services.jianying_draft_service import JianyingDraftService

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Deferred accessors — read attributes from the main projects module on each
# call so tests that monkeypatch ``projects.get_project_manager`` apply here too.
# ---------------------------------------------------------------------------


def _projects_main():
    from server.routers import projects as _main

    return _main


def _get_project_manager_for_user(user_id: str | None) -> ProjectManager:
    return _projects_main().get_project_manager_for_user(user_id)


def _get_archive_service(user_id: str | None = None) -> ProjectArchiveService:
    return _projects_main().get_archive_service(user_id)


def get_jianying_draft_service(user_id: str | None = None) -> JianyingDraftService:
    """Factory for the jianying draft service used by the export endpoint."""
    from server.services.jianying_draft_service import JianyingDraftService

    return JianyingDraftService(
        _get_project_manager_for_user(user_id) if user_id is not None else _projects_main().get_project_manager()
    )


def _build_export_preflight_payload(
    name: str,
    current_user: CurrentUserInfo,
    translate: Translator,
    *,
    scope: str,
) -> dict:
    if scope not in ("full", "current"):
        raise HTTPException(status_code=422, detail=translate("scope_invalid"))

    manager = _get_project_manager_for_user(current_user.id)
    if not manager.project_exists(name):
        raise HTTPException(status_code=404, detail=translate("project_not_found", name=name))
    project = manager.load_project(name)
    ensure_project_access(project, user_id=current_user.id, project_name=name, translate=translate)
    return _get_archive_service(current_user.id).get_export_preflight(name, scope=scope)


def _cleanup_temp_file(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        return


def _cleanup_temp_dir(dir_path: str) -> None:
    shutil.rmtree(dir_path, ignore_errors=True)


def _validate_draft_path(draft_path: str, _t: Callable[..., str]) -> str:
    """Validate the user-supplied jianying draft directory path."""
    if not draft_path or not draft_path.strip():
        raise HTTPException(status_code=422, detail=_t("jianying_path_invalid"))
    if len(draft_path) > 1024:
        raise HTTPException(status_code=422, detail=_t("jianying_path_too_long"))
    if any(ord(c) < 32 for c in draft_path):
        raise HTTPException(status_code=422, detail=_t("jianying_path_illegal"))
    return draft_path.strip()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/projects/import")
async def import_project_archive(
    _user: CurrentUser,
    _t: Translator,
    file: UploadFile = File(...),
    conflict_policy: str = Form("prompt"),
):
    """从 ZIP 导入项目。"""
    upload_path: str | None = None
    try:
        fd, upload_path = tempfile.mkstemp(prefix="arcreel-upload-", suffix=".zip")
        os.close(fd)

        # 使用底层 SpooledTemporaryFile 的同步句柄，整循环 offload 到线程，
        # 避免 async 读取 + 同步写入的混合模式阻塞事件循环 (#230)
        raw_file = file.file

        def _write_upload():
            with open(upload_path, "wb") as target:
                while True:
                    chunk = raw_file.read(1024 * 1024)
                    if not chunk:
                        break
                    target.write(chunk)

        await asyncio.to_thread(_write_upload)

        def _sync():
            manager = _get_project_manager_for_user(_user.id)
            result = _get_archive_service(_user.id).import_project_archive(
                Path(upload_path),
                uploaded_filename=file.filename,
                conflict_policy=conflict_policy,
            )
            project = manager.load_project(result.project_name)
            project[PROJECT_OWNER_FIELD] = _user.id
            manager.save_project(result.project_name, project)
            result.project[PROJECT_OWNER_FIELD] = _user.id
            return result

        result = await asyncio.to_thread(_sync)
        return {
            "success": True,
            "project_name": result.project_name,
            "project": result.project,
            "warnings": result.warnings,
            "conflict_resolution": result.conflict_resolution,
            "diagnostics": result.diagnostics,
        }
    except ProjectArchiveValidationError as exc:
        diagnostics = exc.extra.get(
            "diagnostics",
            {"blocking": [], "auto_fixable": [], "warnings": []},
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "detail": exc.detail,
                "errors": exc.errors,
                "warnings": exc.warnings,
                "diagnostics": diagnostics,
                **exc.extra,
            },
        )
    except Exception as e:
        logger.exception("请求处理失败")
        return JSONResponse(
            status_code=500,
            content={"detail": str(e), "errors": [], "warnings": []},
        )
    finally:
        await file.close()
        if upload_path:
            _cleanup_temp_file(upload_path)


@router.post("/projects/{name}/export/preflight")
async def get_export_preflight(
    name: str,
    current_user: CurrentUser,
    _t: Translator,
    scope: str = Query("full"),
):
    """执行导出预检并返回诊断/交付报告，不签发下载 token。"""
    try:
        return await asyncio.to_thread(lambda: _build_export_preflight_payload(name, current_user, _t, scope=scope))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{name}/export/token")
async def create_export_token(
    name: str,
    current_user: CurrentUser,
    _t: Translator,
    scope: str = Query("full"),
):
    """签发短时效下载 token，用于浏览器原生下载认证。"""
    try:
        preflight = await asyncio.to_thread(
            lambda: _build_export_preflight_payload(name, current_user, _t, scope=scope)
        )
        username = current_user.sub
        download_token = create_download_token(username, name, user_id=current_user.id)
        return {
            "download_token": download_token,
            "expires_in": 300,
            "diagnostics": preflight["diagnostics"],
            "delivery_report": preflight["delivery_report"],
            "travel_route_assets": preflight.get("travel_route_assets"),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{name}/export")
async def export_project_archive(
    name: str,
    _t: Translator,
    download_token: str = Query(...),
    scope: str = Query("full"),
):
    """将项目导出为 ZIP。需要 download_token 认证（通过 POST /export/token 获取）。"""
    if scope not in ("full", "current"):
        raise HTTPException(status_code=422, detail=_t("scope_invalid"))

    import jwt as pyjwt

    try:
        payload = verify_download_token(download_token, name)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail=_t("download_expired"))
    except ValueError:
        raise HTTPException(status_code=403, detail=_t("download_token_mismatch"))
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail=_t("download_token_invalid"))

    try:
        user_id = str(payload.get("uid") or "default")
        archive_path, download_name = await asyncio.to_thread(
            lambda: _get_archive_service(user_id).export_project(name, scope=scope)
        )
        return FileResponse(
            archive_path,
            media_type="application/zip",
            filename=download_name,
            background=BackgroundTask(_cleanup_temp_file, str(archive_path)),
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=_t("project_not_found", name=name))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("请求处理失败")
        raise HTTPException(status_code=500, detail=str(e))


# --- 剪映草稿导出 ---


@router.get("/projects/{name}/export/jianying-draft")
def export_jianying_draft(
    name: str,
    _t: Translator,
    episode: int = Query(..., description="集数编号"),
    draft_path: str = Query(..., description="用户本地剪映草稿目录"),
    download_token: str = Query(..., description="下载 token"),
    jianying_version: str = Query("6", description="剪映版本：6 或 5"),
):
    """导出指定集的剪映草稿 ZIP"""
    import jwt as pyjwt

    try:
        payload = verify_download_token(download_token, name)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail=_t("download_expired"))
    except ValueError:
        raise HTTPException(status_code=403, detail=_t("download_token_mismatch"))
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail=_t("download_token_invalid"))

    draft_path = _validate_draft_path(draft_path, _t)

    user_id = str(payload.get("uid") or "default")
    svc = get_jianying_draft_service(user_id)
    try:
        zip_path = svc.export_episode_draft(
            project_name=name,
            episode=episode,
            draft_path=draft_path,
            use_draft_info_name=(jianying_version != "5"),
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception:
        logger.exception("剪映草稿导出失败: project=%s episode=%d", name, episode)
        raise HTTPException(status_code=500, detail=_t("jianying_export_failed"))

    download_name = f"{name}_episode_{episode}_jianying_draft.zip"

    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename=download_name,
        background=BackgroundTask(_cleanup_temp_dir, str(zip_path.parent)),
    )
