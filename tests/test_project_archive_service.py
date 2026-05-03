import json
import shutil
import stat
import zipfile
from pathlib import Path

import pytest

from lib.project_manager import ProjectManager
from server.services import project_archive as project_archive_module
from server.services.project_archive import (
    ARCHIVE_MANIFEST_NAME,
    DELIVERY_REPORT_JSON_NAME,
    DELIVERY_REPORT_MARKDOWN_NAME,
    MODEL_RULE_AUDIT_JSON_NAME,
    MODEL_RULE_AUDIT_MARKDOWN_NAME,
    TRAVEL_ROUTE_ASSETS_HTML_NAME,
    TRAVEL_ROUTE_ASSETS_JSON_NAME,
    ProjectArchiveService,
    ProjectArchiveValidationError,
)


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _build_episode_payload(*, video_uri: str | None = None) -> dict:
    return {
        "episode": 1,
        "title": "第一集",
        "content_mode": "narration",
        "duration_seconds": 4,
        "summary": "",
        "novel": {
            "title": "Demo",
            "chapter": "第一章",
        },
        "segments": [
            {
                "segment_id": "E1S01",
                "duration_seconds": 4,
                "segment_break": False,
                "novel_text": "原文",
                "characters_in_segment": ["Hero"],
                "scenes": [],
                "props": ["Key"],
                "image_prompt": "img",
                "video_prompt": "vid",
                "transition_to_next": "cut",
                "generated_assets": {
                    "storyboard_image": "storyboards/scene_E1S01.png",
                    "video_clip": "videos/scene_E1S01.mp4",
                    "video_uri": video_uri,
                    "status": "completed",
                },
            }
        ],
    }


def _create_project(
    pm: ProjectManager,
    *,
    name: str = "demo",
    title: str = "Demo",
    style: str = "Anime",
    video_uri: str | None = None,
) -> Path:
    pm.create_project(name)
    pm.create_project_metadata(name, title, style, "narration")

    project_dir = pm.get_project_path(name)
    project = pm.load_project(name)
    project["style_image"] = "style_reference.png"
    project["characters"] = {
        "Hero": {
            "description": "Lead",
            "character_sheet": "characters/Hero.png",
            "reference_image": "characters/refs/Hero.png",
        }
    }
    project["props"] = {
        "Key": {
            "description": "Important prop",
            "prop_sheet": "props/Key.png",
        }
    }
    project["episodes"] = [
        {
            "episode": 1,
            "title": "第一集",
            "script_file": "scripts/episode_1.json",
        }
    ]
    pm.save_project(name, project)

    _write_text(project_dir / "source" / "chapter.txt", "source")
    _write_text(project_dir / "drafts" / "episode_1" / "step1_segments.md", "draft")
    (project_dir / "drafts" / "episode_2").mkdir(parents=True, exist_ok=True)
    _write_bytes(project_dir / "style_reference.png", b"png")
    _write_bytes(project_dir / "characters" / "Hero.png", b"png")
    _write_bytes(project_dir / "characters" / "refs" / "Hero.png", b"png")
    _write_bytes(project_dir / "props" / "Key.png", b"png")
    _write_bytes(project_dir / "storyboards" / "scene_E1S01.png", b"png")
    _write_bytes(project_dir / "videos" / "scene_E1S01.mp4", b"mp4")
    _write_bytes(project_dir / "output" / "final.mp4", b"mp4")
    _write_bytes(project_dir / "versions" / "storyboards" / "E1S01_v1.png", b"png")
    _write_json(
        project_dir / "scripts" / "episode_1.json",
        _build_episode_payload(video_uri=video_uri),
    )

    _write_text(project_dir / ".DS_Store", "hidden")
    _write_text(project_dir / ".hidden" / "secret.txt", "hidden")
    return project_dir


def _add_agent_runtime_symlinks(project_dir: Path) -> None:
    """Create agent_runtime_profile and symlinks mimicking production layout."""
    # projects_root is project_dir.parent; project_root is projects_root.parent
    project_root = project_dir.parent.parent
    profile_claude = project_root / "agent_runtime_profile" / ".claude"
    profile_claude.mkdir(parents=True, exist_ok=True)
    (profile_claude / "settings.json").write_text("{}", encoding="utf-8")
    profile_md = project_root / "agent_runtime_profile" / "CLAUDE.md"
    profile_md.write_text("# Agent Runtime", encoding="utf-8")

    (project_dir / ".claude").symlink_to(Path("../../agent_runtime_profile/.claude"))
    (project_dir / "CLAUDE.md").symlink_to(Path("../../agent_runtime_profile/CLAUDE.md"))


