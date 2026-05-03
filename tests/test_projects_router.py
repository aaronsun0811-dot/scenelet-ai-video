import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from lib.db import get_async_session
from server.auth import CurrentUserInfo, get_current_user
from server.dependencies import get_config_service
from server.routers import projects


class _FakePM:
    def __init__(self, base: Path):
        self.base = base
        self.project_data = {
            "ready": {
                "title": "Ready",
                "style": "Anime",
                "episodes": [{"episode": 1, "script_file": "scripts/episode_1.json"}],
                "overview": {"synopsis": "old"},
                "characters": {},
            },
            "broken": {
                "title": "Broken",
                "style": "",
                "episodes": [],
            },
            "other": {
                "title": "Other",
                "style": "",
                "owner_user_id": "user-b",
                "episodes": [],
            },
            "remove-me": {
                "title": "Remove Me",
                "style": "",
                "episodes": [],
            },
            "bad": {
                "title": "Bad",
                "style": "",
                "episodes": [],
            },
        }
        self.scripts = {
            ("ready", "episode_1.json"): {
                "content_mode": "drama",
                "scenes": [{"scene_id": "001", "duration_seconds": 8}],
            },
            ("ready", "narration.json"): {
                "content_mode": "narration",
                "segments": [{"segment_id": "E1S01", "duration_seconds": 4}],
            },
        }
        self.created = set()
        self.synced_scripts = []
        self.generated_names = ["project-aa11bb22", "project-cc33dd44"]
        (self.base / "ready" / "storyboards").mkdir(parents=True, exist_ok=True)
        (self.base / "ready" / "storyboards" / "scene_E1S01.png").write_bytes(b"png")
        (self.base / "other").mkdir(parents=True, exist_ok=True)
        (self.base / "bad").mkdir(parents=True, exist_ok=True)
        (self.base / "empty").mkdir(parents=True, exist_ok=True)
        (self.base / "remove-me").mkdir(parents=True, exist_ok=True)

    def list_projects(self):
        return ["ready", "empty", "broken", "other"]

    def project_exists(self, name):
        return name in {"ready", "broken", "other", "remove-me", "bad"}

    def load_project(self, name):
        if name == "broken":
            raise RuntimeError("broken")
        if name not in self.project_data:
            raise FileNotFoundError(name)
        return self.project_data[name]

    def get_project_path(self, name):
        path = self.base / name
        if not path.exists():
            raise FileNotFoundError(name)
        return path

    def get_project_status(self, name):
        return {"current_stage": "source_ready"}

    def create_project(self, name):
        if not name or not re.fullmatch(r"[A-Za-z0-9-]+", name):
            raise ValueError("项目标识仅允许英文字母、数字和中划线")
        if name == "exists":
            raise FileExistsError(name)
        self.created.add(name)
        (self.base / name).mkdir(parents=True, exist_ok=True)

    def generate_project_name(self, title):
        return self.generated_names.pop(0)

    def create_project_metadata(
        self,
        name,
        title,
        style,
        content_mode,
        aspect_ratio="9:16",
        default_duration=None,
        style_template_id=None,
        extras=None,
    ):
        payload = {
            "title": (title or name),
            "style": style or "",
            "content_mode": content_mode,
            "aspect_ratio": aspect_ratio,
            "episodes": [],
        }
        if default_duration is not None:
            payload["default_duration"] = default_duration
        if style_template_id is not None:
            payload["style_template_id"] = style_template_id
        if extras:
            payload.update(extras)
        self.project_data[name] = payload
        return payload

    def save_project(self, name, payload):
        self.project_data[name] = payload

    def load_script(self, name, script_file):
        if script_file.startswith("scripts/"):
            script_file = script_file[len("scripts/") :]
        key = (name, script_file)
        if key not in self.scripts:
            raise FileNotFoundError(script_file)
        return self.scripts[key]

    def save_script(self, name, payload, script_file):
        self.scripts[(name, script_file)] = payload

    def sync_episode_from_script(self, name, script_filename):
        self.synced_scripts.append((name, script_filename))
        script = self.load_script(name, script_filename)
        project = self.project_data[name]
        episodes = project.setdefault("episodes", [])
        episode_no = script.get("episode", 1)
        existing = next((ep for ep in episodes if ep.get("episode") == episode_no), None)
        if existing is None:
            episodes.append({
                "episode": episode_no,
                "title": script.get("title", f"第 {episode_no} 集"),
                "script_file": f"scripts/{script_filename}",
            })
        else:
            existing["title"] = script.get("title", existing.get("title", f"第 {episode_no} 集"))
            existing["script_file"] = f"scripts/{script_filename}"
        return script

    async def generate_overview(self, name, *, user_id="default"):
        if name == "ready":
            return {"synopsis": "generated"}
        raise ValueError("source missing")

    async def generate_characters(self, name, *, user_id="default"):
        if name == "ready":
            characters = self.project_data[name].setdefault("characters", {})
            characters["Hero"] = {"description": "hero", "voice_style": "calm", "character_sheet": ""}
            return {"characters": characters, "source": "source", "added": 1, "updated": 0, "skipped": 0}
        raise ValueError("source missing")

    async def generate_scenes(self, name, *, user_id="default"):
        if name == "ready":
            scenes = self.project_data[name].setdefault("scenes", {})
            scenes["Office"] = {"description": "office", "scene_sheet": ""}
            return {"scenes": scenes, "source": "source", "added": 1, "updated": 0, "skipped": 0}
        raise ValueError("source missing")

    async def generate_props(self, name, *, user_id="default"):
        if name == "ready":
            props = self.project_data[name].setdefault("props", {})
            props["Contract"] = {"description": "contract", "prop_sheet": ""}
            return {"props": props, "source": "source", "added": 1, "updated": 0, "skipped": 0}
        raise ValueError("source missing")

    async def generate_episode_draft(self, name, episode=1, *, user_id="default"):
        if name == "ready":
            episodes = self.project_data[name].setdefault("episodes", [])
            if not any(ep.get("episode") == episode for ep in episodes):
                episodes.append({"episode": episode, "title": f"第 {episode} 集", "script_file": f"scripts/episode_{episode}.json"})
            return {
                "episode": episode,
                "title": f"第 {episode} 集",
                "script_file": f"scripts/episode_{episode}.json",
                "draft_path": f"drafts/episode_{episode}/step1_segments.md",
                "content": "# draft",
                "source": "source",
            }
        raise ValueError("source missing")


