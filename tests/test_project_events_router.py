import asyncio
import inspect
from types import SimpleNamespace

import pytest

from server.auth import CurrentUserInfo
from server.routers import project_events as project_events_router


class _FakeRequest:
    def __init__(self, app):
        self.app = app

    async def is_disconnected(self):
        return False


class _FakeService:
    def __init__(self):
        self.unsubscribed = False
        self.queue = None

    async def subscribe(self, project_name: str):
        queue = asyncio.Queue()
        await queue.put(
            (
                "changes",
                {
                    "project_name": project_name,
                    "batch_id": "batch-1",
                    "fingerprint": "fp-1",
                    "generated_at": "2026-03-01T00:00:00Z",
                    "source": "filesystem",
                    "changes": [],
                },
            )
        )
        self.queue = queue
        return queue, {
            "project_name": project_name,
            "fingerprint": "fp-0",
            "generated_at": "2026-03-01T00:00:00Z",
        }

    async def unsubscribe(self, project_name: str, queue):
        self.unsubscribed = True


class _FakeProjectManager:
    def load_project(self, project_name: str):
        return {"name": project_name, "owner_user_id": "default"}


def test_stream_project_events_endpoint_is_async_generator():
    assert inspect.isasyncgenfunction(project_events_router.stream_project_events)


@pytest.mark.asyncio
async def test_stream_project_events_endpoint_emits_snapshot(monkeypatch):
    service = _FakeService()
    app = SimpleNamespace(state=SimpleNamespace(project_event_service=service))
    request = _FakeRequest(app)

    monkeypatch.setattr(project_events_router, "get_project_manager", lambda: _FakeProjectManager())

    stream = project_events_router.stream_project_events(
        "demo",
        request,
        _user=CurrentUserInfo(id="default", sub="testuser", role="admin"),
        _t=lambda key, **kwargs: key,
    )

    snapshot_event = await anext(stream)
    await stream.aclose()

    assert snapshot_event.event == "snapshot"
    assert snapshot_event.data["fingerprint"] == "fp-0"
    assert service.unsubscribed is True


@pytest.mark.asyncio
async def test_stream_project_events_emits_snapshot_and_changes(monkeypatch):
    service = _FakeService()
    app = SimpleNamespace(state=SimpleNamespace(project_event_service=service))
    request = _FakeRequest(app)

    monkeypatch.setattr(project_events_router, "get_project_manager", lambda: _FakeProjectManager())
    subscription = await project_events_router._project_events_subscription(
        "demo",
        request,
        "default",
    )
    service_for_stream, queue, snapshot = subscription
    stream = project_events_router._project_events_generator(
        "demo",
        request,
        service_for_stream,
        queue,
        snapshot,
        "default",
    )

    snapshot_event = await anext(stream)
    changes_event = await anext(stream)
    await stream.aclose()

    assert snapshot_event.event == "snapshot"
    assert snapshot_event.data["fingerprint"] == "fp-0"

    assert changes_event.event == "changes"
    assert changes_event.data["batch_id"] == "batch-1"
    assert service.unsubscribed is True


@pytest.mark.asyncio
async def test_stream_project_events_rejects_inaccessible_project_before_sse(monkeypatch):
    service = _FakeService()
    app = SimpleNamespace(state=SimpleNamespace(project_event_service=service))
    request = _FakeRequest(app)

    monkeypatch.setattr(project_events_router, "get_project_manager", lambda: _FakeProjectManager())

    stream = project_events_router.stream_project_events(
        "demo",
        request,
        _user=CurrentUserInfo(id="other-user", sub="alice", role="user"),
        _t=lambda key, **kwargs: key,
    )

    with pytest.raises(project_events_router.HTTPException) as exc_info:
        await anext(stream)

    assert exc_info.value.status_code == 404
    assert service.queue is None