def _make_manual_zip(project_dir: Path, zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in sorted(project_dir.rglob("*")):
            relative = item.relative_to(project_dir)
            if item.is_dir():
                info = zipfile.ZipInfo(relative.as_posix().rstrip("/") + "/")
                archive.writestr(info, b"")
            else:
                archive.write(item, arcname=relative.as_posix())


class TestProjectArchiveService:
    def test_export_includes_full_snapshot_and_empty_dirs(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        service = ProjectArchiveService(pm)

        archive_path, download_name = service.export_project("demo")
        assert download_name.startswith("demo-")
        assert download_name.endswith(".zip")

        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            assert f"demo/{ARCHIVE_MANIFEST_NAME}" in names
            assert "demo/project.json" in names
            assert "demo/source/chapter.txt" in names
            assert "demo/scripts/episode_1.json" in names
            assert "demo/drafts/episode_1/step1_segments.md" in names
            assert "demo/drafts/episode_2/" in names
            assert "demo/characters/Hero.png" in names
            assert "demo/characters/refs/Hero.png" in names
            assert "demo/props/Key.png" in names
            assert "demo/storyboards/scene_E1S01.png" in names
            assert "demo/videos/scene_E1S01.mp4" in names
            assert "demo/output/final.mp4" in names
            assert "demo/versions/storyboards/E1S01_v1.png" in names
            assert "demo/style_reference.png" in names
            assert "demo/.DS_Store" not in names
            assert "demo/.hidden/secret.txt" not in names

    def test_export_excludes_agent_runtime_symlinks(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        _add_agent_runtime_symlinks(project_dir)

        assert (project_dir / ".claude").is_symlink()
        assert (project_dir / "CLAUDE.md").is_symlink()

        service = ProjectArchiveService(pm)
        archive_path, _ = service.export_project("demo")

        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            assert not any(".claude" in n for n in names)
            assert not any("CLAUDE.md" in n for n in names)
            assert "demo/project.json" in names
            assert "demo/source/chapter.txt" in names

    def test_export_excludes_agent_runtime_real_files(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        (project_dir / "CLAUDE.md").write_text("# Agent", encoding="utf-8")

        service = ProjectArchiveService(pm)
        archive_path, _ = service.export_project("demo")

        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            assert not any("CLAUDE.md" in n for n in names)
            assert "demo/project.json" in names

    def test_export_excludes_broken_agent_runtime_symlinks(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        # Create broken symlinks (targets don't exist)
        (project_dir / ".claude").symlink_to(Path("../../agent_runtime_profile/.claude"))
        (project_dir / "CLAUDE.md").symlink_to(Path("../../agent_runtime_profile/CLAUDE.md"))

        assert (project_dir / ".claude").is_symlink()
        assert not (project_dir / ".claude").exists()

        service = ProjectArchiveService(pm)
        archive_path, _ = service.export_project("demo")

        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            assert not any(".claude" in n for n in names)
            assert not any("CLAUDE.md" in n for n in names)

    def test_import_official_export_round_trip(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        service = ProjectArchiveService(pm)

        archive_path, _ = service.export_project("demo")
        shutil.rmtree(pm.get_project_path("demo"))

        result = service.import_project_archive(
            archive_path,
            uploaded_filename="demo.zip",
        )

        assert result.project_name == "demo"
        assert result.conflict_resolution == "none"
        assert (pm.get_project_path("demo") / "videos" / "scene_E1S01.mp4").exists()
        assert (pm.get_project_path("demo") / "drafts" / "episode_2").is_dir()

    def test_import_uses_current_user_namespace_and_owner(self, tmp_path):
        source_pm = ProjectManager(tmp_path / "source-projects")
        _create_project(source_pm)
        archive_path, _ = ProjectArchiveService(source_pm).export_project("demo")

        base_pm = ProjectManager(tmp_path / "projects")
        bob_pm = base_pm.for_user("bob")
        result = ProjectArchiveService(bob_pm).import_project_archive(
            archive_path,
            uploaded_filename="demo.zip",
        )

        imported_path = bob_pm.get_project_path(result.project_name)
        assert ProjectManager.USER_PROJECTS_DIR in imported_path.parts
        assert imported_path == bob_pm.get_project_storage_path(result.project_name)
        assert result.project["owner_user_id"] == "bob"
        assert bob_pm.load_project(result.project_name)["owner_user_id"] == "bob"
        assert not (base_pm.projects_root / result.project_name).exists()

    def test_import_manual_zip_without_manifest(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        service = ProjectArchiveService(pm)

        archive_path = tmp_path / "manual.zip"
        _make_manual_zip(project_dir, archive_path)
        shutil.rmtree(project_dir)

        result = service.import_project_archive(
            archive_path,
            uploaded_filename="manual.zip",
        )

        assert result.project["title"] == "Demo"
        assert result.project_name != "demo"
        assert (pm.get_project_path(result.project_name) / "project.json").exists()

    def test_import_rejects_missing_project_json(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        service = ProjectArchiveService(pm)
        archive_path = tmp_path / "missing-project-json.zip"

        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("demo/source/chapter.txt", "source")

        with pytest.raises(ProjectArchiveValidationError) as exc_info:
            service.import_project_archive(archive_path, uploaded_filename="broken.zip")

        assert exc_info.value.detail == "导入包校验失败"
        assert any("project.json" in error for error in exc_info.value.errors)

    def test_import_rejects_missing_script_reference(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        service = ProjectArchiveService(pm)
        project_dir = pm.get_project_path("demo")
        (project_dir / "scripts" / "episode_1.json").unlink()

        archive_path = tmp_path / "missing-script.zip"
        _make_manual_zip(project_dir, archive_path)

        with pytest.raises(ProjectArchiveValidationError) as exc_info:
            service.import_project_archive(archive_path, uploaded_filename="broken.zip")

        assert any("episodes[0].script_file" in error for error in exc_info.value.errors)

    @pytest.mark.parametrize(
        ("field_name", "target_path"),
        [
            ("characters[Hero].character_sheet", ("characters", "Hero.png")),
            ("props[Key].prop_sheet", ("props", "Key.png")),
            (
                "segments[0].generated_assets.storyboard_image",
                ("storyboards", "scene_E1S01.png"),
            ),
            (
                "segments[0].generated_assets.video_clip",
                ("videos", "scene_E1S01.mp4"),
            ),
        ],
    )
    def test_import_rejects_missing_asset_references(
        self,
        tmp_path,
        field_name,
        target_path,
    ):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        service = ProjectArchiveService(pm)
        project_dir = pm.get_project_path("demo")
        (project_dir.joinpath(*target_path)).unlink()
        if field_name == "segments[0].generated_assets.storyboard_image":
            (project_dir / "versions" / "storyboards" / "E1S01_v1.png").unlink()

        archive_path = tmp_path / f"{field_name}.zip"
        _make_manual_zip(project_dir, archive_path)

        with pytest.raises(ProjectArchiveValidationError) as exc_info:
            service.import_project_archive(archive_path, uploaded_filename="broken.zip")

        assert any(field_name in error for error in exc_info.value.errors)

    def test_import_allows_external_video_uri(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm, video_uri="gs://bucket/video-ref")
        service = ProjectArchiveService(pm)

        archive_path = tmp_path / "external-video-uri.zip"
        _make_manual_zip(project_dir, archive_path)
        shutil.rmtree(project_dir)

        result = service.import_project_archive(
            archive_path,
            uploaded_filename="external-video-uri.zip",
        )

        assert result.project["episodes"][0]["script_file"] == "scripts/episode_1.json"

    @pytest.mark.parametrize(
        "archive_builder",
        ["absolute", "traversal", "symlink", "encrypted"],
    )
    def test_import_rejects_unsafe_zip_members(self, tmp_path, archive_builder):
        pm = ProjectManager(tmp_path / "projects")
        service = ProjectArchiveService(pm)
        archive_path = tmp_path / f"{archive_builder}.zip"

        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("demo/project.json", json.dumps({"title": "Demo"}))
            if archive_builder == "absolute":
                archive.writestr("/demo/scripts/episode_1.json", "{}")
            elif archive_builder == "traversal":
                archive.writestr("../demo/scripts/episode_1.json", "{}")
            elif archive_builder == "symlink":
                info = zipfile.ZipInfo("demo/source/link.txt")
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, "target")
            elif archive_builder == "encrypted":
                info = zipfile.ZipInfo("demo/source/chapter.txt")
                info.flag_bits |= 0x1
                archive.writestr(info, "source")

        with pytest.raises(ProjectArchiveValidationError):
            service.import_project_archive(archive_path, uploaded_filename="unsafe.zip")

    def test_import_rename_conflict_generates_new_project_id(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        service = ProjectArchiveService(pm)
        archive_path, _ = service.export_project("demo")

        result = service.import_project_archive(
            archive_path,
            uploaded_filename="demo.zip",
            conflict_policy="rename",
        )

        assert result.project_name != "demo"
        assert result.project_name.startswith("demo-")
        assert result.conflict_resolution == "renamed"
        assert pm.get_project_path("demo").exists()
        assert pm.get_project_path(result.project_name).exists()

    def test_import_prompt_conflict_requires_user_confirmation(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        service = ProjectArchiveService(pm)
        archive_path, _ = service.export_project("demo")

        with pytest.raises(ProjectArchiveValidationError) as exc_info:
            service.import_project_archive(
                archive_path,
                uploaded_filename="demo.zip",
                conflict_policy="prompt",
            )

        assert exc_info.value.status_code == 409
        assert exc_info.value.detail == "检测到项目编号冲突"
        assert exc_info.value.extra["conflict_project_name"] == "demo"

    def test_import_overwrite_replaces_existing_project(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm, style="Fresh")
        service = ProjectArchiveService(pm)
        archive_path, _ = service.export_project("demo")

        project = pm.load_project("demo")
        project["style"] = "Stale"
        pm.save_project("demo", project)
        _write_text(pm.get_project_path("demo") / "source" / "chapter.txt", "stale")

        result = service.import_project_archive(
            archive_path,
            uploaded_filename="demo.zip",
            conflict_policy="overwrite",
        )

        assert result.project_name == "demo"
        assert result.conflict_resolution == "overwritten"
        assert pm.load_project("demo")["style"] == "Fresh"
        assert (pm.get_project_path("demo") / "source" / "chapter.txt").read_text(encoding="utf-8") == "source"

    def test_import_creates_claude_symlink(self, tmp_path):
        """Imported project should get .claude symlink for agent runtime isolation."""
        # Create agent_runtime_profile in project root (parent of projects/)
        profile_claude = tmp_path / "agent_runtime_profile" / ".claude"
        profile_claude.mkdir(parents=True)

        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        service = ProjectArchiveService(pm)
        archive_path, _ = service.export_project("demo")

        # Import as a new project
        result = service.import_project_archive(
            archive_path,
            uploaded_filename="demo.zip",
            conflict_policy="rename",
        )

        imported_dir = pm.get_project_path(result.project_name)
        symlink = imported_dir / ".claude"
        assert symlink.is_symlink()
        assert symlink.resolve() == profile_claude.resolve()

    def test_import_overwrite_rolls_back_on_install_failure(self, tmp_path, monkeypatch):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm, style="Fresh")
        service = ProjectArchiveService(pm)
        archive_path, _ = service.export_project("demo")

        project = pm.load_project("demo")
        project["style"] = "Stale"
        pm.save_project("demo", project)

        original_move = project_archive_module.shutil.move

        def boom(src, dst):
            raise RuntimeError("move failed")

        monkeypatch.setattr(project_archive_module.shutil, "move", boom)

        with pytest.raises(RuntimeError):
            service.import_project_archive(
                archive_path,
                uploaded_filename="demo.zip",
                conflict_policy="overwrite",
            )

        monkeypatch.setattr(project_archive_module.shutil, "move", original_move)
        assert pm.load_project("demo")["style"] == "Stale"

    def test_import_repairs_legacy_narration_payload(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        service = ProjectArchiveService(pm)

        project = pm.load_project("demo")
        project["characters"] = {}
        pm.save_project("demo", project)

        source_dir = project_dir / "source"
        (source_dir / "chapter.txt").unlink()
        _write_text(source_dir / "1-7-0227.txt", "source")

        _write_json(
            project_dir / "versions" / "versions.json",
            {
                "videos": {
                    "E1S01_1": {
                        "current_version": 1,
                        "versions": [
                            {
                                "version": 1,
                                "file": "versions/videos/E1S01_1_v1.mp4",
                                "prompt": "vp1",
                                "created_at": "2024-01-01",
                            }
                        ],
                    }
                }
            },
        )
        _write_bytes(project_dir / "versions" / "videos" / "E1S01_1_v1.mp4", b"mp4-v1")

        _write_json(
            project_dir / "scripts" / "episode_1.json",
            {
                "episode": 1,
                "title": "第一集",
                "content_mode": "narration",
                "novel": {
                    "title": "Demo",
                    "chapter": "第一章",
                },
                "segments": [
                    {
                        "segment_id": "E1S01_1",
                        "duration_seconds": 4,
                        "novel_text": "原文",
                        "characters_in_segment": ["Ghost"],
                        "image_prompt": "img",
                        "video_prompt": "vid",
                        "generated_assets": {
                            "storyboard_image": "storyboards/scene_E1S01.png",
                            "video_clip": "versions/videos/E1S01_1_v9.mp4",
                            "video_uri": None,
                            "status": "completed",
                        },
                    }
                ],
            },
        )

        archive_path = tmp_path / "legacy.zip"
        _make_manual_zip(project_dir, archive_path)
        shutil.rmtree(project_dir)

        result = service.import_project_archive(
            archive_path,
            uploaded_filename="legacy.zip",
        )

        imported_project = pm.load_project(result.project_name)
        imported_script = json.loads(
            (pm.get_project_path(result.project_name) / "scripts" / "episode_1.json").read_text(encoding="utf-8")
        )

        assert "Ghost" in imported_project["characters"]
        assert "source_file" not in imported_script["novel"]
        assert imported_script["segments"][0]["scenes"] == []
        assert imported_script["segments"][0]["props"] == []
        assert "clues_in_segment" not in imported_script["segments"][0]
        assert imported_script["segments"][0]["generated_assets"]["video_clip"] == "videos/scene_E1S01_1.mp4"
        assert result.diagnostics["auto_fixed"]

    def test_import_blocks_missing_scene_definition(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        service = ProjectArchiveService(pm)

        _write_json(
            project_dir / "scripts" / "episode_1.json",
            {
                "episode": 1,
                "title": "第一集",
                "content_mode": "narration",
                "novel": {
                    "title": "Demo",
                    "chapter": "第一章",
                },
                "segments": [
                    {
                        "segment_id": "E1S01",
                        "duration_seconds": 4,
                        "novel_text": "原文",
                        "characters_in_segment": ["Hero"],
                        "scenes": ["Missing"],
                        "props": [],
                        "image_prompt": "img",
                        "video_prompt": "vid",
                    }
                ],
            },
        )

        archive_path = tmp_path / "missing-scene.zip"
        _make_manual_zip(project_dir, archive_path)

        with pytest.raises(ProjectArchiveValidationError) as exc_info:
            service.import_project_archive(archive_path, uploaded_filename="missing-scene.zip")

        assert any("不存在于 project.json 的场景" in error for error in exc_info.value.errors)
        assert exc_info.value.extra["diagnostics"]["blocking"]

    def test_import_blocks_missing_prop_definition(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        service = ProjectArchiveService(pm)

        _write_json(
            project_dir / "scripts" / "episode_1.json",
            {
                "episode": 1,
                "title": "第一集",
                "content_mode": "narration",
                "novel": {
                    "title": "Demo",
                    "chapter": "第一章",
                },
                "segments": [
                    {
                        "segment_id": "E1S01",
                        "duration_seconds": 4,
                        "novel_text": "原文",
                        "characters_in_segment": ["Hero"],
                        "scenes": [],
                        "props": ["Missing"],
                        "image_prompt": "img",
                        "video_prompt": "vid",
                    }
                ],
            },
        )

        archive_path = tmp_path / "missing-prop.zip"
        _make_manual_zip(project_dir, archive_path)

        with pytest.raises(ProjectArchiveValidationError) as exc_info:
            service.import_project_archive(archive_path, uploaded_filename="missing-prop.zip")

        assert any("不存在于 project.json 的道具" in error for error in exc_info.value.errors)
        assert exc_info.value.extra["diagnostics"]["blocking"]

    def test_export_dirty_project_emits_diagnostics_and_repairs_snapshot(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        service = ProjectArchiveService(pm)

        _write_text(project_dir / "run_video_gen.py", "print('helper')")
        _write_json(
            project_dir / "versions" / "versions.json",
            {
                "videos": {
                    "E1S01": {
                        "current_version": 1,
                        "versions": [
                            {
                                "version": 1,
                                "file": "versions/videos/E1S01_v1.mp4",
                                "prompt": "vp1",
                                "created_at": "2024-01-01",
                            }
                        ],
                    }
                }
            },
        )
        _write_bytes(project_dir / "versions" / "videos" / "E1S01_v1.mp4", b"mp4-v1")
        _write_json(
            project_dir / "scripts" / "episode_1.json",
            {
                "episode": 1,
                "title": "第一集",
                "content_mode": "narration",
                "novel": {
                    "title": "Demo",
                    "chapter": "第一章",
                },
                "segments": [
                    {
                        "segment_id": "E1S01",
                        "duration_seconds": 4,
                        "novel_text": "原文",
                        "characters_in_segment": ["Hero"],
                        "image_prompt": "img",
                        "video_prompt": "vid",
                        "generated_assets": {
                            "storyboard_image": "storyboards/scene_E1S01.png",
                            "video_clip": "versions/videos/E1S01_v9.mp4",
                            "video_uri": None,
                            "status": "completed",
                        },
                    }
                ],
            },
        )

        archive_path, _ = service.export_project("demo", scope="full")

        with zipfile.ZipFile(archive_path) as archive:
            manifest = json.loads(archive.read(f"demo/{ARCHIVE_MANIFEST_NAME}"))
            exported_script = json.loads(archive.read("demo/scripts/episode_1.json"))

        assert manifest["format_version"] == 2
        assert manifest["script_schema_version"] == 2
        assert "run_video_gen.py" in manifest["pass_through_entries"]
        assert manifest["export_diagnostics"]["auto_fixed"]
        assert exported_script["segments"][0]["scenes"] == []
        assert exported_script["segments"][0]["props"] == []
        assert "clues_in_segment" not in exported_script["segments"][0]
        assert exported_script["segments"][0]["generated_assets"]["video_clip"] == "videos/scene_E1S01.mp4"

    def test_export_includes_delivery_report_manifest_and_files(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        service = ProjectArchiveService(pm)
        script = _build_episode_payload()
        script["segments"][0]["generated_assets"]["video_thumbnail"] = None
        script["segments"].append(
            {
                "segment_id": "E1S02",
                "duration_seconds": 4,
                "segment_break": False,
                "novel_text": "第二段",
                "characters_in_segment": ["Hero"],
                "scenes": [],
                "props": ["Key"],
                "image_prompt": "img 2",
                "video_prompt": "vid 2",
                "transition_to_next": "cut",
                "generated_assets": {
                    "storyboard_image": "storyboards/scene_E1S02.png",
                    "video_clip": None,
                    "video_uri": None,
                    "video_thumbnail": None,
                    "status": "storyboard_ready",
                },
            }
        )
        _write_bytes(project_dir / "storyboards" / "scene_E1S02.png", b"png")
        _write_json(project_dir / "scripts" / "episode_1.json", script)

        archive_path, _ = service.export_project("demo", scope="current")

        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            manifest = json.loads(archive.read(f"demo/{ARCHIVE_MANIFEST_NAME}"))
            delivery_report = json.loads(archive.read(f"demo/{DELIVERY_REPORT_JSON_NAME}"))
            delivery_markdown = archive.read(f"demo/{DELIVERY_REPORT_MARKDOWN_NAME}").decode("utf-8")

        assert f"demo/{DELIVERY_REPORT_JSON_NAME}" in names
        assert f"demo/{DELIVERY_REPORT_MARKDOWN_NAME}" in names
        assert manifest["delivery_report"] == delivery_report
        assert delivery_report["status"] == "needs_work"
        assert delivery_report["totals"]["videos_ready"] == 1
        assert delivery_report["totals"]["videos_total"] == 2
        assert delivery_report["totals"]["blocking_issues"] == 1
        assert delivery_report["totals"]["warnings"] == 1
        episode_report = delivery_report["episodes"][0]
        assert episode_report["videos"]["missing"] == ["E1S02"]
        assert episode_report["warnings"][0]["code"] == "missing_video_thumbnails"
        assert "交付状态: 需处理" in delivery_markdown
        assert "1 个视频未生成" in delivery_markdown

    def test_export_includes_model_rule_audit_manifest_and_files(self, tmp_path, monkeypatch):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        service = ProjectArchiveService(pm)

        def fake_load_tasks(self, project_name):
            assert project_name == "demo"
            return [
                {
                    "task_id": "task-video-1",
                    "project_name": "demo",
                    "task_type": "video",
                    "media_type": "video",
                    "resource_id": "E1S01",
                    "script_file": "scripts/episode_1.json",
                    "payload": {
                        "model_rule_summary": {
                            "task_type": "video",
                            "media_type": "video",
                            "rule_target": "__media__/video",
                            "mode": "github_skill",
                            "mode_label": "GitHub Skill",
                            "provider_id": "runway",
                            "model_id": "gen-4",
                            "target_label": "Runway · gen-4",
                            "skill_name": "cinematic-skill",
                            "billing_mode": "platform_credits",
                        }
                    },
                    "status": "succeeded",
                    "source": "webui",
                    "queued_at": "2026-05-03T01:00:00+08:00",
                    "started_at": "2026-05-03T01:01:00+08:00",
                    "finished_at": "2026-05-03T01:02:00+08:00",
                    "updated_at": "2026-05-03T01:02:00+08:00",
                }
            ]

        monkeypatch.setattr(ProjectArchiveService, "_load_model_rule_audit_tasks", fake_load_tasks)

        archive_path, _ = service.export_project("demo", scope="current")

        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            manifest = json.loads(archive.read(f"demo/{ARCHIVE_MANIFEST_NAME}"))
            delivery_report = json.loads(archive.read(f"demo/{DELIVERY_REPORT_JSON_NAME}"))
            delivery_markdown = archive.read(f"demo/{DELIVERY_REPORT_MARKDOWN_NAME}").decode("utf-8")
            audit_report = json.loads(archive.read(f"demo/{MODEL_RULE_AUDIT_JSON_NAME}"))
            audit_markdown = archive.read(f"demo/{MODEL_RULE_AUDIT_MARKDOWN_NAME}").decode("utf-8")

        assert f"demo/{MODEL_RULE_AUDIT_JSON_NAME}" in names
        assert f"demo/{MODEL_RULE_AUDIT_MARKDOWN_NAME}" in names
        assert manifest["model_rule_audit"] == audit_report
        assert audit_report["total"] == 1
        assert audit_report["by_mode"] == {"github_skill": 1}
        assert audit_report["by_media_type"] == {"video": 1}
        assert audit_report["items"][0]["rule"]["skill_name"] == "cinematic-skill"
        assert delivery_report["model_rule_audit"]["total"] == 1
        assert MODEL_RULE_AUDIT_JSON_NAME in delivery_report["model_rule_audit"]["artifact_files"]
        assert "## 模型规则审计" in delivery_markdown
        assert MODEL_RULE_AUDIT_MARKDOWN_NAME in delivery_markdown
        assert "GitHub Skill" in audit_markdown
        assert "cinematic-skill" in audit_markdown

    def test_run_async_does_not_dispose_global_database_pool(self, monkeypatch):
        def fail_if_called():
            raise AssertionError("export preflight must not dispose the live server DB pool")

        async def load():
            return ["ok"]

        monkeypatch.setattr("lib.db.engine.dispose_pool", fail_if_called)

        assert ProjectArchiveService._run_async(load) == ["ok"]

    def test_export_manifest_uses_content_type_workflow_defaults(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        project = pm.load_project("demo")
        project["content_type"] = "scene_sketch"
        project["content_mode"] = "narration"
        project.pop("aspect_ratio", None)
        project.pop("generation_mode", None)
        pm.save_project("demo", project)
        service = ProjectArchiveService(pm)

        archive_path, _ = service.export_project("demo", scope="full")

        with zipfile.ZipFile(archive_path) as archive:
            manifest = json.loads(archive.read(f"demo/{ARCHIVE_MANIFEST_NAME}"))
            exported_project = json.loads(archive.read("demo/project.json"))

        assert manifest["content_type"] == "scene_sketch"
        assert manifest["content_mode"] == "drama"
        assert manifest["aspect_ratio"] == "16:9"
        assert manifest["generation_mode"] == "storyboard"
        assert exported_project["content_mode"] == "drama"
        assert exported_project["aspect_ratio"] == "16:9"
        assert exported_project["generation_mode"] == "storyboard"

    def test_export_preflight_blocks_travel_video_without_route_preview(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        project = pm.load_project("demo")
        project["content_type"] = "travel_video"
        project["travel_video_settings"] = {
            "route_source": "manual",
            "origin": "难波站",
            "destination": "黑门市场",
            "route_notes": "从车站步行到市场，沿途介绍街景。",
        }
        pm.save_project("demo", project)
        service = ProjectArchiveService(pm)

        preflight = service.get_export_preflight("demo", scope="current")

        blocking_codes = {item["code"] for item in preflight["diagnostics"]["blocking"]}
        assert "travel_route_preview_missing" in blocking_codes

    def test_export_preflight_blocks_failed_travel_route_preview(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        _create_project(pm)
        project = pm.load_project("demo")
        project["content_type"] = "travel_video"
        project["travel_video_settings"] = {
            "route_source": "google_street_view",
            "origin": "难波站",
            "destination": "黑门市场",
            "route_preview": {
                "source": "manual",
                "route_ready": False,
                "nodes": [],
                "reference_images": [],
                "warnings": [
                    {
                        "code": "google_route_status",
                        "message": "Google 路线解析未返回可用路线：ZERO_RESULTS",
                    }
                ],
            },
        }
        pm.save_project("demo", project)
        service = ProjectArchiveService(pm)

        preflight = service.get_export_preflight("demo", scope="current")

        blocking = preflight["diagnostics"]["blocking"]
        assert any(item["code"] == "travel_route_preview_not_ready" for item in blocking)
        assert any("ZERO_RESULTS" in item["message"] for item in blocking)

    def test_export_includes_travel_references_for_ready_travel_video(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        _write_bytes(project_dir / "travel_references" / "street.png", b"png")
        _write_bytes(project_dir / "reference_videos" / "E1U1.mp4", b"mp4")
        _write_bytes(project_dir / "reference_videos" / "thumbnails" / "E1U1.jpg", b"jpg")
        project = pm.load_project("demo")
        project["content_type"] = "travel_video"
        project["travel_video_settings"] = {
            "route_source": "reference_images",
            "origin": "难波站",
            "destination": "黑门市场",
            "reference_images": ["travel_references/street.png"],
            "route_preview": {
                "source": "reference_images",
                "route_ready": True,
                "summary": "使用上传参考图生成路线。",
                "distance_text": "1.2 km",
                "duration_text": "15 mins",
                "nodes": [
                    {
                        "id": "reference-1",
                        "label": "参考图 1",
                        "instruction": "travel_references/street.png",
                        "source": "reference_image",
                    }
                ],
                "reference_images": ["travel_references/street.png"],
                "warnings": [],
            },
        }
        pm.save_project("demo", project)
        _write_json(
            project_dir / "scripts" / "episode_1.json",
            {
                "episode": 1,
                "title": "第一集",
                "content_mode": "reference_video",
                "summary": "沿路线抵达市场",
                "novel": {"title": "Demo", "chapter": "第一章"},
                "duration_seconds": 4,
                "video_units": [
                    {
                        "unit_id": "E1U1",
                        "shots": [
                            {
                                "duration": 4,
                                "text": "Shot 1 (4s): 沿参考图 1 的街景向前走，保持导游口播节奏。",
                            }
                        ],
                        "references": [],
                        "duration_seconds": 4,
                        "duration_override": False,
                        "transition_to_next": "cut",
                        "note": None,
                        "generated_assets": {
                            "storyboard_image": None,
                            "storyboard_last_image": None,
                            "grid_id": None,
                            "grid_cell_index": None,
                            "video_clip": "reference_videos/E1U1.mp4",
                            "video_uri": None,
                            "video_thumbnail": "reference_videos/thumbnails/E1U1.jpg",
                            "status": "completed",
                        },
                    }
                ],
            },
        )
        service = ProjectArchiveService(pm)

        preflight = service.get_export_preflight("demo", scope="current")
        assert preflight["travel_route_assets"]["node_coverage"]["covered"] == 1
        assert preflight["travel_route_assets"]["reference_images"]["items"][0]["path"] == "travel_references/street.png"

        archive_path, _ = service.export_project("demo", scope="current")

        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            manifest = json.loads(archive.read(f"demo/{ARCHIVE_MANIFEST_NAME}"))
            delivery_report = json.loads(archive.read(f"demo/{DELIVERY_REPORT_JSON_NAME}"))
            delivery_markdown = archive.read(f"demo/{DELIVERY_REPORT_MARKDOWN_NAME}").decode("utf-8")
            route_assets = json.loads(archive.read(f"demo/{TRAVEL_ROUTE_ASSETS_JSON_NAME}"))
            route_assets_html = archive.read(f"demo/{TRAVEL_ROUTE_ASSETS_HTML_NAME}").decode("utf-8")

        blocking_codes = {item["code"] for item in manifest["export_diagnostics"]["blocking"]}
        warning_codes = {item["code"] for item in manifest["export_diagnostics"]["warnings"]}
        assert "demo/travel_references/street.png" in names
        assert f"demo/{TRAVEL_ROUTE_ASSETS_JSON_NAME}" in names
        assert f"demo/{TRAVEL_ROUTE_ASSETS_HTML_NAME}" in names
        assert "travel_route_missing" not in blocking_codes
        assert "travel_route_preview_missing" not in blocking_codes
        assert "travel_reference_images_missing_files" not in warning_codes
        assert delivery_report["travel_route"]["summary"] == "使用上传参考图生成路线。"
        assert delivery_report["travel_route"]["nodes_total"] == 1
        assert delivery_report["travel_route"]["nodes_covered"] == 1
        assert delivery_report["travel_route"]["reference_images_count"] == 1
        assert delivery_report["travel_route"]["usable_reference_images_count"] == 1
        assert delivery_report["travel_route"]["nodes"][0]["matched_units"] == ["E1U1"]
        assert "## 旅游路线检查" in delivery_markdown
        assert "路线节点覆盖: 1 / 1" in delivery_markdown
        assert "参考图数量: 1 / 1 可用" in delivery_markdown
        assert manifest["travel_route_assets"]["node_coverage"]["covered"] == 1
        assert route_assets["route"]["summary"] == "使用上传参考图生成路线。"
        assert route_assets["node_coverage"] == {"total": 1, "covered": 1, "missing": []}
        assert route_assets["reference_images"]["items"][0]["path"] == "travel_references/street.png"
        assert route_assets["reference_images"]["items"][0]["html_src"] == "../travel_references/street.png"
        assert route_assets["reference_images"]["items"][0]["used_by_nodes"] == ["reference-1"]
        assert route_assets["nodes"][0]["matched_units"] == ["E1U1"]
        assert route_assets["nodes"][0]["matched_unit_details"] == [
            {
                "id": "E1U1",
                "episode": 1,
                "title": "第一集",
                "script_file": "scripts/episode_1.json",
                "video_clip": "reference_videos/E1U1.mp4",
                "video_thumbnail": "reference_videos/thumbnails/E1U1.jpg",
                "status": "completed",
            }
        ]
        assert route_assets["nodes"][0]["reference_images"] == ["travel_references/street.png"]
        assert "Scenelet 旅游路线素材清单" in route_assets_html
        assert "../travel_references/street.png" in route_assets_html
        assert "E1U1 · E1 · 第一集" in route_assets_html
        assert "E1U1" in route_assets_html

    def test_import_repairs_project_workflow_fields_from_content_type(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        project_dir = _create_project(pm)
        service = ProjectArchiveService(pm)

        project = pm.load_project("demo")
        project["content_type"] = "scene_sketch"
        project["content_mode"] = "narration"
        project.pop("aspect_ratio", None)
        project.pop("generation_mode", None)
        _write_json(project_dir / "project.json", project)

        archive_path = tmp_path / "workflow-repair.zip"
        _make_manual_zip(project_dir, archive_path)
        shutil.rmtree(project_dir)

        result = service.import_project_archive(
            archive_path,
            uploaded_filename="workflow-repair.zip",
        )

        imported_project = pm.load_project(result.project_name)
        auto_fixed_codes = {item["code"] for item in result.diagnostics["auto_fixed"]}
        assert imported_project["content_type"] == "scene_sketch"
        assert imported_project["content_mode"] == "drama"
        assert imported_project["aspect_ratio"] == "16:9"
        assert imported_project["generation_mode"] == "storyboard"
        assert "content_mode_repaired" in auto_fixed_codes
        assert "aspect_ratio_backfilled" in auto_fixed_codes
        assert "generation_mode_backfilled" in auto_fixed_codes


class TestExportScope:
    def _create_project_with_versions(self, pm: ProjectManager) -> Path:
        """创建带有 versions 历史的项目"""
        project_dir = _create_project(pm)

        # 添加版本历史文件
        _write_bytes(project_dir / "versions" / "storyboards" / "E1S01_v1.png", b"png-v1")
        _write_bytes(project_dir / "versions" / "storyboards" / "E1S01_v2.png", b"png-v2")
        _write_bytes(project_dir / "versions" / "videos" / "E1S01_v1.mp4", b"mp4-v1")
        _write_bytes(project_dir / "versions" / "characters" / "Hero_v1.png", b"char-v1")
        _write_bytes(project_dir / "versions" / "scenes" / "Temple_v1.png", b"scene-v1")
        _write_bytes(project_dir / "versions" / "props" / "Key_v1.png", b"prop-v1")

        # 创建 versions/versions.json
        versions_data = {
            "storyboards": {
                "E1S01": {
                    "current_version": 3,
                    "versions": [
                        {"version": 1, "prompt": "p1", "created_at": "2024-01-01"},
                        {"version": 2, "prompt": "p2", "created_at": "2024-01-02"},
                        {"version": 3, "prompt": "p3", "created_at": "2024-01-03"},
                    ],
                }
            },
            "videos": {
                "E1S01": {
                    "current_version": 2,
                    "versions": [
                        {"version": 1, "prompt": "vp1", "created_at": "2024-01-01"},
                        {"version": 2, "prompt": "vp2", "created_at": "2024-01-02"},
                    ],
                }
            },
        }
        _write_json(project_dir / "versions" / "versions.json", versions_data)
        return project_dir

    def test_export_scope_full_includes_version_history(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        self._create_project_with_versions(pm)
        service = ProjectArchiveService(pm)

        archive_path, _ = service.export_project("demo", scope="full")

        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            assert "demo/versions/storyboards/E1S01_v1.png" in names
            assert "demo/versions/storyboards/E1S01_v2.png" in names
            assert "demo/versions/videos/E1S01_v1.mp4" in names
            assert "demo/versions/characters/Hero_v1.png" in names
            assert "demo/versions/scenes/Temple_v1.png" in names
            assert "demo/versions/props/Key_v1.png" in names

    def test_export_scope_current_skips_version_history_files(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        self._create_project_with_versions(pm)
        service = ProjectArchiveService(pm)

        archive_path, _ = service.export_project("demo", scope="current")

        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            # 历史版本文件不应包含
            assert "demo/versions/storyboards/E1S01_v1.png" not in names
            assert "demo/versions/storyboards/E1S01_v2.png" not in names
            assert "demo/versions/videos/E1S01_v1.mp4" not in names
            assert "demo/versions/characters/Hero_v1.png" not in names
            assert "demo/versions/scenes/Temple_v1.png" not in names
            assert "demo/versions/props/Key_v1.png" not in names
            # 主资源应保留
            assert "demo/storyboards/scene_E1S01.png" in names
            assert "demo/videos/scene_E1S01.mp4" in names
            # versions.json 应保留（裁剪后）
            assert "demo/versions/versions.json" in names

    def test_export_scope_current_trims_versions_json(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        self._create_project_with_versions(pm)
        service = ProjectArchiveService(pm)

        archive_path, _ = service.export_project("demo", scope="current")

        with zipfile.ZipFile(archive_path) as archive:
            versions_content = json.loads(archive.read("demo/versions/versions.json"))
            # storyboards.E1S01 应只保留 version 3
            sb_versions = versions_content["storyboards"]["E1S01"]["versions"]
            assert len(sb_versions) == 1
            assert sb_versions[0]["version"] == 3
            assert sb_versions[0]["prompt"] == "p3"
            # videos.E1S01 应只保留 version 2
            vid_versions = versions_content["videos"]["E1S01"]["versions"]
            assert len(vid_versions) == 1
            assert vid_versions[0]["version"] == 2

    def test_export_scope_current_manifest_scope_field(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        self._create_project_with_versions(pm)
        service = ProjectArchiveService(pm)

        archive_path, _ = service.export_project("demo", scope="current")

        with zipfile.ZipFile(archive_path) as archive:
            manifest = json.loads(archive.read(f"demo/{ARCHIVE_MANIFEST_NAME}"))
            assert manifest["scope"] == "current"

    def test_export_scope_full_manifest_scope_field(self, tmp_path):
        pm = ProjectManager(tmp_path / "projects")
        self._create_project_with_versions(pm)
        service = ProjectArchiveService(pm)

        archive_path, _ = service.export_project("demo", scope="full")

        with zipfile.ZipFile(archive_path) as archive:
            manifest = json.loads(archive.read(f"demo/{ARCHIVE_MANIFEST_NAME}"))
            assert manifest["scope"] == "full"