class _FakeCalc:
    def __init__(self):
        # 记录 list_projects 是否把一次性加载的 script map 传到 calculate_project_status，
        # 让针对 Task 4 的集成测试能断言两路共享预加载。
        self.last_preloaded_scripts: dict | None = None

    def calculate_project_status(self, name, project, *, preloaded_scripts=None):
        self.last_preloaded_scripts = preloaded_scripts
        return {
            "current_phase": "production",
            "phase_progress": 0.5,
            "characters": {"total": 1, "completed": 0},
            "clues": {"total": 1, "completed": 0},
            "episodes_summary": {"total": 1, "scripted": 1, "in_production": 1, "completed": 0},
        }

    def enrich_project(self, name, project):
        project = dict(project)
        project["status"] = self.calculate_project_status(name, project)
        return project

    def enrich_script(self, script):
        script = dict(script)
        script["metadata"] = {"total_scenes": 1, "estimated_duration_seconds": 8}
        return script


def _client(monkeypatch, fake_pm, fake_calc, *, user_id: str = "default", google_maps_api_key: str = ""):
    monkeypatch.setattr(projects, "get_project_manager", lambda: fake_pm)
    monkeypatch.setattr(projects, "get_status_calculator", lambda: fake_calc)

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id=user_id, sub=user_id, role="admin")
    app.dependency_overrides[get_async_session] = lambda: None

    class _FakeConfigService:
        async def get_setting(self, key, default=""):
            if key == "google_maps_api_key":
                return google_maps_api_key
            return default

    app.dependency_overrides[get_config_service] = lambda: _FakeConfigService()
    app.include_router(projects.router, prefix="/api/v1")
    return TestClient(app)


