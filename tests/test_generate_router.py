from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from lib.model_rules import media_rule_key, normalize_model_rule_configs
from server.auth import CurrentUserInfo, get_current_user
from server.routers import generate


class _FakeQueue:
    """Mock GenerationQueue that records enqueue calls."""

    def __init__(self):
        self.calls = []

    async def enqueue_task(self, **kwargs):
        self.calls.append(kwargs)
        return {"task_id": f"task-{len(self.calls)}", "deduped": False}


class _FakePM:
    def __init__(self, project_path: Path):
        self.project_path = project_path
        self.project = {
            "style": "Anime",
            "style_description": "cinematic",
            "content_mode": "narration",
            "characters": {
                "Alice": {
                    "character_sheet": "characters/Alice.png",
                    "reference_image": "characters/refs/Alice_ref.png",
                    "description": "hero",
                }
            },
            "scenes": {
                "祠堂": {
                    "scene_sheet": "scenes/祠堂.png",
                    "description": "scene",
                }
            },
            "props": {
                "玉佩": {
                    "prop_sheet": "props/玉佩.png",
                    "description": "prop",
                }
            },
        }
        self.script = {
            "content_mode": "narration",
            "segments": [
                {
                    "segment_id": "E1S01",
                    "duration_seconds": 4,
                    "segment_break": False,
                    "characters_in_segment": [],
                    "scenes": [],
                    "props": [],
                    "generated_assets": {},
                },
                {
                    "segment_id": "E1S02",
                    "duration_seconds": 4,
                    "segment_break": False,
                    "characters_in_segment": ["Alice"],
                    "scenes": ["祠堂"],
                    "props": ["玉佩"],
                    "generated_assets": {},
                },
                {
                    "segment_id": "E1S03",
                    "duration_seconds": 4,
                    "segment_break": True,
                    "characters_in_segment": ["Alice"],
                    "scenes": ["祠堂"],
                    "props": ["玉佩"],
                    "generated_assets": {},
                },
            ],
        }

    def load_project(self, project_name):
        return self.project

    def get_project_path(self, project_name):
        return self.project_path

    def load_script(self, project_name, script_file):
        return self.script


def _prepare_files(tmp_path: Path) -> Path:
    project_path = tmp_path / "projects" / "demo"
    (project_path / "storyboards").mkdir(parents=True, exist_ok=True)
    (project_path / "characters").mkdir(parents=True, exist_ok=True)
    (project_path / "scenes").mkdir(parents=True, exist_ok=True)
    (project_path / "props").mkdir(parents=True, exist_ok=True)

    (project_path / "storyboards" / "scene_E1S01.png").write_bytes(b"png")
    (project_path / "characters" / "Alice.png").write_bytes(b"png")
    (project_path / "scenes" / "祠堂.png").write_bytes(b"png")
    (project_path / "props" / "玉佩.png").write_bytes(b"png")
    return project_path


def _client(monkeypatch, fake_pm, fake_queue):
    monkeypatch.setattr(generate, "get_project_manager", lambda: fake_pm)
    monkeypatch.setattr("lib.generation_queue.get_generation_queue", lambda: fake_queue)
    monkeypatch.setattr(generate, "get_generation_queue", lambda: fake_queue)

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="default", sub="testuser", role="admin")
    app.include_router(generate.router, prefix="/api/v1")
    return TestClient(app)


