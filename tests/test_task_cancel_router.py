"""
任务取消 API 端点测试：
  - GET  /tasks/{task_id}/cancel-preview
  - POST /tasks/{task_id}/cancel
  - GET  /projects/{project_name}/tasks/cancel-all-preview
  - POST /projects/{project_name}/tasks/cancel-all
"""

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from server.auth import CurrentUserInfo, get_current_user
from server.routers import tasks as tasks_router

# ---------------------------------------------------------------------------
# Fake queue helpers
# ---------------------------------------------------------------------------


class _FakeQueue:
    """仅实现取消相关方法的最小 Fake。"""

    def __init__(
        self,
        *,
        cancel_preview_result=None,
        cancel_preview_error: str | None = None,
        cancel_task_result=None,
        cancel_task_error: str | None = None,
        retry_task_result=None,
        retry_task_error: str | None = None,
        task=None,
        apply_retry_payload_refresh: bool = False,
        cancel_all_preview_count: int = 0,
        cancel_all_result=None,
    ):
        self._cancel_preview_result = cancel_preview_result or {}
        self._cancel_preview_error = cancel_preview_error
        self._cancel_task_result = cancel_task_result or {}
        self._cancel_task_error = cancel_task_error
        self._retry_task_result = retry_task_result or {}
        self._retry_task_error = retry_task_error
        self._task = task
        self._apply_retry_payload_refresh = apply_retry_payload_refresh
        self._cancel_all_preview_count = cancel_all_preview_count
        self._cancel_all_result = cancel_all_result or {"cancelled_count": 0, "skipped_running_count": 0}
        self.retry_payload_refresh = None
        self.refreshed_retry_payload = None

    async def get_cancel_preview(self, task_id: str, user_id: str | None = None):
        if self._cancel_preview_error:
            raise ValueError(self._cancel_preview_error)
        return self._cancel_preview_result

    async def cancel_task(self, task_id: str, user_id: str | None = None):
        if self._cancel_task_error:
            raise ValueError(self._cancel_task_error)
        return self._cancel_task_result

    async def retry_failed_task(self, task_id: str, user_id: str | None = None, payload_refresh=None):
        if self._retry_task_error:
            raise ValueError(self._retry_task_error)
        self.retry_payload_refresh = payload_refresh
        result = dict(self._retry_task_result)
        if self._apply_retry_payload_refresh and payload_refresh and isinstance(self._task, dict):
            payload = self._task.get("payload") if isinstance(self._task.get("payload"), dict) else {}
            self.refreshed_retry_payload = await payload_refresh(payload, self._task)
            result["retried_tasks"] = [
                {
                    "task_id": result.get("task_id", "new-task"),
                    "project_name": self._task.get("project_name"),
                    "task_type": self._task.get("task_type"),
                    "payload": self.refreshed_retry_payload,
                    "deduped": result.get("deduped", False),
                }
            ]
        return result

    async def get_task(self, task_id: str, user_id: str | None = None):
        return self._task

    async def get_cancel_all_preview(self, project_name: str, user_id: str | None = None) -> int:
        return self._cancel_all_preview_count

    async def cancel_all_queued(self, project_name: str, user_id: str | None = None):
        return self._cancel_all_result


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_app() -> FastAPI:
    """构建用于测试的最小 FastAPI 应用，注入假用户。"""
    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="default", sub="testuser", role="admin")
    app.include_router(tasks_router.router, prefix="/api/v1")
    return app


# ---------------------------------------------------------------------------
# Tests: cancel-preview
# ---------------------------------------------------------------------------


class TestCancelPreview:
    def test_returns_preview_for_queued_task(self, monkeypatch):
        preview = {
            "task": {"task_id": "t1", "task_type": "image", "resource_id": "scene-1"},
            "cascaded": [],
        }
        fake = _FakeQueue(cancel_preview_result=preview)
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.get("/api/v1/tasks/t1/cancel-preview")

        assert resp.status_code == 200
        body = resp.json()
        assert body["task"]["task_id"] == "t1"
        assert body["cascaded"] == []

    def test_returns_400_for_running_task(self, monkeypatch):
        fake = _FakeQueue(cancel_preview_error="只有排队中的任务可以取消")
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.get("/api/v1/tasks/t2/cancel-preview")

        assert resp.status_code == 400
        assert "只有排队中的任务可以取消" in resp.json()["detail"]

    def test_returns_400_for_nonexistent_task(self, monkeypatch):
        fake = _FakeQueue(cancel_preview_error="任务 'missing' 不存在")
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.get("/api/v1/tasks/missing/cancel-preview")

        assert resp.status_code == 400
        assert "不存在" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Tests: cancel
