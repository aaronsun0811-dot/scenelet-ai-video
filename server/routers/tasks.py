"""
任务队列与 SSE 路由。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from datetime import UTC, datetime

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.sse import EventSourceResponse, ServerSentEvent

from lib.generation_queue import (
    get_generation_queue,
    read_queue_poll_interval,
)
from lib.i18n import Translator
from server.auth import CurrentUser, CurrentUserFlexible
from server.services.billing import (
    ensure_platform_credits_balance,
    estimate_generation_task_credits,
    reserve_platform_credits_for_task_or_cancel,
)
from server.services.project_access import load_project_for_user

try:
    from lib.config.resolver import get_project_manager
except ImportError:  # pragma: no cover - import guard for minimal test harnesses
    get_project_manager = None  # type: ignore[assignment]

router = APIRouter()
logger = logging.getLogger(__name__)


def get_task_queue():
    return get_generation_queue()


def _utc_now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _cancel_retry_tasks(queue, task_ids: list[str], user_id: str) -> None:
    for retry_task_id in task_ids:
        try:
            await queue.cancel_task(retry_task_id, user_id=user_id)
        except Exception:
            logger.exception("重试任务积分冻结失败后取消任务失败 task_id=%s", retry_task_id)


def _retry_model_rule_media_type(task_type: str, media_type: str | None) -> str | None:
    if media_type in {"image", "video"}:
        return media_type
    if task_type in {"storyboard", "character", "scene", "prop", "grid"}:
        return "image"
    if task_type in {"video", "reference_video"}:
        return "video"
    return None


def _parse_last_event_id(value: str | None) -> int | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return max(0, parsed)


def _transform_task_event(raw_event: dict, stats: dict) -> dict:
    """将原始 task_events 行转换为前端期望的 TaskStreamTaskPayload 结构。"""
    event_type = raw_event.get("event_type", "")
    action = "created" if event_type == "queued" else "updated"
    return {
        "action": action,
        "task": raw_event.get("data", {}),
        "stats": stats,
    }


@router.get("/tasks/stats")
async def get_task_stats(_user: CurrentUser, project_name: str | None = None):
    queue = get_task_queue()
    stats = await queue.get_task_stats(project_name=project_name, user_id=_user.id)
    return {"stats": stats}


@router.get("/tasks")
async def list_tasks(
    _user: CurrentUser,
    project_name: str | None = None,
    status: str | None = None,
    task_type: str | None = None,
    source: str | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=500),
):
    queue = get_task_queue()
    return await queue.list_tasks(
        project_name=project_name,
        status=status,
        task_type=task_type,
        source=source,
        user_id=_user.id,
        page=page,
        page_size=page_size,
    )


@router.get("/projects/{project_name}/tasks")
async def list_project_tasks(
    project_name: str,
    _user: CurrentUser,
    status: str | None = None,
    task_type: str | None = None,
    source: str | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=500),
):
    queue = get_task_queue()
    return await queue.list_tasks(
        project_name=project_name,
        status=status,
        task_type=task_type,
        source=source,
        user_id=_user.id,
        page=page,
        page_size=page_size,
    )


@router.get("/tasks/stream", response_class=EventSourceResponse, deprecated=True)
async def stream_tasks(
    request: Request,
    _user: CurrentUserFlexible,
    project_name: str | None = None,
    last_event_id: int | None = Query(default=None, ge=0),
    last_event_header: str | None = Header(default=None, alias="Last-Event-ID"),
) -> AsyncIterator[ServerSentEvent]:
    queue = get_task_queue()
    poll_interval = read_queue_poll_interval()

    header_last_id = _parse_last_event_id(last_event_header)
    resume_requested = (last_event_id is not None) or (header_last_id is not None)
    cursor = last_event_id if last_event_id is not None else header_last_id
    if cursor is None:
        cursor = 0
    cursor = max(0, int(cursor))

    latest_event_id = await queue.get_latest_event_id(project_name=project_name, user_id=_user.id)
    snapshot_last_event_id = max(cursor, latest_event_id) if resume_requested else latest_event_id
    snapshot = {
        "project_name": project_name,
        "tasks": await queue.get_recent_tasks_snapshot(project_name=project_name, user_id=_user.id, limit=1000),
        "stats": await queue.get_task_stats(project_name=project_name, user_id=_user.id),
        "last_event_id": snapshot_last_event_id,
        "generated_at": _utc_now_iso(),
    }
    yield ServerSentEvent(event="snapshot", data=snapshot)
    cursor = snapshot_last_event_id

    while True:
        if await request.is_disconnected():
            break

        events = await queue.get_events_since(
            last_event_id=cursor,
            project_name=project_name,
            user_id=_user.id,
            limit=200,
        )
        if events:
            batch_stats = await queue.get_task_stats(project_name=project_name, user_id=_user.id)
            for event in events:
                cursor = int(event["id"])
                transformed = _transform_task_event(event, batch_stats)
                yield ServerSentEvent(
                    event="task",
                    data=transformed,
                    id=str(cursor),
                )
            continue

        await asyncio.sleep(poll_interval)


@router.get("/tasks/{task_id}/cancel-preview")
async def cancel_preview(task_id: str, _user: CurrentUser):
    queue = get_task_queue()
    try:
        preview = await queue.get_cancel_preview(task_id, user_id=_user.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return preview


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, _user: CurrentUser):
    queue = get_task_queue()
    try:
        result = await queue.cancel_task(task_id, user_id=_user.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result


@router.post("/tasks/{task_id}/retry")
async def retry_failed_task(task_id: str, _user: CurrentUser, _t: Translator):
    queue = get_task_queue()
    try:
        task = await queue.get_task(task_id, user_id=_user.id)
        project_cache: dict[str, dict] = {}

        def _project_for_task(project_name: str) -> dict:
            if project_name not in project_cache:
                project_cache[project_name] = load_project_for_user(
                    get_project_manager(),
                    project_name,
                    user_id=_user.id,
                    translate=_t,
                )
            return project_cache[project_name]

        async def _refresh_retry_payload(payload: dict, task_context: dict) -> dict:
            media_type = _retry_model_rule_media_type(
                str(task_context.get("task_type") or ""),
                str(task_context.get("media_type") or "") or None,
            )
            if not media_type:
                return payload
            project_name = str(task_context.get("project_name") or "")
            if not project_name:
                return payload
            from server.routers.generate import _payload_with_model_rule_summary

            return await _payload_with_model_rule_summary(
                _project_for_task(project_name),
                payload,
                task_type=str(task_context.get("task_type") or ""),
                media_type=media_type,
                user_id=_user.id,
                replace_existing=True,
            )

        payload_refresh = _refresh_retry_payload if task and task.get("status") == "failed" and get_project_manager is not None else None
        if task and task.get("status") == "failed" and get_project_manager is not None:
            project = _project_for_task(str(task.get("project_name") or ""))
            required_credits = await estimate_generation_task_credits(
                project,
                str(task.get("task_type") or ""),
                task.get("payload") if isinstance(task.get("payload"), dict) else {},
                user_id=_user.id,
                project_name=str(task.get("project_name") or ""),
            )
            await ensure_platform_credits_balance(project, _user.id, required_credits=required_credits)
        result = await queue.retry_failed_task(task_id, user_id=_user.id, payload_refresh=payload_refresh)
        if (
            task
            and task.get("status") == "failed"
            and get_project_manager is not None
        ):
            retried_tasks = result.get("retried_tasks")
            if not isinstance(retried_tasks, list):
                retried_tasks = [
                    {
                        "task_id": result["task_id"],
                        "task_type": str(task.get("task_type") or ""),
                        "project_name": str(task.get("project_name") or ""),
                        "payload": task.get("payload") if isinstance(task.get("payload"), dict) else {},
                        "deduped": result.get("deduped", False),
                    }
                ]

            reservations = []
            for retried_task in retried_tasks:
                if not isinstance(retried_task, dict) or retried_task.get("deduped"):
                    continue
                retry_task_id = str(retried_task.get("task_id") or "")
                if not retry_task_id:
                    continue
                retry_project_name = str(retried_task.get("project_name") or task.get("project_name") or "")
                retry_task_type = str(retried_task.get("task_type") or task.get("task_type") or "")
                retry_payload = retried_task.get("payload") if isinstance(retried_task.get("payload"), dict) else {}
                retry_required_credits = await estimate_generation_task_credits(
                    project,
                    retry_task_type,
                    retry_payload,
                    user_id=_user.id,
                    project_name=retry_project_name,
                )
                reservations.append(
                    {
                        "task_id": retry_task_id,
                        "task_type": retry_task_type,
                        "project_name": retry_project_name,
                        "required_credits": retry_required_credits,
                    }
                )

            if reservations:
                await ensure_platform_credits_balance(
                    project,
                    _user.id,
                    required_credits=sum(item["required_credits"] for item in reservations),
                )
                try:
                    for reservation in reservations:
                        await reserve_platform_credits_for_task_or_cancel(
                            project,
                            _user.id,
                            task_id=reservation["task_id"],
                            required_credits=reservation["required_credits"],
                            task_type=reservation["task_type"],
                            project_name=reservation["project_name"],
                            queue=queue,
                        )
                except HTTPException:
                    await _cancel_retry_tasks(queue, [item["task_id"] for item in reservations], _user.id)
                    raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result


@router.get("/projects/{project_name}/tasks/cancel-all-preview")
async def cancel_all_preview(project_name: str, _user: CurrentUser):
    queue = get_task_queue()
    queued_count = await queue.get_cancel_all_preview(project_name, user_id=_user.id)
    return {"queued_count": queued_count}


@router.post("/projects/{project_name}/tasks/cancel-all")
async def cancel_all_queued(project_name: str, _user: CurrentUser):
    queue = get_task_queue()
    result = await queue.cancel_all_queued(project_name, user_id=_user.id)
    return result


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str,
    _user: CurrentUser,
    _t: Translator,
):
    queue = get_task_queue()
    task = await queue.get_task(task_id, user_id=_user.id)
    if not task:
        raise HTTPException(status_code=404, detail=_t("task_not_found", id=task_id))
    return {"task": task}
