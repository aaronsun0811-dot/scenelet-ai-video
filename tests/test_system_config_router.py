"""
Tests for the refactored system_config router.

Uses an in-memory SQLite database and dependency overrides to test
GET/PATCH /api/v1/system/config without real providers.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from lib.config.service import ConfigService, ProviderStatus
from lib.db import get_async_session
from lib.db.base import Base
from lib.project_manager import ProjectManager
from server.auth import CurrentUserInfo, get_current_user
from server.dependencies import get_config_service
from server.routers import system_config as system_config_router

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
async def db_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        sm = async_sessionmaker(engine, expire_on_commit=False)
        async with sm() as session:
            yield session
    finally:
        await engine.dispose()


class _EmptyScalarResult:
    def scalars(self):
        return []

    def scalar_one_or_none(self):
        return None


class _PatchRouteSession:
    async def execute(self, *_args, **_kwargs):
        return _EmptyScalarResult()

    async def commit(self):
        return None


def _make_app_with_mock(mock_svc: ConfigService) -> FastAPI:
    """App with a fully mocked ConfigService + in-memory DB (no real DB)."""
    from contextlib import asynccontextmanager

    mem_engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    mem_factory = async_sessionmaker(mem_engine, expire_on_commit=False)

    @asynccontextmanager
    async def _lifespan(_app: FastAPI):
        try:
            async with mem_engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            yield
        finally:
            await mem_engine.dispose()

    app = FastAPI(lifespan=_lifespan)
    app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="default", sub="testuser", role="admin")
    app.dependency_overrides[get_config_service] = lambda: mock_svc

    async def _override_session():
        async with mem_factory() as session:
            yield session

    app.dependency_overrides[get_async_session] = _override_session
    app.include_router(system_config_router.router, prefix="/api/v1")
    return app


def _make_mock_svc(
    *,
    settings: dict[str, str] | None = None,
    ready_providers: list[str] | None = None,
) -> ConfigService:
    """Create a mock ConfigService with configurable settings and provider statuses."""
    _settings = dict(settings or {})
    svc = MagicMock(spec=ConfigService)

    async def _get_setting(key: str, default: str = "") -> str:
        return _settings.get(key, default)

    async def _set_setting(key: str, value: str) -> None:
        _settings[key] = value

    async def _get_all_settings() -> dict[str, str]:
        return dict(_settings)

    svc.get_setting = AsyncMock(side_effect=_get_setting)
    svc.get_all_settings = AsyncMock(side_effect=_get_all_settings)
    svc.set_setting = AsyncMock(side_effect=_set_setting)

    ready = set(ready_providers or [])

    async def _get_all_providers_status():
        from lib.config.registry import PROVIDER_REGISTRY

        statuses = []
        for name, meta in PROVIDER_REGISTRY.items():
            status = "ready" if name in ready else "unconfigured"
            statuses.append(
                ProviderStatus(
                    name=name,
                    display_name=meta.display_name,
                    description=meta.description,
                    status=status,
                    media_types=list(meta.media_types),
                    capabilities=list(meta.capabilities),
                    required_keys=list(meta.required_keys),
                    configured_keys=list(meta.required_keys) if name in ready else [],
                    missing_keys=[] if name in ready else list(meta.required_keys),
                )
            )
        return statuses

    svc.get_all_providers_status = AsyncMock(side_effect=_get_all_providers_status)
    return svc


# ---------------------------------------------------------------------------
# GET /system/config
# ---------------------------------------------------------------------------


class TestGetSystemConfig:
    def test_returns_200(self):
        mock_svc = _make_mock_svc()
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        assert res.status_code == 200

    def test_response_has_settings_and_options(self):
        mock_svc = _make_mock_svc()
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        body = res.json()
        assert "settings" in body
        assert "options" in body

    def test_settings_keys(self):
        mock_svc = _make_mock_svc()
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        settings = res.json()["settings"]
        expected_keys = {
            "default_video_backend",
            "default_image_backend",
            "default_text_backend",
            "video_generate_audio",
            "anthropic_api_key",
            "google_maps_api_key",
            "baidu_maps_api_key",
            "amap_maps_api_key",
            "anthropic_base_url",
            "anthropic_model",
            "agent_model_backend",
            "anthropic_default_haiku_model",
            "anthropic_default_opus_model",
            "anthropic_default_sonnet_model",
            "claude_code_subagent_model",
            "agent_session_cleanup_delay_seconds",
            "agent_max_concurrent_sessions",
            "about_title",
            "about_subtitle",
            "about_body",
            "about_contact_label",
            "about_contact_url",
            "model_rule_configs",
            "text_backend_script",
            "text_backend_overview",
            "text_backend_style",
        }
        assert set(settings.keys()) == expected_keys

    def test_options_contain_backend_lists(self):
        mock_svc = _make_mock_svc(ready_providers=["gemini-aistudio"])
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        options = res.json()["options"]
        assert "video_backends" in options
        assert "image_backends" in options
        assert "agent_backends" in options
        assert "gemini-aistudio/veo-3.1-generate-preview" in options["video_backends"]
        assert "gemini-aistudio/gemini-3.1-flash-image-preview" in options["image_backends"]
        assert "anthropic/claude-opus-4-7" in options["agent_backends"]

    def test_options_include_builtin_models_before_credentials(self):
        mock_svc = _make_mock_svc(ready_providers=[])
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        options = res.json()["options"]
        assert "gemini-aistudio/veo-3.1-lite-generate-preview" in options["video_backends"]
        assert "openai/gpt-image-2" in options["image_backends"]
        assert "deepseek/deepseek-chat" in options["agent_backends"]

    def test_options_include_multiple_ready_providers(self):
        mock_svc = _make_mock_svc(ready_providers=["gemini-aistudio", "ark"])
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        options = res.json()["options"]
        assert "gemini-aistudio/veo-3.1-generate-preview" in options["video_backends"]
        assert "ark/doubao-seedance-1-5-pro-251215" in options["video_backends"]

    def test_anthropic_key_masked(self):
        mock_svc = _make_mock_svc(settings={"anthropic_api_key": "sk-ant-test-secret-123456"})
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        ak = res.json()["settings"]["anthropic_api_key"]
        assert ak["is_set"] is True
        assert ak["masked"] is not None
        assert "sk-a" in ak["masked"]
        assert "test-secret-123456" not in ak["masked"]

    def test_anthropic_key_unset(self):
        mock_svc = _make_mock_svc()
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        ak = res.json()["settings"]["anthropic_api_key"]
        assert ak["is_set"] is False
        assert ak["masked"] is None

    def test_google_maps_key_masked(self):
        mock_svc = _make_mock_svc(settings={"google_maps_api_key": "AIza-google-secret-123456"})
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        key = res.json()["settings"]["google_maps_api_key"]
        assert key["is_set"] is True
        assert key["masked"] is not None
        assert "AIz" in key["masked"]
        assert "google-secret-123456" not in key["masked"]

    def test_domestic_maps_keys_masked(self):
        mock_svc = _make_mock_svc(
            settings={
                "baidu_maps_api_key": "baidu-secret-123456",
                "amap_maps_api_key": "amap-secret-123456",
            }
        )
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        settings = res.json()["settings"]
        assert settings["baidu_maps_api_key"]["is_set"] is True
        assert settings["amap_maps_api_key"]["is_set"] is True
        assert "secret-123456" not in settings["baidu_maps_api_key"]["masked"]
        assert "secret-123456" not in settings["amap_maps_api_key"]["masked"]

    def test_settings_reflect_stored_values(self):
        mock_svc = _make_mock_svc(
            settings={
                "default_video_backend": "gemini-vertex/veo-3.1-fast-generate-001",
                "video_generate_audio": "true",
                "anthropic_base_url": "https://proxy.example.com",
            }
        )
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        settings = res.json()["settings"]
        assert settings["default_video_backend"] == "gemini-vertex/veo-3.1-fast-generate-001"
        assert settings["video_generate_audio"] is True
        assert settings["anthropic_base_url"] == "https://proxy.example.com"

    def test_model_rule_configs_parse_from_json(self):
        mock_svc = _make_mock_svc(
            settings={
                "model_rule_configs": json.dumps(
                    {
                        "openai/gpt-5.1": {
                            "mode": "github_skill",
                            "skill_runtime": "openai",
                            "skill_github_url": "https://github.com/demo/skills/blob/main/SKILL.md",
                            "skill_content": "# Skill",
                        }
                    }
                )
            }
        )
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        settings = res.json()["settings"]
        assert settings["model_rule_configs"]["openai/gpt-5.1"]["mode"] == "github_skill"
        assert settings["model_rule_configs"]["openai/gpt-5.1"]["skill_runtime"] == "openai"

    def test_video_generate_audio_defaults_to_true_on_empty_db(self):
        """新装系统 DB 为空时，GET /system/config 应返回 video_generate_audio=True，
        与 ConfigResolver._DEFAULT_VIDEO_GENERATE_AUDIO=True 保持一致（PR7 §11）。"""
        mock_svc = _make_mock_svc(settings={})
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.get("/api/v1/system/config")
        settings = res.json()["settings"]
        assert settings["video_generate_audio"] is True


class TestGithubSkillImport:
    def test_github_skill_candidates_for_blob_url(self):
        candidates = system_config_router._github_skill_candidates(
            "https://github.com/acme/video-skills/blob/main/skills/travel/SKILL.md"
        )

        assert candidates == [
            (
                "https://raw.githubusercontent.com/acme/video-skills/main/skills/travel/SKILL.md",
                "skills/travel/SKILL.md",
            )
        ]

    def test_github_skill_candidates_for_tree_url(self):
        candidates = system_config_router._github_skill_candidates(
            "https://github.com/acme/video-skills/tree/main/skills/travel"
        )

        assert candidates == [
            (
                "https://raw.githubusercontent.com/acme/video-skills/main/skills/travel/SKILL.md",
                "skills/travel/SKILL.md",
            )
        ]

    def test_github_skill_candidates_for_repo_root(self):
        candidates = system_config_router._github_skill_candidates(
            "https://github.com/acme/video-skills"
        )

        assert candidates == [
            ("https://raw.githubusercontent.com/acme/video-skills/main/SKILL.md", "SKILL.md"),
            ("https://raw.githubusercontent.com/acme/video-skills/master/SKILL.md", "SKILL.md"),
        ]

    def test_import_github_skill_downloads_on_server(self):
        mock_svc = _make_mock_svc()
        mock_client = MagicMock()
        mock_client.get = AsyncMock(
            return_value=httpx.Response(
                200,
                text="# Skill\nUse travel route nodes.",
                request=httpx.Request(
                    "GET",
                    "https://raw.githubusercontent.com/acme/video-skills/main/skills/travel/SKILL.md",
                ),
            )
        )

        with (
            patch("server.routers.system_config.get_http_client", return_value=mock_client),
            TestClient(_make_app_with_mock(mock_svc)) as client,
        ):
            res = client.post(
                "/api/v1/system/model-rules/import-github-skill",
                json={"url": "https://github.com/acme/video-skills/tree/main/skills/travel"},
            )

        assert res.status_code == 200
        assert res.json() == {
            "skill_name": "skills/travel/SKILL.md",
            "skill_content": "# Skill\nUse travel route nodes.",
            "raw_url": "https://raw.githubusercontent.com/acme/video-skills/main/skills/travel/SKILL.md",
        }
        mock_client.get.assert_awaited_once()

    def test_import_github_skill_rejects_non_github_url(self):
        mock_svc = _make_mock_svc()
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.post(
                "/api/v1/system/model-rules/import-github-skill",
                json={"url": "https://example.com/SKILL.md"},
            )

        assert res.status_code == 422


# ---------------------------------------------------------------------------
# PATCH /system/config
# ---------------------------------------------------------------------------


class TestPatchSystemConfig:
    def _make_patch_app(self, mock_svc: ConfigService, *, role: str = "admin") -> FastAPI:
        """App for PATCH tests - needs session override for commit()."""
        app = FastAPI()
        app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="default", sub="testuser", role=role)
        app.dependency_overrides[get_config_service] = lambda: mock_svc

        mock_session = _PatchRouteSession()

        async def _override_session():
            yield mock_session

        app.dependency_overrides[get_async_session] = _override_session
        app.include_router(system_config_router.router, prefix="/api/v1")
        return app

    def test_patch_returns_200(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"video_generate_audio": True},
            )
        assert res.status_code == 200

    def test_patch_sets_backend(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"default_video_backend": "ark/doubao-seedance-1-5-pro-251215"},
            )
        assert res.status_code == 200
        settings = res.json()["settings"]
        assert settings["default_video_backend"] == "ark/doubao-seedance-1-5-pro-251215"

    def test_patch_rejects_invalid_backend_format(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"default_video_backend": "invalid-no-slash"},
            )
        assert res.status_code == 400

    def test_patch_sets_anthropic_key(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"anthropic_api_key": "sk-ant-new-key-12345678"},
            )
        assert res.status_code == 200
        ak = res.json()["settings"]["anthropic_api_key"]
        assert ak["is_set"] is True

    def test_patch_clears_anthropic_key(self):
        mock_svc = _make_mock_svc(settings={"anthropic_api_key": "sk-ant-old"})
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"anthropic_api_key": ""},
            )
        assert res.status_code == 200
        ak = res.json()["settings"]["anthropic_api_key"]
        assert ak["is_set"] is False

    def test_patch_sets_and_clears_google_maps_key(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"google_maps_api_key": " AIza-google-demo "},
            )
            assert res.status_code == 200
            key = res.json()["settings"]["google_maps_api_key"]
            assert key["is_set"] is True

            res = client.patch(
                "/api/v1/system/config",
                json={"google_maps_api_key": ""},
            )
            assert res.status_code == 200
            key = res.json()["settings"]["google_maps_api_key"]
            assert key["is_set"] is False

    def test_patch_sets_and_clears_domestic_maps_keys(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"baidu_maps_api_key": " baidu-demo ", "amap_maps_api_key": " amap-demo "},
            )
            assert res.status_code == 200
            settings = res.json()["settings"]
            assert settings["baidu_maps_api_key"]["is_set"] is True
            assert settings["amap_maps_api_key"]["is_set"] is True

            res = client.patch(
                "/api/v1/system/config",
                json={"baidu_maps_api_key": "", "amap_maps_api_key": ""},
            )
            assert res.status_code == 200
            settings = res.json()["settings"]
            assert settings["baidu_maps_api_key"]["is_set"] is False
            assert settings["amap_maps_api_key"]["is_set"] is False

    def test_patch_sets_anthropic_base_url(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"anthropic_base_url": "https://proxy.example.com/v1"},
            )
        assert res.status_code == 200
        settings = res.json()["settings"]
        assert settings["anthropic_base_url"] == "https://proxy.example.com/v1"

    def test_patch_sets_audio_toggle(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"video_generate_audio": False},
            )
        assert res.status_code == 200
        assert res.json()["settings"]["video_generate_audio"] is False

    def test_patch_sets_model_fields(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={
                    "anthropic_model": "claude-sonnet-4-20250514",
                    "agent_model_backend": "anthropic/claude-opus-4-7",
                    "claude_code_subagent_model": "claude-haiku-4-20250514",
                },
            )
        assert res.status_code == 200
        settings = res.json()["settings"]
        assert settings["anthropic_model"] == "claude-sonnet-4-20250514"
        assert settings["agent_model_backend"] == "anthropic/claude-opus-4-7"
        assert settings["claude_code_subagent_model"] == "claude-haiku-4-20250514"

    def test_patch_sets_about_fields(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={
                    "about_title": "Scenelet 平台",
                    "about_subtitle": "多人 SaaS 视频创作平台",
                    "about_body": "管理员维护的说明",
                    "about_contact_label": "联系我们",
                    "about_contact_url": "https://example.com/contact",
                },
            )
        assert res.status_code == 200
        settings = res.json()["settings"]
        assert settings["about_title"] == "Scenelet 平台"
        assert settings["about_subtitle"] == "多人 SaaS 视频创作平台"
        assert settings["about_body"] == "管理员维护的说明"
        assert settings["about_contact_label"] == "联系我们"
        assert settings["about_contact_url"] == "https://example.com/contact"

    def test_patch_sets_model_rule_configs(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={
                    "model_rule_configs": {
                        "openai/gpt-5.1": {
                            "mode": "uploaded_skill",
                            "skill_runtime": "claude_code",
                            "skill_name": "SKILL.md",
                            "skill_content": "# Claude Code Skill",
                            "prompt": "should be ignored for uploaded mode",
                        }
                    }
                },
            )
        assert res.status_code == 200
        config = res.json()["settings"]["model_rule_configs"]["openai/gpt-5.1"]
        assert config == {
            "mode": "uploaded_skill",
            "skill_runtime": "claude_code",
            "skill_name": "SKILL.md",
            "skill_content": "# Claude Code Skill",
        }

    def test_patch_about_fields_requires_admin(self):
        mock_svc = _make_mock_svc()
        with TestClient(self._make_patch_app(mock_svc, role="user")) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"about_title": "普通用户不能改"},
            )
        assert res.status_code == 403

    def test_patch_returns_full_response(self):
        mock_svc = _make_mock_svc(ready_providers=["gemini-aistudio"])
        with TestClient(self._make_patch_app(mock_svc)) as client:
            res = client.patch(
                "/api/v1/system/config",
                json={"video_generate_audio": True},
            )
        body = res.json()
        assert "settings" in body
        assert "options" in body


class TestMapProviderConnection:
    def test_uses_draft_key_when_present(self, monkeypatch):
        mock_svc = _make_mock_svc(settings={"baidu_maps_api_key": "saved-baidu"})

        async def _fake_test(provider, *, api_key):
            assert provider == "baidu"
            assert api_key == "draft-baidu"
            return {"success": True, "provider": provider, "message": "ok"}

        monkeypatch.setattr(system_config_router, "test_travel_map_provider", _fake_test)
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.post(
                "/api/v1/system/maps/test",
                json={"provider": "baidu", "api_key": " draft-baidu "},
            )

        assert res.status_code == 200
        assert res.json() == {"success": True, "provider": "baidu", "message": "ok"}

    def test_uses_saved_key_when_draft_absent(self, monkeypatch):
        mock_svc = _make_mock_svc(settings={"amap_maps_api_key": "saved-amap"})

        async def _fake_test(provider, *, api_key):
            assert provider == "amap"
            assert api_key == "saved-amap"
            return {"success": True, "provider": provider, "message": "saved ok"}

        monkeypatch.setattr(system_config_router, "test_travel_map_provider", _fake_test)
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            res = client.post("/api/v1/system/maps/test", json={"provider": "amap"})

        assert res.status_code == 200
        assert res.json()["message"] == "saved ok"


class TestProjectNamespaceMigration:
    def test_preview_and_run_migration(self, tmp_path, monkeypatch):
        project_manager = ProjectManager(tmp_path / "projects")
        project_manager.create_project("legacy")
        project_manager.create_project_metadata("legacy", "Legacy", extras={"owner_user_id": "user-a"})
        monkeypatch.setattr(system_config_router, "get_project_manager", lambda: project_manager)

        mock_svc = _make_mock_svc()
        with TestClient(_make_app_with_mock(mock_svc)) as client:
            preview = client.get("/api/v1/system/project-namespace-migration")
            assert preview.status_code == 200
            preview_body = preview.json()
            assert preview_body["dry_run"] is True
            assert preview_body["candidates"][0]["project_name"] == "legacy"
            assert preview_body["migrated"] == []
            assert (project_manager.projects_root / "legacy").exists()

            run = client.post("/api/v1/system/project-namespace-migration")
            assert run.status_code == 200
            run_body = run.json()
            assert run_body["dry_run"] is False
            assert run_body["migrated"][0]["project_name"] == "legacy"
            assert not (project_manager.projects_root / "legacy").exists()
            assert project_manager.for_user("user-a").load_project("legacy")["title"] == "Legacy"

    def test_migration_requires_admin(self, tmp_path, monkeypatch):
        project_manager = ProjectManager(tmp_path / "projects")
        monkeypatch.setattr(system_config_router, "get_project_manager", lambda: project_manager)
        app = _make_app_with_mock(_make_mock_svc())
        app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(
            id="user-a",
            sub="user-a",
            role="user",
        )
        with TestClient(app) as client:
            res = client.get("/api/v1/system/project-namespace-migration")
        assert res.status_code == 403