class TestGenerateRouter:
    def test_storyboard_enqueue_success(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            sb = client.post(
                "/api/v1/projects/demo/generate/storyboard/E1S02",
                json={
                    "script_file": "episode_1.json",
                    "prompt": {
                        "scene": "雨夜",
                        "composition": {"shot_type": "Medium Shot", "lighting": "暖光", "ambiance": "薄雾"},
                    },
                },
            )
            assert sb.status_code == 200
            body = sb.json()
            assert body["success"] is True
            assert body["task_id"] == "task-1"
            assert "message" in body

            # Verify enqueue was called correctly
            call = fake_queue.calls[0]
            assert call["project_name"] == "demo"
            assert call["task_type"] == "storyboard"
            assert call["media_type"] == "image"
            assert call["resource_id"] == "E1S02"
            assert call["source"] == "webui"

    def test_video_enqueue_success(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            video = client.post(
                "/api/v1/projects/demo/generate/video/E1S01",
                json={
                    "script_file": "episode_1.json",
                    "duration_seconds": 5,
                    "prompt": {
                        "action": "奔跑",
                        "camera_motion": "Static",
                        "ambiance_audio": "雨声",
                        "dialogue": [{"speaker": "Alice", "line": "快走"}],
                    },
                },
            )
            assert video.status_code == 200
            body = video.json()
            assert body["success"] is True
            assert body["task_id"] == "task-1"

            call = fake_queue.calls[0]
            assert call["task_type"] == "video"
            assert call["media_type"] == "video"
            assert call["payload"]["duration_seconds"] == 5

    def test_video_enqueue_grid_mode_uses_first_frame(self, tmp_path, monkeypatch):
        """宫格模式：storyboard 写入 _first.png 并记录于 generated_assets，路由应识别该路径。"""
        project_path = _prepare_files(tmp_path)
        # 只保留宫格模式产物，删除默认路径
        (project_path / "storyboards" / "scene_E1S01.png").unlink()
        (project_path / "storyboards" / "scene_E1S02_first.png").write_bytes(b"png")

        fake_pm = _FakePM(project_path)
        fake_pm.script["segments"][1]["generated_assets"] = {"storyboard_image": "storyboards/scene_E1S02_first.png"}
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            video = client.post(
                "/api/v1/projects/demo/generate/video/E1S02",
                json={
                    "script_file": "episode_1.json",
                    "prompt": "宫格切片后的动作",
                },
            )
            assert video.status_code == 200, video.text
            assert video.json()["success"] is True

    def test_character_enqueue_success(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            character = client.post(
                "/api/v1/projects/demo/generate/character/Alice",
                json={"prompt": "女主，冷静"},
            )
            assert character.status_code == 200
            body = character.json()
            assert body["success"] is True
            assert body["task_id"] == "task-1"

            call = fake_queue.calls[0]
            assert call["task_type"] == "character"
            assert call["media_type"] == "image"
            assert call["resource_id"] == "Alice"

    def test_enqueue_payload_records_model_rule_summary(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_queue = _FakeQueue()

        async def _snapshot(_project, _payload, *, media_type, user_id, configs=None):
            assert media_type == "image"
            assert user_id == "default"
            return {
                "media_type": "image",
                "media_label": "生成图片",
                "mode": "prompt",
                "mode_label": "添加 Prompt",
                "provider_id": "openai",
                "model_id": "gpt-image-2",
                "target_label": "OpenAI · gpt-image-2",
                "skill_name": "",
            }

        monkeypatch.setattr(generate, "_model_rule_snapshot_for_media", _snapshot)
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            character = client.post(
                "/api/v1/projects/demo/generate/character/Alice",
                json={"prompt": "女主，冷静"},
            )

        assert character.status_code == 200
        summary = fake_queue.calls[0]["payload"]["model_rule_summary"]
        assert summary["task_type"] == "character"
        assert summary["mode"] == "prompt"
        assert summary["target_label"] == "OpenAI · gpt-image-2"
        assert summary["billing_mode"] == "byok"

    def test_scene_enqueue_success(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            scene = client.post(
                "/api/v1/projects/demo/generate/scene/祠堂",
                json={"prompt": "阴森古朴"},
            )
            assert scene.status_code == 200
            body = scene.json()
            assert body["success"] is True
            assert body["task_id"] == "task-1"

            call = fake_queue.calls[0]
            assert call["task_type"] == "scene"
            assert call["media_type"] == "image"
            assert call["resource_id"] == "祠堂"

    def test_prop_enqueue_success(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            prop = client.post(
                "/api/v1/projects/demo/generate/prop/玉佩",
                json={"prompt": "古朴玉佩"},
            )
            assert prop.status_code == 200
            body = prop.json()
            assert body["success"] is True
            assert body["task_id"] == "task-1"

            call = fake_queue.calls[0]
            assert call["task_type"] == "prop"
            assert call["media_type"] == "image"
            assert call["resource_id"] == "玉佩"

    def test_platform_credits_balance_failure_returns_402(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_pm.project["billing_mode"] = "platform_credits"
        fake_queue = _FakeQueue()

        async def _reject(_project, _user_id, *, required_credits=None):
            raise HTTPException(status_code=402, detail="积分余额不足")

        monkeypatch.setattr(generate, "ensure_platform_credits_balance", _reject)
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/character/Alice",
                json={"prompt": "女主，冷静"},
            )

        assert resp.status_code == 402
        assert fake_queue.calls == []

    def test_generation_preflight_byok_explains_user_api_mode(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "character", "resource_id": "Alice", "payload": {"prompt": "hero"}},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["billing_mode"] == "byok"
        assert body["required_credits"] == 0
        assert body["can_submit"] is True
        assert body["warnings"][0]["code"] == "byok_uses_user_api"

    def test_generation_preflight_reports_image_rule_source(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_queue = _FakeQueue()

        async def _configs(_user_id):
            return normalize_model_rule_configs({
                media_rule_key("image"): {
                    "mode": "prompt",
                    "prompt": "统一图片风格规则",
                }
            })

        async def _backend(_project, _payload, *, media_type, user_id):
            assert media_type == "image"
            assert user_id == "default"
            return "openai", "gpt-image-2"

        monkeypatch.setattr(generate, "_load_preflight_model_rule_configs", _configs)
        monkeypatch.setattr(generate, "_resolve_preflight_backend", _backend)
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "character", "resource_id": "Alice", "payload": {"prompt": "hero"}},
            )

        assert resp.status_code == 200
        body = resp.json()
        rule_check = next(item for item in body["checks"] if item["code"] == "model_rule_image")
        assert rule_check["status"] == "ok"
        assert rule_check["label"] == "生成规则"
        assert "生成图片将使用「添加 Prompt」" in rule_check["message"]
        assert "OpenAI · gpt-image-2" in rule_check["message"]
        assert rule_check["action_route"] == "/app/settings?section=media&ruleTarget=__media__%2Fimage"
        assert rule_check["action_kind"] == "model_rule_summary"
        assert rule_check["action_payload"]["mode"] == "prompt"
        assert rule_check["action_payload"]["target_label"] == "OpenAI · gpt-image-2"
        assert rule_check["action_payload"]["rule_target"] == "__media__/image"
        assert rule_check["action_payload"]["billing_mode"] == "byok"

    def test_generation_preflight_reports_video_skill_rule_source(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_queue = _FakeQueue()

        async def _configs(_user_id):
            return normalize_model_rule_configs({
                media_rule_key("video"): {
                    "mode": "uploaded_skill",
                    "skill_runtime": "openclaw",
                    "skill_name": "travel-video.md",
                    "skill_content": "# Travel Video",
                }
            })

        async def _backend(_project, _payload, *, media_type, user_id):
            assert media_type == "video"
            assert user_id == "default"
            return "ark", "doubao-seedance-2-0-260128"

        monkeypatch.setattr(generate, "_load_preflight_model_rule_configs", _configs)
        monkeypatch.setattr(generate, "_resolve_preflight_backend", _backend)
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "video", "resource_id": "E1S01", "payload": {"duration_seconds": 8}},
            )

        assert resp.status_code == 200
        body = resp.json()
        rule_check = next(item for item in body["checks"] if item["code"] == "model_rule_video")
        assert "生成视频将使用「上传 Skill」" in rule_check["message"]
        assert "豆包 / 火山方舟 · doubao-seedance-2-0-260128" in rule_check["message"]
        assert "Skill：travel-video.md" in rule_check["message"]
        assert rule_check["action_route"] == "/app/settings?section=media&ruleTarget=__media__%2Fvideo"
        assert rule_check["action_payload"]["mode"] == "uploaded_skill"
        assert rule_check["action_payload"]["skill_name"] == "travel-video.md"

    def test_generation_preflight_blocks_platform_credit_shortage(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_pm.project["billing_mode"] = "platform_credits"
        fake_queue = _FakeQueue()

        async def _estimate(_project, _task_type, _payload, **_kwargs):
            return 12

        async def _balance(_user_id):
            return {
                "balance": 20,
                "available_balance": 9,
                "reserved_generation_credits": 11,
            }

        monkeypatch.setattr(generate, "estimate_generation_task_credits", _estimate)
        monkeypatch.setattr(generate, "_get_generation_preflight_credit_balance", _balance)
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "video", "resource_id": "E1S01", "payload": {"duration_seconds": 8}},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["billing_mode"] == "platform_credits"
        assert body["required_credits"] == 12
        assert body["available_balance"] == 9
        assert body["can_submit"] is False
        assert body["blocking"][0]["code"] == "insufficient_platform_credits"

    def test_generation_preflight_blocks_travel_video_without_route_source(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_pm.project["content_type"] = "travel_video"
        fake_pm.project["travel_video_settings"] = {"route_source": "google_street_view"}
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "character", "resource_id": "Alice", "payload": {"prompt": "hero"}},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["can_submit"] is False
        assert any(item["code"] == "travel_route_missing" for item in body["blocking"])
        assert any(item["code"] == "travel_route_missing" for item in body["checks"])

    def test_generation_preflight_allows_manual_travel_route_when_google_key_missing(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_pm.project["content_type"] = "travel_video"
        fake_pm.project["travel_video_settings"] = {
            "origin": "大阪难波站",
            "destination": "黑门市场",
            "route_source": "google_street_view",
        }
        fake_queue = _FakeQueue()

        async def _google_missing(_user_id):
            return False

        monkeypatch.setattr(generate, "_is_google_maps_configured", _google_missing)
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "character", "resource_id": "Alice", "payload": {"prompt": "hero"}},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["can_submit"] is True
        assert any(item["code"] == "google_maps_optional_missing" for item in body["warnings"])
        assert any(item["code"] == "travel_route_preview_missing" for item in body["checks"])

    def test_generation_preflight_reports_ready_travel_route_preview(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_pm.project["content_type"] = "travel_video"
        fake_pm.project["travel_video_settings"] = {
            "origin": "大阪难波站",
            "destination": "黑门市场",
            "route_source": "manual",
            "route_preview": {
                "route_ready": True,
                "summary": "大阪难波站 -> 黑门市场",
                "distance_text": "1.2 km",
                "duration_text": "15 mins",
                "warnings": [],
            },
        }
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "video", "resource_id": "E1S01", "payload": {"duration_seconds": 8}},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["can_submit"] is True
        route_check = next(item for item in body["checks"] if item["code"] == "travel_route_preview_ready")
        assert route_check["status"] == "ok"
        assert "大阪难波站 -> 黑门市场" in route_check["message"]
        assert "1.2 km" in route_check["message"]

    def test_generation_preflight_blocks_failed_travel_route_preview(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_pm.project["content_type"] = "travel_video"
        fake_pm.project["travel_video_settings"] = {
            "origin": "大阪难波站",
            "destination": "黑门市场",
            "route_source": "manual",
            "route_preview": {
                "route_ready": False,
                "warnings": [{"code": "route_incomplete", "message": "路线节点不足，请补充路线说明。"}],
            },
        }
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "video", "resource_id": "E1S01", "payload": {"duration_seconds": 8}},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["can_submit"] is False
        assert any(item["code"] == "travel_route_preview_not_ready" for item in body["blocking"])
        route_check = next(item for item in body["checks"] if item["code"] == "travel_route_preview_not_ready")
        assert route_check["status"] == "blocking"
        assert route_check["message"] == "路线节点不足，请补充路线说明。"

    def test_generation_preflight_allows_travel_reference_images_without_text_route(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_pm.project["content_type"] = "travel_video"
        fake_pm.project["travel_video_settings"] = {
            "route_source": "reference_images",
            "reference_images": ["travel_references/osaka-map.png"],
        }
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "character", "resource_id": "Alice", "payload": {"prompt": "hero"}},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["can_submit"] is True
        assert not any(item["code"] == "travel_route_missing" for item in body["blocking"])

    def test_generation_preflight_warns_when_travel_reference_images_not_applied_to_scenes(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_pm.project["content_type"] = "travel_video"
        fake_pm.project["travel_video_settings"] = {
            "route_source": "reference_images",
            "reference_images": [
                "travel_references/osaka-map.png",
                "travel_references/street.png",
            ],
            "route_preview": {
                "route_ready": True,
                "summary": "大阪难波站 -> 黑门市场",
                "warnings": [],
            },
        }
        fake_pm.project["scenes"]["大阪地图"] = {
            "description": "参考图场景",
            "scene_sheet": "scenes/osaka-map.png",
            "asset_source": {
                "kind": "asset_library",
                "asset_type": "scene",
                "source_kind": "travel_reference",
                "source_file": "travel_references/osaka-map.png",
            },
        }
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "video", "resource_id": "E1S01", "payload": {"duration_seconds": 8}},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["can_submit"] is True
        warning = next(item for item in body["warnings"] if item["code"] == "travel_reference_scene_assets_incomplete")
        assert "1/2" in warning["message"]
        assert "travel_references/street.png" in warning["message"]
        check = next(item for item in body["checks"] if item["code"] == "travel_reference_scene_assets_incomplete")
        assert check["status"] == "warning"
        assert check["action_label"] == "一键应用场景素材"
        assert check["action_route"] == "/app/projects/demo?openTravelRouteAssets=1"
        assert check["action_kind"] == "apply_travel_scene_assets"
        assert check["action_payload"]["missing_reference_images"] == ["travel_references/street.png"]
        assert check["action_payload"]["applied_reference_images"] == ["travel_references/osaka-map.png"]
        assert check["action_payload"]["total_reference_images"] == 2

    def test_generation_preflight_reports_travel_reference_images_applied_to_scene_assets(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_pm.project["content_type"] = "travel_video"
        fake_pm.project["travel_video_settings"] = {
            "route_source": "reference_images",
            "reference_images": ["travel_references/osaka-map.png"],
            "route_preview": {
                "route_ready": True,
                "summary": "大阪难波站 -> 黑门市场",
                "warnings": [],
            },
        }
        fake_pm.project["scenes"]["大阪地图"] = {
            "description": "参考图场景",
            "scene_sheet": "scenes/osaka-map.png",
            "asset_source": {
                "kind": "asset_library",
                "asset_type": "scene",
                "source_kind": "travel_reference",
                "source_file": "travel_references/osaka-map.png",
            },
        }
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            resp = client.post(
                "/api/v1/projects/demo/generate/preflight",
                json={"task_type": "video", "resource_id": "E1S01", "payload": {"duration_seconds": 8}},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["can_submit"] is True
        assert not any(item["code"] == "travel_reference_scene_assets_incomplete" for item in body["warnings"])
        check = next(item for item in body["checks"] if item["code"] == "travel_reference_scene_assets_ready")
        assert check["status"] == "ok"
        assert "1/1" in check["message"]
        assert "大阪地图" in check["message"]

    def test_error_paths(self, tmp_path, monkeypatch):
        project_path = _prepare_files(tmp_path)
        fake_pm = _FakePM(project_path)
        fake_queue = _FakeQueue()
        client = _client(monkeypatch, fake_pm, fake_queue)

        with client:
            # Bad storyboard prompt (structured but missing scene)
            bad_prompt = client.post(
                "/api/v1/projects/demo/generate/storyboard/E1S02",
                json={"script_file": "episode_1.json", "prompt": {"composition": {}}},
            )
            assert bad_prompt.status_code == 400

            # Nonexistent segment
            not_found = client.post(
                "/api/v1/projects/demo/generate/storyboard/MISSING",
                json={"script_file": "episode_1.json", "prompt": "test"},
            )
            assert not_found.status_code == 404

            # Video without storyboard
            (project_path / "storyboards" / "scene_E1S01.png").unlink()
            no_storyboard = client.post(
                "/api/v1/projects/demo/generate/video/E1S01",
                json={"script_file": "episode_1.json", "prompt": "text"},
            )
            assert no_storyboard.status_code == 400

            # Bad video prompt
            bad_video_prompt = client.post(
                "/api/v1/projects/demo/generate/video/E1S01",
                json={"script_file": "episode_1.json", "prompt": {"action": ""}},
            )
            assert bad_video_prompt.status_code in (400, 500)

            # Empty string prompt for storyboard route (segment exists, prompt is empty str)
            empty_storyboard_prompt = client.post(
                "/api/v1/projects/demo/generate/storyboard/E1S02",
                json={"script_file": "episode_1.json", "prompt": ""},
            )
            assert empty_storyboard_prompt.status_code == 400

            # Whitespace-only string prompt for video route — ensure storyboard exists first
            # so we hit the prompt check, not the missing-storyboard check
            (project_path / "storyboards" / "scene_E1S02.png").write_bytes(b"png")
            empty_video_prompt = client.post(
                "/api/v1/projects/demo/generate/video/E1S02",
                json={"script_file": "episode_1.json", "prompt": "   "},
            )
            assert empty_video_prompt.status_code == 400

            # Missing character
            fake_pm.project["characters"] = {}
            missing_char = client.post(
                "/api/v1/projects/demo/generate/character/Alice",
                json={"prompt": "x"},
            )
            assert missing_char.status_code == 404

            # Missing scene
            fake_pm.project["scenes"] = {}
            missing_scene = client.post(
                "/api/v1/projects/demo/generate/scene/祠堂",
                json={"prompt": "x"},
            )
            assert missing_scene.status_code == 404

            # Missing prop
            fake_pm.project["props"] = {}
            missing_prop = client.post(
                "/api/v1/projects/demo/generate/prop/玉佩",
                json={"prompt": "x"},
            )
            assert missing_prop.status_code == 404