# ---------------------------------------------------------------------------


class TestCancelTask:
    def test_cancels_queued_task(self, monkeypatch):
        result = {
            "cancelled": [{"task_id": "t1", "status": "cancelled"}],
            "skipped_running": [],
        }
        fake = _FakeQueue(cancel_task_result=result)
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/tasks/t1/cancel")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["cancelled"]) == 1
        assert body["cancelled"][0]["task_id"] == "t1"

    def test_returns_400_for_nonexistent_task(self, monkeypatch):
        fake = _FakeQueue(cancel_task_error="任务 'ghost' 不存在")
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/tasks/ghost/cancel")

        assert resp.status_code == 400
        assert "不存在" in resp.json()["detail"]

    def test_returns_400_for_running_task(self, monkeypatch):
        fake = _FakeQueue(cancel_task_error="只有排队中的任务可以取消")
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/tasks/running-task/cancel")

        assert resp.status_code == 400
        assert "只有排队中的任务可以取消" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Tests: retry
# ---------------------------------------------------------------------------


class TestRetryTask:
    def test_retries_failed_task(self, monkeypatch):
        result = {
            "task_id": "new-task",
            "status": "queued",
            "deduped": False,
            "existing_task_id": None,
        }
        fake = _FakeQueue(retry_task_result=result)
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/tasks/failed-task/retry")

        assert resp.status_code == 200
        assert resp.json()["task_id"] == "new-task"
        assert resp.json()["status"] == "queued"

    def test_returns_400_when_task_cannot_be_retried(self, monkeypatch):
        fake = _FakeQueue(retry_task_error="只有失败的任务可以重试")
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/tasks/running-task/retry")

        assert resp.status_code == 400
        assert "失败" in resp.json()["detail"]

    def test_platform_credit_retry_checks_balance(self, monkeypatch):
        fake = _FakeQueue(
            task={
                "task_id": "failed-task",
                "project_name": "demo",
                "status": "failed",
            },
        )
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)
        monkeypatch.setattr(tasks_router, "get_project_manager", lambda: object())
        monkeypatch.setattr(
            tasks_router,
            "load_project_for_user",
            lambda *_args, **_kwargs: {"billing_mode": "platform_credits"},
        )

        async def _reject(_project, _user_id, *, required_credits=None):
            raise HTTPException(status_code=402, detail="积分余额不足")

        monkeypatch.setattr(tasks_router, "ensure_platform_credits_balance", _reject)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/tasks/failed-task/retry")

        assert resp.status_code == 402
        assert "积分余额不足" in resp.json()["detail"]

    def test_platform_credit_retry_reserves_retried_dependency_chain(self, monkeypatch):
        reserve_calls = []
        fake = _FakeQueue(
            task={
                "task_id": "failed-task",
                "project_name": "demo",
                "task_type": "storyboard",
                "payload": {"prompt": "second"},
                "status": "failed",
            },
            retry_task_result={
                "task_id": "new-second",
                "status": "queued",
                "deduped": False,
                "existing_task_id": None,
                "retried_tasks": [
                    {
                        "task_id": "new-first",
                        "project_name": "demo",
                        "task_type": "storyboard",
                        "payload": {"prompt": "first"},
                        "deduped": False,
                    },
                    {
                        "task_id": "new-second",
                        "project_name": "demo",
                        "task_type": "storyboard",
                        "payload": {"prompt": "second"},
                        "deduped": False,
                    },
                ],
            },
        )
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)
        monkeypatch.setattr(tasks_router, "get_project_manager", lambda: object())
        monkeypatch.setattr(
            tasks_router,
            "load_project_for_user",
            lambda *_args, **_kwargs: {"billing_mode": "platform_credits"},
        )

        async def _estimate(_project, _task_type, payload, **_kwargs):
            return 10 if payload.get("prompt") == "first" else 20

        async def _ensure(*_args, **_kwargs):
            return None

        async def _reserve(_project, _user_id, **kwargs):
            reserve_calls.append(kwargs)

        monkeypatch.setattr(tasks_router, "estimate_generation_task_credits", _estimate)
        monkeypatch.setattr(tasks_router, "ensure_platform_credits_balance", _ensure)
        monkeypatch.setattr(tasks_router, "reserve_platform_credits_for_task_or_cancel", _reserve)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/tasks/failed-task/retry")

        assert resp.status_code == 200
        assert [call["task_id"] for call in reserve_calls] == ["new-first", "new-second"]
        assert [call["required_credits"] for call in reserve_calls] == [10, 20]

    def test_retry_refreshes_model_rule_payload_summary(self, monkeypatch):
        fake = _FakeQueue(
            task={
                "task_id": "failed-task",
                "project_name": "demo",
                "task_type": "storyboard",
                "media_type": "image",
                "payload": {
                    "prompt": "retry me",
                    "model_rule_summary": {"mode": "default", "rule_target": "__media__/image"},
                },
                "status": "failed",
            },
            apply_retry_payload_refresh=True,
            retry_task_result={
                "task_id": "new-task",
                "status": "queued",
                "deduped": False,
                "existing_task_id": None,
            },
        )
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)
        monkeypatch.setattr(tasks_router, "get_project_manager", lambda: object())
        monkeypatch.setattr(
            tasks_router,
            "load_project_for_user",
            lambda *_args, **_kwargs: {"billing_mode": "byok", "image_backend": "openai/gpt-image-2"},
        )

        async def _estimate(*_args, **_kwargs):
            return 0

        async def _ensure(*_args, **_kwargs):
            return None

        monkeypatch.setattr(tasks_router, "estimate_generation_task_credits", _estimate)
        monkeypatch.setattr(tasks_router, "ensure_platform_credits_balance", _ensure)

        from server.routers import generate as generate_router

        async def _summarize(project, payload, *, task_type, media_type, user_id, replace_existing=False):
            assert project["image_backend"] == "openai/gpt-image-2"
            assert task_type == "storyboard"
            assert media_type == "image"
            assert user_id == "default"
            assert replace_existing is True
            assert payload["model_rule_summary"]["mode"] == "default"
            return {
                **payload,
                "model_rule_summary": {
                    "mode": "prompt",
                    "rule_target": "__media__/image",
                    "task_type": task_type,
                    "billing_mode": "byok",
                },
            }

        monkeypatch.setattr(generate_router, "_payload_with_model_rule_summary", _summarize)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/tasks/failed-task/retry")

        assert resp.status_code == 200
        assert fake.retry_payload_refresh is not None
        assert fake.refreshed_retry_payload["model_rule_summary"]["mode"] == "prompt"



