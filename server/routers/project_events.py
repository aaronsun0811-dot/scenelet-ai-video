"""
SSE stream for project data changes inside the workspace.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.sse import EventSourceResponse, ServerSentEvent

from lib import PROJECT_ROOT
from lib.i18n import Translator
from lib.project_manager import ProjectManager
from server.auth import CurrentUserFlexible
from server.services.project_access import load_project_for_user
from server.services.project_events import ProjectEventService

router = APIRouter()

PROJECT_EVENTS_SSE_POLL_SECONDS = 1.0
pm = ProjectManager(PROJECT_ROOT / "projects")


def get_project_manager() -> ProjectManager:
    return pm


def get_project_event_service(request: Request) -> ProjectEventService:
    return request.app.state.project_event_service


async def _project_events_subscription(
    project_name: str,
    request: Request,
    user_id: str,
) -> tuple[ProjectEventService, asyncio.Queue, dict[str, Any]]:
    service = get_project_event_service(request)
    try:
        try:
            queue, snapshot = await service.subscribe(project_name, user_id=user_id)
        except TypeError:
            queue, snapshot = await service.subscribe(project_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return service, queue, snapshot


@router.get(
    "/projects/{project_name}/events/stream",
    response_class=EventSourceResponse,
)
async def stream_project_events(
    project_name: str,
    request: Request,
    _user: CurrentUserFlexible,
    _t: Translator,
) -> AsyncIterator[ServerSentEvent]:
    load_project_for_user(get_project_manager(), project_name, user_id=_user.id, translate=_t)
    subscription = await _project_events_subscription(project_name, request, _user.id)
    service, queue, snapshot = subscription

    try:
        yield ServerSentEvent(event="snapshot", data=snapshot)

        while True:
            if await request.is_disconnected():
                break
            try:
                event_name, payload = await asyncio.wait_for(
                    queue.get(),
                    timeout=PROJECT_EVENTS_SSE_POLL_SECONDS,
                )
            except TimeoutError:
                continue
            yield ServerSentEvent(event=event_name, data=payload)
    finally:
        try:
            await service.unsubscribe(project_name, queue, user_id=_user.id)
        except TypeError:
            await service.unsubscribe(project_name, queue)