class TestProjectsRouter:
    def test_list_and_create_and_delete(self, tmp_path, monkeypatch):
        client = _client(monkeypatch, _FakePM(tmp_path), _FakeCalc())
        with client:
            listed = client.get("/api/v1/projects")
            assert listed.status_code == 200
            names = [p["name"] for p in listed.json()["projects"]]
            assert names == ["ready", "empty", "broken"]
            broken = [p for p in listed.json()["projects"] if p["name"] == "broken"][0]
            assert broken["status"] == {}
            assert "error" in broken

            create_ok = client.post(
                "/api/v1/projects",
                json={"title": "New", "style": "Real", "content_mode": "narration"},
            )
            assert create_ok.status_code == 200
            assert create_ok.json()["name"] == "project-aa11bb22"
            assert create_ok.json()["project"]["title"] == "New"

            create_manual_name = client.post(
                "/api/v1/projects",
                json={"name": "manual-project", "style": "Anime", "content_mode": "narration"},
            )
            assert create_manual_name.status_code == 200
            assert create_manual_name.json()["name"] == "manual-project"
            assert create_manual_name.json()["project"]["title"] == "manual-project"

            create_exists = client.post(
                "/api/v1/projects",
                json={"name": "exists", "title": "Dup", "style": "", "content_mode": "narration"},
            )
            assert create_exists.status_code == 400

            create_invalid = client.post(
                "/api/v1/projects",
                json={"name": "bad_name", "title": "Bad", "style": "", "content_mode": "narration"},
            )
            assert create_invalid.status_code == 400

            create_missing_title = client.post(
                "/api/v1/projects",
                json={"style": "", "content_mode": "narration"},
            )
            assert create_missing_title.status_code == 400

            delete_ok = client.delete("/api/v1/projects/remove-me")
            assert delete_ok.status_code == 200

    def test_project_list_and_detail_are_user_scoped(self, tmp_path, monkeypatch):
        client = _client(monkeypatch, _FakePM(tmp_path), _FakeCalc(), user_id="user-b")

        with client:
            listed = client.get("/api/v1/projects")
            assert listed.status_code == 200
            assert [p["name"] for p in listed.json()["projects"]] == ["other"]

            own_detail = client.get("/api/v1/projects/other")
            assert own_detail.status_code == 200
            assert own_detail.json()["project"]["title"] == "Other"

            other_detail = client.get("/api/v1/projects/ready")
            assert other_detail.status_code == 404

    def test_project_member_management_grants_shared_access(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        owner_client = _client(monkeypatch, fake_pm, _FakeCalc())

        async def _resolve_member(req, _session):
            return "user-c", "carol"

        monkeypatch.setattr(projects, "_resolve_member_identity", _resolve_member)

        with owner_client:
            members = owner_client.get("/api/v1/projects/ready/members")
            assert members.status_code == 200
            assert members.json()["owner_user_id"] == "default"
            assert members.json()["members"] == []

            grant = owner_client.put(
                "/api/v1/projects/ready/members/user-c",
                json={"user_id": "user-c", "role": "editor"},
            )
            assert grant.status_code == 200
            assert grant.json()["members"][0]["user_id"] == "user-c"
            assert grant.json()["members"][0]["role"] == "editor"

            grant_by_username = owner_client.post(
                "/api/v1/projects/ready/members",
                json={"identifier": "carol", "role": "editor"},
            )
            assert grant_by_username.status_code == 200
            assert grant_by_username.json()["members"][0]["username"] == "carol"

            member_client = _client(monkeypatch, fake_pm, _FakeCalc(), user_id="user-c")
            with member_client:
                listed = member_client.get("/api/v1/projects")
                assert listed.status_code == 200
                assert [p["name"] for p in listed.json()["projects"]] == ["ready"]
                assert listed.json()["projects"][0]["owner_user_id"] == "default"
                assert listed.json()["projects"][0]["current_user_role"] == "editor"

                detail = member_client.get("/api/v1/projects/ready")
                assert detail.status_code == 200
                assert detail.json()["project"]["title"] == "Ready"

                delete_by_member = member_client.delete("/api/v1/projects/ready")
                assert delete_by_member.status_code == 403

                revoke_by_member = member_client.delete("/api/v1/projects/ready/members/user-c")
                assert revoke_by_member.status_code == 403

            revoke = owner_client.delete("/api/v1/projects/ready/members/user-c")
            assert revoke.status_code == 200
            assert revoke.json()["members"] == []

    def test_project_details_and_updates(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            detail = client.get("/api/v1/projects/ready")
            assert detail.status_code == 200
            assert "status" in detail.json()["project"]
            assert "episode_1.json" in detail.json()["scripts"]

            missing = client.get("/api/v1/projects/missing")
            assert missing.status_code == 404

            update = client.patch(
                "/api/v1/projects/ready",
                json={"title": "Updated", "style": "Noir"},
            )
            assert update.status_code == 200
            assert update.json()["project"]["title"] == "Updated"

            rejected_mode = client.patch(
                "/api/v1/projects/ready",
                json={"content_mode": "drama"},
            )
            assert rejected_mode.status_code == 400

            # aspect_ratio 现在允许修改（字符串），dict 类型将被 Pydantic 拒绝（422）
            rejected_ratio_dict = client.patch(
                "/api/v1/projects/ready",
                json={"aspect_ratio": {"videos": "16:9"}},
            )
            assert rejected_ratio_dict.status_code == 422

            # aspect_ratio 字符串更新应成功
            updated_ratio = client.patch(
                "/api/v1/projects/ready",
                json={"aspect_ratio": "16:9"},
            )
            assert updated_ratio.status_code == 200
            assert updated_ratio.json()["project"]["aspect_ratio"] == "16:9"

            invalid_generation_mode = client.patch(
                "/api/v1/projects/ready",
                json={"generation_mode": "surprise-me"},
            )
            assert invalid_generation_mode.status_code == 400
            assert fake_pm.project_data["ready"].get("generation_mode") != "surprise-me"

            legacy_generation_mode = client.patch(
                "/api/v1/projects/ready",
                json={"generation_mode": "single"},
            )
            assert legacy_generation_mode.status_code == 200
            assert legacy_generation_mode.json()["project"]["generation_mode"] == "storyboard"

            updated_duration = client.patch(
                "/api/v1/projects/ready",
                json={"default_duration": 8},
            )
            assert updated_duration.status_code == 200
            assert updated_duration.json()["project"]["default_duration"] == 8
            assert updated_duration.json()["project"]["default_duration_explicit"] is True

            cleared_duration = client.patch(
                "/api/v1/projects/ready",
                json={"default_duration": None},
            )
            assert cleared_duration.status_code == 200
            assert "default_duration" not in cleared_duration.json()["project"]
            assert "default_duration_explicit" not in cleared_duration.json()["project"]

            updated_character_style = client.patch(
                "/api/v1/projects/ready",
                json={"character_style_prompt": "真人短剧质感，五官清晰自然"},
            )
            assert updated_character_style.status_code == 200
            assert (
                updated_character_style.json()["project"]["character_style_prompt"]
                == "真人短剧质感，五官清晰自然"
            )

            cleared_character_style = client.patch(
                "/api/v1/projects/ready",
                json={"character_style_prompt": None},
            )
            assert cleared_character_style.status_code == 200
            assert "character_style_prompt" not in cleared_character_style.json()["project"]

            get_script = client.get("/api/v1/projects/ready/scripts/episode_1.json")
            assert get_script.status_code == 200

            get_script_missing = client.get("/api/v1/projects/ready/scripts/missing.json")
            assert get_script_missing.status_code == 404

    def test_scene_segment_and_overview_endpoints(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        fake_pm.scripts[("ready", "episode_1.json")] = {
            "content_mode": "drama",
            "scenes": [{"scene_id": "001", "duration_seconds": 8, "image_prompt": {}, "video_prompt": {}}],
        }
        fake_pm.scripts[("ready", "narration.json")] = {
            "content_mode": "narration",
            "segments": [{"segment_id": "E1S01", "duration_seconds": 4}],
        }

        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            patch_scene = client.patch(
                "/api/v1/projects/ready/scenes/001",
                json={"script_file": "episode_1.json", "updates": {"duration_seconds": 6, "segment_break": True}},
            )
            assert patch_scene.status_code == 200
            assert patch_scene.json()["scene"]["duration_seconds"] == 6

            patch_scene_missing = client.patch(
                "/api/v1/projects/ready/scenes/404",
                json={"script_file": "episode_1.json", "updates": {}},
            )
            assert patch_scene_missing.status_code == 404

            patch_segment = client.patch(
                "/api/v1/projects/ready/segments/E1S01",
                json={"script_file": "narration.json", "duration_seconds": 8, "segment_break": True},
            )
            assert patch_segment.status_code == 200

            not_narration = client.patch(
                "/api/v1/projects/ready/segments/001",
                json={"script_file": "episode_1.json", "duration_seconds": 8},
            )
            assert not_narration.status_code == 400

            segment_missing = client.patch(
                "/api/v1/projects/ready/segments/E9S99",
                json={"script_file": "narration.json", "duration_seconds": 8},
            )
            assert segment_missing.status_code == 404

            gen_overview_ok = client.post("/api/v1/projects/ready/generate-overview")
            assert gen_overview_ok.status_code == 200

            gen_characters_ok = client.post("/api/v1/projects/ready/generate-characters")
            assert gen_characters_ok.status_code == 200
            assert gen_characters_ok.json()["added"] == 1
            assert "Hero" in gen_characters_ok.json()["characters"]

            gen_scenes_ok = client.post("/api/v1/projects/ready/generate-scenes")
            assert gen_scenes_ok.status_code == 200
            assert gen_scenes_ok.json()["added"] == 1
            assert "Office" in gen_scenes_ok.json()["scenes"]

            gen_props_ok = client.post("/api/v1/projects/ready/generate-props")
            assert gen_props_ok.status_code == 200
            assert gen_props_ok.json()["added"] == 1
            assert "Contract" in gen_props_ok.json()["props"]

            gen_draft_ok = client.post("/api/v1/projects/ready/generate-episode-draft", json={"episode": 1})
            assert gen_draft_ok.status_code == 200
            assert gen_draft_ok.json()["draft_path"].startswith("drafts/episode_1/")

    def test_generate_episode_script_from_draft(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)

        class _FakeScriptGenerator:
            @classmethod
            async def create(cls, project_path, *, user_id="default"):
                assert project_path == tmp_path / "ready"
                assert user_id == "default"
                return cls()

            async def generate(self, episode):
                assert episode == 1
                return tmp_path / "ready" / "scripts" / "episode_1.json"

        monkeypatch.setattr(projects, "ScriptGenerator", _FakeScriptGenerator)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post("/api/v1/projects/ready/generate-episode-script", json={"episode": 1})

        assert resp.status_code == 200
        assert resp.json()["script_file"] == "scripts/episode_1.json"
        assert resp.json()["script"]["scenes"][0]["scene_id"] == "001"
        assert fake_pm.synced_scripts == [("ready", "episode_1.json")]

    def test_generate_episode_script_requires_step1_draft(self, tmp_path, monkeypatch):
        class _FailingScriptGenerator:
            @classmethod
            async def create(cls, project_path, *, user_id="default"):
                return cls()

            async def generate(self, episode):
                raise FileNotFoundError("未找到 Step 1 文件")

        monkeypatch.setattr(projects, "ScriptGenerator", _FailingScriptGenerator)
        client = _client(monkeypatch, _FakePM(tmp_path), _FakeCalc())

        with client:
            resp = client.post("/api/v1/projects/ready/generate-episode-script", json={"episode": 1})

        assert resp.status_code == 400
        assert "Step 1" in resp.json()["detail"]

    def test_update_segment_writes_character_and_clue_refs(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        fake_pm.scripts[("ready", "narration.json")] = {
            "content_mode": "narration",
            "segments": [
                {
                    "segment_id": "E1S01",
                    "duration_seconds": 4,
                    "characters_in_segment": ["Alice"],
                    "scenes": ["Forest"],
                    "props": ["Sword"],
                }
            ],
        }

        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            # 写入新引用列表
            patched = client.patch(
                "/api/v1/projects/ready/segments/E1S01",
                json={
                    "script_file": "narration.json",
                    "characters_in_segment": ["Bob", "Carol"],
                    "scenes": ["Castle"],
                    "props": [],
                },
            )
            assert patched.status_code == 200
            seg = patched.json()["segment"]
            assert seg["characters_in_segment"] == ["Bob", "Carol"]
            assert seg["scenes"] == ["Castle"]
            assert seg["props"] == []

            # 不传字段时不应改动现有值
            untouched = client.patch(
                "/api/v1/projects/ready/segments/E1S01",
                json={"script_file": "narration.json", "duration_seconds": 7},
            )
            assert untouched.status_code == 200
            seg2 = untouched.json()["segment"]
            assert seg2["duration_seconds"] == 7
            assert seg2["characters_in_segment"] == ["Bob", "Carol"]
            assert seg2["scenes"] == ["Castle"]
            assert seg2["props"] == []

    def test_update_scene_supports_character_and_clue_refs(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        fake_pm.scripts[("ready", "episode_1.json")] = {
            "content_mode": "drama",
            "scenes": [
                {
                    "scene_id": "001",
                    "duration_seconds": 8,
                    "characters_in_scene": ["Alice"],
                    "scenes": [],
                    "props": [],
                }
            ],
        }

        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            patched = client.patch(
                "/api/v1/projects/ready/scenes/001",
                json={
                    "script_file": "episode_1.json",
                    "updates": {
                        "characters_in_scene": ["Bob"],
                        "scenes": ["Castle"],
                        "props": ["Map"],
                    },
                },
            )
            assert patched.status_code == 200
            scene = patched.json()["scene"]
            assert scene["characters_in_scene"] == ["Bob"]
            assert scene["scenes"] == ["Castle"]
            assert scene["props"] == ["Map"]

            gen_overview_bad = client.post("/api/v1/projects/bad/generate-overview")
            assert gen_overview_bad.status_code == 400

            gen_characters_bad = client.post("/api/v1/projects/bad/generate-characters")
            assert gen_characters_bad.status_code == 400

            gen_scenes_bad = client.post("/api/v1/projects/bad/generate-scenes")
            assert gen_scenes_bad.status_code == 400

            gen_props_bad = client.post("/api/v1/projects/bad/generate-props")
            assert gen_props_bad.status_code == 400

            gen_draft_bad = client.post("/api/v1/projects/bad/generate-episode-draft", json={"episode": 1})
            assert gen_draft_bad.status_code == 400

            update_overview = client.patch(
                "/api/v1/projects/ready/overview",
                json={"synopsis": "new synopsis", "genre": "悬疑", "theme": "真相", "world_setting": "古代"},
            )
            assert update_overview.status_code == 200
            assert update_overview.json()["overview"]["synopsis"] == "new synopsis"

    def test_get_project_includes_asset_fingerprints(self, tmp_path, monkeypatch):
        """项目 API 应返回 asset_fingerprints 字段"""
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.get("/api/v1/projects/ready")
            assert resp.status_code == 200
            data = resp.json()
            assert "asset_fingerprints" in data
            assert "storyboards/scene_E1S01.png" in data["asset_fingerprints"]
            assert isinstance(data["asset_fingerprints"]["storyboards/scene_E1S01.png"], int)

    def test_create_project_with_style_template_id_expands_prompt(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "模版项目",
                    "name": "tpl-1",
                    "style_template_id": "live_premium_drama",
                    "content_mode": "drama",
                    "aspect_ratio": "9:16",
                },
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["tpl-1"]
            assert data["style_template_id"] == "live_premium_drama"
            assert "真人电视剧" in data["style"] or "精品短剧" in data["style"]

    def test_create_project_with_content_style_template_id_expands_prompt(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "情景剧项目",
                    "name": "content-tpl-1",
                    "style_template_id": "content_scene_sketch",
                    "content_type": "scene_sketch",
                },
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["content-tpl-1"]
            assert data["style_template_id"] == "content_scene_sketch"
            assert "情景剧" in data["style"]
            assert data["content_type"] == "scene_sketch"
            assert data["content_mode"] == "drama"
            assert data["aspect_ratio"] == "16:9"
            assert data["generation_mode"] == "storyboard"

    def test_create_project_with_content_type_applies_workflow_defaults(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "广告项目",
                    "name": "ad-workflow-1",
                    "content_type": "ad_story",
                },
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["ad-workflow-1"]
            assert data["content_type"] == "ad_story"
            assert data["content_mode"] == "drama"
            assert data["aspect_ratio"] == "9:16"
            assert data["generation_mode"] == "reference_video"
            assert data["default_duration"] == 8
            assert data["default_duration_explicit"] is True
            assert data["style_template_id"] == "content_ad_story"
            assert "广告剧情" in data["style"]

    def test_create_travel_video_project_persists_route_settings_and_portrait_override(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "大阪路线",
                    "name": "travel-workflow-1",
                    "content_type": "travel_video",
                    "aspect_ratio": "9:16",
                    "travel_video_settings": {
                        "origin": " 难波站 ",
                        "destination": "黑门市场",
                        "route_source": "manual",
                        "route_notes": "沿千日前通前进",
                        "narration_language": "zh",
                        "target_duration": "custom",
                        "custom_duration_seconds": 240,
                        "camera_style": "street_walk_turns",
                        "narrator_persona": "enthusiastic_guide",
                    },
                },
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["travel-workflow-1"]
            assert data["content_type"] == "travel_video"
            assert data["content_mode"] == "narration"
            assert data["aspect_ratio"] == "9:16"
            assert data["generation_mode"] == "reference_video"
            assert data["default_duration"] == 8
            assert data["style_template_id"] == "content_travel_video"
            assert data["travel_video_settings"]["origin"] == "难波站"
            assert data["travel_video_settings"]["route_source"] == "manual"
            assert data["travel_video_settings"]["target_duration"] == "custom"
            assert data["travel_video_settings"]["custom_duration_seconds"] == 240
            assert data["travel_video_settings"]["narration_language"] == "zh"

    def test_create_travel_video_project_applies_route_defaults(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "默认路线",
                    "name": "travel-defaults",
                    "content_type": "travel_video",
                },
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["travel-defaults"]
            assert data["aspect_ratio"] == "16:9"
            assert data["generation_mode"] == "reference_video"
            assert data["travel_video_settings"] == {
                "route_source": "google_street_view",
                "narration_language": "auto",
                "target_duration": "45s",
                "camera_style": "street_walk_turns",
                "narrator_persona": "enthusiastic_guide",
            }

    def test_preview_travel_route_persists_manual_fallback_when_google_key_missing(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        fake_pm.project_data["ready"]["content_type"] = "travel_video"
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects/ready/travel-route/preview",
                json={
                    "travel_video_settings": {
                        "origin": "大阪难波站",
                        "destination": "黑门市场",
                        "route_source": "google_street_view",
                        "route_notes": "沿千日前通前进，看到商店街后右转。",
                    }
                },
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["source"] == "manual"
        assert body["google_configured"] is False
        assert body["route_ready"] is True
        assert body["warnings"][0]["code"] == "google_maps_optional_missing"
        saved = fake_pm.project_data["ready"]["travel_video_settings"]
        assert saved["route_preview"]["source"] == "manual"
        assert saved["route_preview"]["nodes"][0]["label"] == "出发地"

    def test_get_travel_route_street_view_image_proxies_persisted_google_node(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        fake_pm.project_data["ready"]["content_type"] = "travel_video"
        fake_pm.project_data["ready"]["travel_video_settings"] = {
            "route_preview": {
                "nodes": [
                    {
                        "id": "google-step-1",
                        "source": "google",
                        "pano_id": "pano-demo",
                        "heading": 18.0,
                    }
                ]
            }
        }

        async def _fake_fetch(node, *, google_maps_api_key, http_client):
            assert node["pano_id"] == "pano-demo"
            assert google_maps_api_key == "AIza-demo"
            return b"jpeg-bytes", "image/jpeg"

        monkeypatch.setattr(projects, "fetch_travel_route_street_view_image", _fake_fetch)
        client = _client(monkeypatch, fake_pm, _FakeCalc(), google_maps_api_key="AIza-demo")

        with client:
            resp = client.get("/api/v1/projects/ready/travel-route/street-view/google-step-1")

        assert resp.status_code == 200, resp.text
        assert resp.content == b"jpeg-bytes"
        assert resp.headers["content-type"] == "image/jpeg"

    def test_create_project_with_content_type_controls_content_mode(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "情景剧项目",
                    "name": "scene-mode-lock",
                    "content_type": "scene_sketch",
                    "content_mode": "narration",
                },
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["scene-mode-lock"]
            assert data["content_type"] == "scene_sketch"
            assert data["content_mode"] == "drama"

    def test_create_project_explicit_null_style_template_keeps_no_template(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "自定义风格",
                    "name": "custom-style-project",
                    "content_type": "short_drama",
                    "style_template_id": None,
                },
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["custom-style-project"]
            assert "style_template_id" not in data
            assert data["style"] == ""

    def test_create_project_with_unknown_content_type_returns_400(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "坏类型",
                    "name": "bad-content-type",
                    "content_type": "unknown-kind",
                },
            )
            assert resp.status_code == 400

    def test_create_project_with_invalid_content_mode_returns_400(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "坏内容模式",
                    "name": "bad-content-mode",
                    "content_mode": "reference_video",
                },
            )
            assert resp.status_code == 400
            assert "bad-content-mode" not in fake_pm.project_data

    def test_create_project_with_invalid_generation_mode_returns_400(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "坏生成模式",
                    "name": "bad-generation-mode",
                    "generation_mode": "surprise-me",
                },
            )
            assert resp.status_code == 400
            assert "bad-generation-mode" not in fake_pm.project_data

    def test_create_project_normalizes_legacy_generation_mode(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "旧模式项目",
                    "name": "legacy-generation-mode",
                    "generation_mode": "single",
                },
            )
            assert resp.status_code == 200
            assert fake_pm.project_data["legacy-generation-mode"]["generation_mode"] == "storyboard"

    def test_update_project_content_type_applies_workflow_defaults(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.patch(
                "/api/v1/projects/ready",
                json={"content_type": "ad_story"},
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["ready"]
            assert data["content_type"] == "ad_story"
            assert data["content_mode"] == "drama"
            assert data["aspect_ratio"] == "9:16"
            assert data["generation_mode"] == "reference_video"

    def test_create_project_with_unknown_template_id_returns_400(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "坏模版",
                    "name": "bad-1",
                    "style_template_id": "no_such",
                },
            )
            assert resp.status_code == 400

    def test_create_project_with_model_fields_persists(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "模型项目",
                    "name": "m-1",
                    "video_backend": "gemini-aistudio/veo-3",
                    "image_backend": "gemini-aistudio/nano-banana",
                    "text_backend_script": "gemini-aistudio/gemini-2.5",
                    "default_duration": 8,
                },
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["m-1"]
            assert data["video_backend"] == "gemini-aistudio/veo-3"
            assert data["image_backend"] == "gemini-aistudio/nano-banana"
            assert data["text_backend_script"] == "gemini-aistudio/gemini-2.5"
            assert data["default_duration"] == 8
            assert data["default_duration_explicit"] is True

    def test_create_project_empty_model_fields_not_written(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "空字段项目",
                    "name": "e-1",
                    "video_backend": "",
                    "image_backend": None,
                },
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["e-1"]
            assert "video_backend" not in data
            assert "image_backend" not in data

    def test_create_project_with_invalid_backend_returns_400(self, tmp_path, monkeypatch):
        """非法 backend 字符串应被校验器拒绝。"""
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())

        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "title": "Bad Backend",
                    "name": "bad-bk",
                    "video_backend": "garbage",  # 无 "/"，且不在 _LEGACY_PROVIDER_NAMES/PROVIDER_REGISTRY
                },
            )
            assert resp.status_code == 400

    def test_update_project_with_style_template_id_expands_and_clears_image(self, tmp_path, monkeypatch):
        """PATCH style_template_id：写入 id + 展开 prompt 到 style，并清掉 style_image/description。"""
        fake_pm = _FakePM(tmp_path)
        # 预置一个带参考图的项目
        fake_pm.project_data["ready"]["style_image"] = "style_reference.png"
        fake_pm.project_data["ready"]["style_description"] = "old desc"

        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.patch(
                "/api/v1/projects/ready",
                json={"style_template_id": "live_zhang_yimou"},
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["ready"]
            assert data["style_template_id"] == "live_zhang_yimou"
            assert "张艺谋" in data["style"]
            assert "style_image" not in data
            assert "style_description" not in data

    def test_update_project_with_unknown_template_id_returns_400(self, tmp_path, monkeypatch):
        client = _client(monkeypatch, _FakePM(tmp_path), _FakeCalc())
        with client:
            resp = client.patch(
                "/api/v1/projects/ready",
                json={"style_template_id": "no_such_template"},
            )
            assert resp.status_code == 400

    def test_update_project_clear_style_template(self, tmp_path, monkeypatch):
        """PATCH style_template_id=null：同时清掉 id 与派生的 style 长文本。"""
        fake_pm = _FakePM(tmp_path)
        fake_pm.project_data["ready"]["style_template_id"] = "live_premium_drama"
        fake_pm.project_data["ready"]["style"] = "画风：真人电视剧风格，精品短剧画风，大师级构图"

        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.patch(
                "/api/v1/projects/ready",
                json={"style_template_id": None},
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["ready"]
            assert "style_template_id" not in data
            assert data["style"] == ""

    def test_update_project_clear_style_image(self, tmp_path, monkeypatch):
        """PATCH clear_style_image=true：清掉 style_image 与 style_description。"""
        fake_pm = _FakePM(tmp_path)
        fake_pm.project_data["ready"]["style_image"] = "style_reference.png"
        fake_pm.project_data["ready"]["style_description"] = "some desc"

        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.patch(
                "/api/v1/projects/ready",
                json={"clear_style_image": True},
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["ready"]
            assert "style_image" not in data
            assert "style_description" not in data

    def test_list_projects_shares_script_preload_with_status(self, tmp_path, monkeypatch):
        """list_projects 一次性加载 episode scripts，传给 StatusCalculator，去除 cover + status 双重 I/O。"""
        fake_pm = _FakePM(tmp_path)
        # 统计 load_script 调用次数：共享预加载后，ready 项目应只触发一次。
        orig_load_script = fake_pm.load_script
        calls: list[tuple[str, str]] = []

        def _counting_load(name, script_file):
            calls.append((name, script_file))
            return orig_load_script(name, script_file)

        fake_pm.load_script = _counting_load  # type: ignore[method-assign]

        fake_calc = _FakeCalc()
        client = _client(monkeypatch, fake_pm, fake_calc)
        with client:
            resp = client.get("/api/v1/projects")
            assert resp.status_code == 200

        # ready 只有 1 集 script_file="scripts/episode_1.json"：预加载一次。
        # 若 cover + status 各自独立加载，这里会是 2 次。
        ready_calls = [c for c in calls if c[0] == "ready"]
        assert len(ready_calls) == 1, f"expected 1 shared load, got {ready_calls}"

        # 预加载 map 被传给 StatusCalculator
        assert fake_calc.last_preloaded_scripts is not None
        assert "scripts/episode_1.json" in fake_calc.last_preloaded_scripts

    def test_list_projects_returns_style_image_field(self, tmp_path, monkeypatch):
        """列表端点需返回 style_image：否则前端无法区分"自定义风格"与"未设置"。"""
        fake_pm = _FakePM(tmp_path)
        fake_pm.project_data["ready"]["style_image"] = "style_reference.png"
        # 互斥：自定义图情况下 style_template_id 应为空
        fake_pm.project_data["ready"].pop("style_template_id", None)
        fake_pm.project_data["ready"]["style"] = ""

        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.get("/api/v1/projects")
            assert resp.status_code == 200
            ready = [p for p in resp.json()["projects"] if p["name"] == "ready"][0]
            assert ready["style_image"] == "style_reference.png"
            assert ready.get("style_template_id") is None

    def test_list_projects_returns_travel_video_settings(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        fake_pm.project_data["ready"]["content_type"] = "travel_video"
        fake_pm.project_data["ready"]["travel_video_settings"] = {
            "origin": "难波站",
            "destination": "黑门市场",
            "route_source": "manual",
            "target_duration": "60s",
        }

        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.get("/api/v1/projects")
            assert resp.status_code == 200
            ready = [p for p in resp.json()["projects"] if p["name"] == "ready"][0]
            assert ready["content_type"] == "travel_video"
            assert ready["travel_video_settings"]["origin"] == "难波站"
            assert ready["travel_video_settings"]["destination"] == "黑门市场"
            assert ready["travel_video_settings"]["route_source"] == "manual"

    def test_update_project_clear_style_combined(self, tmp_path, monkeypatch):
        """一次性清空所有风格：style_template_id=null + clear_style_image=true。"""
        fake_pm = _FakePM(tmp_path)
        fake_pm.project_data["ready"]["style_template_id"] = "live_premium_drama"
        fake_pm.project_data["ready"]["style"] = "画风：..."
        fake_pm.project_data["ready"]["style_image"] = "style_reference.png"
        fake_pm.project_data["ready"]["style_description"] = "some desc"

        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.patch(
                "/api/v1/projects/ready",
                json={"style_template_id": None, "clear_style_image": True},
            )
            assert resp.status_code == 200
            data = fake_pm.project_data["ready"]
            assert "style_template_id" not in data
            assert data["style"] == ""
            assert "style_image" not in data
            assert "style_description" not in data

    # ---------------------------------------------------------------------------
    # Episodes PATCH tests (Task 12 — reference-video mode)
    # ---------------------------------------------------------------------------

    def test_patch_project_episodes_updates_generation_mode(self, tmp_path, monkeypatch):
        """PATCH /projects/{name} with episodes[] updates generation_mode for matched episode."""
        fake_pm = _FakePM(tmp_path)
        # 项目初始有 2 集，均无 generation_mode 字段
        fake_pm.project_data["ready"]["episodes"] = [
            {"episode": 1, "title": "第一集", "script_file": "scripts/ep1.json"},
            {"episode": 2, "title": "第二集", "script_file": "scripts/ep2.json"},
        ]

        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.patch(
                "/api/v1/projects/ready",
                json={"episodes": [{"episode": 1, "generation_mode": "reference_video"}]},
            )
            assert resp.status_code == 200
            episodes = fake_pm.project_data["ready"]["episodes"]
            ep1 = next(e for e in episodes if e["episode"] == 1)
            ep2 = next(e for e in episodes if e["episode"] == 2)
            assert ep1["generation_mode"] == "reference_video"
            # 第二集不受影响
            assert "generation_mode" not in ep2

    def test_patch_project_episodes_strips_computed_fields(self, tmp_path, monkeypatch):
        """PATCH 不得将 StatusCalculator 注入的计算字段写回 project.json。"""
        fake_pm = _FakePM(tmp_path)
        fake_pm.project_data["ready"]["episodes"] = [
            {"episode": 1, "title": "原标题", "script_file": "scripts/ep1.json"},
        ]

        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.patch(
                "/api/v1/projects/ready",
                json={
                    "episodes": [
                        {
                            "episode": 1,
                            "title": "新标题",
                            # 以下为 StatusCalculator 注入的计算字段，不应写入磁盘
                            "scenes_count": 999,
                            "status": "completed",
                            "storyboards": {"total": 5, "completed": 3},
                            "videos": {"total": 5, "completed": 5},
                            "script_status": "segmented",
                            "duration_seconds": 120,
                        }
                    ]
                },
            )
            assert resp.status_code == 200
            ep1 = fake_pm.project_data["ready"]["episodes"][0]
            # 合法字段应被写入
            assert ep1["title"] == "新标题"
            # 计算字段不得写入
            assert "scenes_count" not in ep1
            assert "status" not in ep1
            assert "storyboards" not in ep1
            assert "videos" not in ep1
            assert "script_status" not in ep1
            assert "duration_seconds" not in ep1

    def test_patch_project_episodes_skips_unknown_episode(self, tmp_path, monkeypatch):
        """PATCH 传入未知 episode 编号时，静默跳过，不改变已有 episodes。"""
        fake_pm = _FakePM(tmp_path)
        fake_pm.project_data["ready"]["episodes"] = [
            {"episode": 1, "title": "第一集", "script_file": "scripts/ep1.json"},
            {"episode": 2, "title": "第二集", "script_file": "scripts/ep2.json"},
        ]

        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.patch(
                "/api/v1/projects/ready",
                json={"episodes": [{"episode": 999, "generation_mode": "grid"}]},
            )
            assert resp.status_code == 200
            episodes = fake_pm.project_data["ready"]["episodes"]
            # 集数不变
            assert len(episodes) == 2
            # 已有字段不受影响
            assert all("generation_mode" not in e for e in episodes)

    def test_patch_project_episodes_clears_generation_mode_with_null(self, tmp_path, monkeypatch):
        """PATCH 传入 generation_mode=null 时，清除集级覆盖以回退项目级继承。"""
        fake_pm = _FakePM(tmp_path)
        fake_pm.project_data["ready"]["episodes"] = [
            {
                "episode": 1,
                "title": "第一集",
                "script_file": "scripts/ep1.json",
                "generation_mode": "reference_video",
            },
        ]

        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.patch(
                "/api/v1/projects/ready",
                json={"episodes": [{"episode": 1, "generation_mode": None}]},
            )
            assert resp.status_code == 200
            ep1 = fake_pm.project_data["ready"]["episodes"][0]
            # 显式 null 清除覆盖，回退项目级继承
            assert "generation_mode" not in ep1
            # 其他字段保持不变
            assert ep1["title"] == "第一集"
            assert ep1["script_file"] == "scripts/ep1.json"


class TestGetVideoCapabilities:
    """GET /projects/{name}/video-capabilities"""

    def _patch_resolver(self, monkeypatch, side_effect=None, return_value=None):
        """用 MagicMock 替换 ConfigResolver 类，让其 instance.video_capabilities() 返回指定行为。"""
        from unittest.mock import AsyncMock, MagicMock

        resolver_instance = MagicMock()
        if side_effect is not None:
            resolver_instance.video_capabilities = AsyncMock(side_effect=side_effect)
        else:
            resolver_instance.video_capabilities = AsyncMock(return_value=return_value)
        monkeypatch.setattr(projects, "ConfigResolver", lambda _factory, **_kwargs: resolver_instance)
        return resolver_instance

    def test_returns_capabilities_json(self, tmp_path, monkeypatch):
        fake_caps = {
            "provider_id": "grok",
            "model": "grok-imagine-video",
            "supported_durations": list(range(1, 16)),
            "max_duration": 15,
            "max_reference_images": 7,
            "source": "registry",
            "default_duration": None,
            "content_mode": "narration",
            "generation_mode": "reference_video",
        }
        self._patch_resolver(monkeypatch, return_value=fake_caps)
        client = _client(monkeypatch, _FakePM(tmp_path), _FakeCalc())
        with client:
            resp = client.get("/api/v1/projects/ready/video-capabilities")
            assert resp.status_code == 200
            assert resp.json() == fake_caps

    def test_unknown_project_returns_404(self, tmp_path, monkeypatch):
        self._patch_resolver(monkeypatch, side_effect=FileNotFoundError("项目 'nonexistent' 不存在"))
        client = _client(monkeypatch, _FakePM(tmp_path), _FakeCalc())
        with client:
            resp = client.get("/api/v1/projects/nonexistent/video-capabilities")
            assert resp.status_code == 404

    def test_resolver_value_error_returns_422(self, tmp_path, monkeypatch):
        self._patch_resolver(monkeypatch, side_effect=ValueError("model not found: grok/unknown"))
        client = _client(monkeypatch, _FakePM(tmp_path), _FakeCalc())
        with client:
            resp = client.get("/api/v1/projects/ready/video-capabilities")
            assert resp.status_code == 422
            assert "model not found" in resp.json()["detail"]


class TestModelSettingsApi:
    def test_create_project_with_model_settings(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            resp = client.post(
                "/api/v1/projects",
                json={
                    "name": "demo-res",
                    "title": "T",
                    "model_settings": {
                        "gemini-aistudio/veo-3.1-lite-generate-preview": {"resolution": "720p"},
                    },
                },
            )
            assert resp.status_code == 200
            # 直接从 create 返回值验证 model_settings 已持久化
            project = resp.json()["project"]
            assert project["model_settings"]["gemini-aistudio/veo-3.1-lite-generate-preview"]["resolution"] == "720p"
            # 也验证 fake_pm 内部存储
            stored = fake_pm.project_data["demo-res"]
            assert stored["model_settings"]["gemini-aistudio/veo-3.1-lite-generate-preview"]["resolution"] == "720p"

    def test_patch_project_model_settings(self, tmp_path, monkeypatch):
        fake_pm = _FakePM(tmp_path)
        client = _client(monkeypatch, fake_pm, _FakeCalc())
        with client:
            # 先创建（利用现有 ready 项目）
            resp = client.patch(
                "/api/v1/projects/ready",
                json={"model_settings": {"gemini-aistudio/veo-3.1": {"resolution": "1080p"}}},
            )
            assert resp.status_code == 200
            # 直接从 patch 返回值验证 model_settings
            project = resp.json()["project"]
            assert project["model_settings"]["gemini-aistudio/veo-3.1"]["resolution"] == "1080p"
            # 也验证 fake_pm 内部存储
            stored = fake_pm.project_data["ready"]
            assert stored["model_settings"]["gemini-aistudio/veo-3.1"]["resolution"] == "1080p"