# ---------------------------------------------------------------------------
# Tests: cancel-all-preview
# ---------------------------------------------------------------------------


class TestCancelAllPreview:
    def test_returns_queued_count(self, monkeypatch):
        fake = _FakeQueue(cancel_all_preview_count=5)
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.get("/api/v1/projects/my-project/tasks/cancel-all-preview")

        assert resp.status_code == 200
        assert resp.json() == {"queued_count": 5}

    def test_returns_zero_when_no_queued_tasks(self, monkeypatch):
        fake = _FakeQueue(cancel_all_preview_count=0)
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.get("/api/v1/projects/empty-project/tasks/cancel-all-preview")

        assert resp.status_code == 200
        assert resp.json() == {"queued_count": 0}


# ---------------------------------------------------------------------------
# Tests: cancel-all
# ---------------------------------------------------------------------------


class TestCancelAllQueued:
    def test_cancels_all_queued_tasks(self, monkeypatch):
        result = {
            "cancelled_count": 3,
            "skipped_running_count": 0,
        }
        fake = _FakeQueue(cancel_all_result=result)
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/projects/my-project/tasks/cancel-all")

        assert resp.status_code == 200
        body = resp.json()
        assert body["cancelled_count"] == 3
        assert body["skipped_running_count"] == 0

    def test_returns_zero_when_nothing_to_cancel(self, monkeypatch):
        result = {"cancelled_count": 0, "skipped_running_count": 0}
        fake = _FakeQueue(cancel_all_result=result)
        monkeypatch.setattr(tasks_router, "get_task_queue", lambda: fake)

        app = _make_app()
        with TestClient(app) as client:
            resp = client.post("/api/v1/projects/empty-project/tasks/cancel-all")

        assert resp.status_code == 200
        body = resp.json()
        assert body["cancelled_count"] == 0
        assert body["skipped_running_count"] == 0
