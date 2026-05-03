from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from lib.grid_manager import GridManager
from server.auth import CurrentUserInfo, get_current_user
from server.routers import generate, grids
from server.services import billing


class _FakeQueue:
    def __init__(self):
        self.calls = []
        self.cancel_calls = []

    async def enqueue_task(self, **kwargs):
        self.calls.append(kwargs)
        return {"task_id": f"task-{len(self.calls)}", "deduped": False}

    async def cancel_task(self, task_id: str, *, user_id: str | None = None):
        self.cancel_calls.append({"task_id": task_id, "user_id": user_id})
        return {"cancelled": [{"task_id": task_id}], "skipped_running": []}


class _FakePM:
    def __init__(self, project_path: Path):
        self.project_path = project_path
        self.project = {
            "billing_mode": "platform_credits",
            "aspect_ratio": "16:9",
            "style": "cinematic",
        }
        self.script = {
            "content_mode": "narration",
            "segments": [
                {
                    "segment_id": f"E1S0{i}",
                    "segment_break": False,
                    "image_prompt": f"scene {i}",
                    "video_prompt": f"action {i}",
                }
                for i in range(1, 5)
            ],
        }

    def load_project(self, project_name: str):
        return self.project

    def load_script(self, project_name: str, script_file: str):
        return self.script

    def get_project_path(self, project_name: str):
        return self.project_path


def _client(monkeypatch, fake_pm: _FakePM, fake_queue: _FakeQueue):
    monkeypatch.setattr(grids, "get_project_manager", lambda: fake_pm)
    monkeypatch.setattr(grids, "get_project_manager_for_user", lambda _user_id: fake_pm)
    monkeypatch.setattr(grids, "load_project_for_user", lambda *_args, **_kwargs: fake_pm.project)
    monkeypatch.setattr(grids, "get_generation_queue", lambda: fake_queue)
    monkeypatch.setattr(generate, "_snapshot_image_backend", lambda *_args, **_kwargs: {})

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="default", sub="testuser", role="admin")
    app.include_router(grids.router, prefix="/api/v1")
    return TestClient(app)


def test_grid_reservation_failure_cancels_task_and_marks_grid_failed(tmp_path, monkeypatch):
    project_path = tmp_path / "projects" / "demo"
    project_path.mkdir(parents=True)
    fake_pm = _FakePM(project_path)
    fake_queue = _FakeQueue()

    async def estimate(*_args, **_kwargs):
        return 67

    async def ensure(*_args, **_kwargs):
        return None

    async def fail_reserve(*_args, **_kwargs):
        raise HTTPException(status_code=402, detail="积分余额不足")

    monkeypatch.setattr(grids, "estimate_generation_task_credits", estimate)
    monkeypatch.setattr(grids, "ensure_platform_credits_balance", ensure)
    monkeypatch.setattr(billing, "reserve_platform_credits_for_task", fail_reserve)
    client = _client(monkeypatch, fake_pm, fake_queue)

    with client:
        resp = client.post(
            "/api/v1/projects/demo/generate/grid/1",
            json={"script_file": "episode_1.json"},
        )

    assert resp.status_code == 402
    assert fake_queue.cancel_calls == [{"task_id": "task-1", "user_id": "default"}]
    saved_grids = GridManager(project_path).list_all()
    assert len(saved_grids) == 1
    assert saved_grids[0].status == "failed"
    assert saved_grids[0].error_message == "积分余额不足"


def test_grid_enqueue_records_model_rule_summary(tmp_path, monkeypatch):
    project_path = tmp_path / "projects" / "demo"
    project_path.mkdir(parents=True)
    fake_pm = _FakePM(project_path)
    fake_queue = _FakeQueue()

    async def estimate(*_args, **_kwargs):
        return 12

    async def ensure(*_args, **_kwargs):
        return None

    async def reserve(*_args, **_kwargs):
        return None

    async def summarize(project, payload, *, task_type, media_type, user_id):
        assert project is fake_pm.project
        assert task_type == "grid"
        assert media_type == "image"
        assert user_id == "default"
        return {
            **payload,
            "model_rule_summary": {
                "media_type": media_type,
                "mode_label": "添加 Prompt",
                "target_label": "OpenAI · gpt-image-2",
                "task_type": task_type,
            },
        }

    monkeypatch.setattr(grids, "estimate_generation_task_credits", estimate)
    monkeypatch.setattr(grids, "ensure_platform_credits_balance", ensure)
    monkeypatch.setattr(grids, "reserve_platform_credits_for_task_or_cancel", reserve)
    monkeypatch.setattr(generate, "_payload_with_model_rule_summary", summarize)
    client = _client(monkeypatch, fake_pm, fake_queue)

    with client:
        resp = client.post(
            "/api/v1/projects/demo/generate/grid/1",
            json={"script_file": "episode_1.json"},
        )

    assert resp.status_code == 200, resp.text
    payload = fake_queue.calls[0]["payload"]
    assert payload["model_rule_summary"]["task_type"] == "grid"
    assert payload["model_rule_summary"]["media_type"] == "image"
