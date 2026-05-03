from __future__ import annotations

import asyncio
import html as html_lib
import json
import logging
import os
import secrets
import shutil
import stat
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from lib.content_workflows import get_workflow_preset
from lib.data_validator import DataValidator, ValidationResult
from lib.json_io import atomic_write_json, load_json
from lib.project_change_hints import emit_project_change_hint
from lib.project_manager import ProjectManager

logger = logging.getLogger(__name__)

ARCHIVE_MANIFEST_NAME = "arcreel-export.json"
DELIVERY_REPORT_JSON_NAME = "output/arcreel-delivery-report.json"
DELIVERY_REPORT_MARKDOWN_NAME = "output/arcreel-delivery-report.md"
TRAVEL_ROUTE_ASSETS_JSON_NAME = "output/scenelet-travel-route-assets.json"
TRAVEL_ROUTE_ASSETS_HTML_NAME = "output/scenelet-travel-route-assets.html"
MODEL_RULE_AUDIT_JSON_NAME = "output/scenelet-model-rule-audit.json"
MODEL_RULE_AUDIT_MARKDOWN_NAME = "output/scenelet-model-rule-audit.md"
ARCHIVE_FORMAT_VERSION = 2
ARCHIVE_SCRIPT_SCHEMA_VERSION = 2
DEFAULT_IMPORT_FILENAME = "imported-project.zip"
TRAVEL_REFERENCE_IMAGE_LIMIT = 10


@dataclass(frozen=True)
class ArchiveMember:
    info: zipfile.ZipInfo
    parts: tuple[str, ...]
    is_dir: bool


@dataclass(frozen=True)
class ArchiveDiagnostic:
    code: str
    message: str
    location: str | None = None

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "code": self.code,
            "message": self.message,
        }
        if self.location:
            payload["location"] = self.location
        return payload


@dataclass
class ArchiveDiagnostics:
    blocking: list[ArchiveDiagnostic] = field(default_factory=list)
    auto_fixed: list[ArchiveDiagnostic] = field(default_factory=list)
    warnings: list[ArchiveDiagnostic] = field(default_factory=list)
    _seen: set[tuple[str, str, str, str | None]] = field(
        default_factory=set,
        init=False,
        repr=False,
    )

    def add(
        self,
        bucket: str,
        code: str,
        message: str,
        *,
        location: str | None = None,
    ) -> None:
        key = (bucket, code, message, location)
        if key in self._seen:
            return
        self._seen.add(key)
        getattr(self, bucket).append(
            ArchiveDiagnostic(
                code=code,
                message=message,
                location=location,
            )
        )

    def extend_validation(self, validation: ValidationResult) -> None:
        for error in validation.errors:
            self.add("blocking", "validation_error", error)
        for warning in validation.warnings:
            self.add("warnings", "validation_warning", warning)

    def to_export_payload(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "blocking": [item.to_payload() for item in self.blocking],
            "auto_fixed": [item.to_payload() for item in self.auto_fixed],
            "warnings": [item.to_payload() for item in self.warnings],
        }

    def to_import_success_payload(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "auto_fixed": [item.to_payload() for item in self.auto_fixed],
            "warnings": [item.to_payload() for item in self.warnings],
        }

    def to_import_error_payload(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "blocking": [item.to_payload() for item in self.blocking],
            "auto_fixable": [item.to_payload() for item in self.auto_fixed],
            "warnings": [item.to_payload() for item in self.warnings],
        }

    def blocking_messages(self) -> list[str]:
        return [item.message for item in self.blocking]

    def warning_messages(self) -> list[str]:
        return [item.message for item in self.warnings]


@dataclass(frozen=True)
class ProjectImportResult:
    project_name: str
    project: dict[str, Any]
    warnings: list[str]
    conflict_resolution: str
    diagnostics: dict[str, list[dict[str, Any]]]


class ProjectArchiveValidationError(ValueError):
    def __init__(
        self,
        detail: str,
        *,
        status_code: int = 400,
        errors: list[str] | None = None,
        warnings: list[str] | None = None,
        diagnostics: dict[str, Any] | None = None,
        extra: dict[str, Any] | None = None,
    ):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code
        self.errors = errors or []
        self.warnings = warnings or []
        merged_extra = dict(extra or {})
        if diagnostics is not None:
            merged_extra["diagnostics"] = diagnostics
        self.extra = merged_extra


class ProjectArchiveService:
    _VERSION_HISTORY_DIRS = frozenset(
        {
            "storyboards",
            "videos",
            "characters",
            "scenes",
            "props",
            "reference_videos",
        }
    )
    _RESOURCE_EXTENSIONS = {
        "storyboards": ".png",
        "videos": ".mp4",
        "characters": ".png",
        "scenes": ".png",
        "props": ".png",
        "reference_videos": ".mp4",
    }
    _ROOT_VISIBLE_ENTRIES = frozenset(DataValidator.ALLOWED_ROOT_ENTRIES)
    _AGENT_RUNTIME_EXCLUDES = frozenset({".claude", "CLAUDE.md"})
    _PLACEHOLDER_CHARACTER_DESCRIPTION = "Imported placeholder character"

    def __init__(self, project_manager: ProjectManager):
        self.project_manager = project_manager
        self.validator = DataValidator(projects_root=str(project_manager.projects_root))

    def get_export_diagnostics(
        self,
        project_name: str,
        *,
        scope: str = "full",
    ) -> dict[str, list[dict[str, Any]]]:
        return self.get_export_preflight(project_name, scope=scope)["diagnostics"]

    def get_export_preflight(
        self,
        project_name: str,
        *,
        scope: str = "full",
    ) -> dict[str, Any]:
        self._validate_scope(scope)
        if not self.project_manager.project_exists(project_name):
            raise FileNotFoundError(f"项目 '{project_name}' 不存在或未初始化")

        temp_dir, _, manifest, diagnostics = self._prepare_export_snapshot(project_name, scope=scope)
        try:
            return {
                "diagnostics": diagnostics.to_export_payload(),
                "delivery_report": manifest.get("delivery_report"),
                "travel_route_assets": manifest.get("travel_route_assets"),
                "model_rule_audit": manifest.get("model_rule_audit"),
            }
        finally:
            temp_dir.cleanup()

    def export_project(self, project_name: str, *, scope: str = "full") -> tuple[Path, str]:
        self._validate_scope(scope)
        if not self.project_manager.project_exists(project_name):
            raise FileNotFoundError(f"项目 '{project_name}' 不存在或未初始化")

        fd, archive_path_str = tempfile.mkstemp(
            prefix=f"{project_name}-",
            suffix=".zip",
        )
        os.close(fd)
        archive_path = Path(archive_path_str)

        temp_dir: tempfile.TemporaryDirectory[str] | None = None
        try:
            temp_dir, snapshot_dir, manifest, _ = self._prepare_export_snapshot(
                project_name,
                scope=scope,
            )
            with zipfile.ZipFile(
                archive_path,
                mode="w",
                compression=zipfile.ZIP_DEFLATED,
            ) as archive:
                self._write_directory_entry(archive, (project_name,))
                archive.writestr(
                    f"{project_name}/{ARCHIVE_MANIFEST_NAME}",
                    json.dumps(
                        manifest,
                        ensure_ascii=False,
                        indent=2,
                    ),
                )
                delivery_report = manifest.get("delivery_report")
                if isinstance(delivery_report, dict):
                    archive.writestr(
                        f"{project_name}/{DELIVERY_REPORT_JSON_NAME}",
                        json.dumps(
                            delivery_report,
                            ensure_ascii=False,
                            indent=2,
                        ),
                    )
                    archive.writestr(
                        f"{project_name}/{DELIVERY_REPORT_MARKDOWN_NAME}",
                        self._render_delivery_report_markdown(delivery_report),
                    )
                travel_route_assets = manifest.get("travel_route_assets")
                if isinstance(travel_route_assets, dict):
                    archive.writestr(
                        f"{project_name}/{TRAVEL_ROUTE_ASSETS_JSON_NAME}",
                        json.dumps(
                            travel_route_assets,
                            ensure_ascii=False,
                            indent=2,
                        ),
                    )
                    archive.writestr(
                        f"{project_name}/{TRAVEL_ROUTE_ASSETS_HTML_NAME}",
                        self._render_travel_route_assets_html(travel_route_assets),
                    )
                model_rule_audit = manifest.get("model_rule_audit")
                if isinstance(model_rule_audit, dict):
                    archive.writestr(
                        f"{project_name}/{MODEL_RULE_AUDIT_JSON_NAME}",
                        json.dumps(
                            model_rule_audit,
                            ensure_ascii=False,
                            indent=2,
                        ),
                    )
                    archive.writestr(
                        f"{project_name}/{MODEL_RULE_AUDIT_MARKDOWN_NAME}",
                        self._render_model_rule_audit_markdown(model_rule_audit),
                    )
                self._write_snapshot_members(
                    archive,
                    snapshot_dir,
                    project_name=project_name,
                    scope=scope,
                )
        except Exception:
            archive_path.unlink(missing_ok=True)
            raise
        finally:
            if temp_dir is not None:
                temp_dir.cleanup()

        download_name = f"{project_name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
        return archive_path, download_name

    def import_project_archive(
        self,
        archive_path: Path,
        *,
        uploaded_filename: str | None = None,
        conflict_policy: str = "prompt",
    ) -> ProjectImportResult:
        if conflict_policy not in {"prompt", "rename", "overwrite"}:
            raise ProjectArchiveValidationError(
                "无效的冲突策略",
                errors=[f"conflict_policy 仅支持 prompt、rename 或 overwrite，收到: {conflict_policy}"],
            )

        try:
            with zipfile.ZipFile(archive_path) as archive:
                members = self._scan_archive_members(archive)
                root_parts, manifest = self._locate_project_root(archive, members)

                with tempfile.TemporaryDirectory(prefix="arcreel-import-") as temp_dir:
                    staging_dir = Path(temp_dir) / "project"
                    staging_dir.mkdir(parents=True, exist_ok=True)

                    self._extract_archive_root(
                        archive,
                        members,
                        root_parts,
                        staging_dir,
                    )

                    diagnostics = self._repair_project_tree(staging_dir)
                    diagnostics.extend_validation(self.validator.validate_project_tree(staging_dir))
                    if diagnostics.blocking:
                        raise ProjectArchiveValidationError(
                            "导入包校验失败",
                            errors=diagnostics.blocking_messages(),
                            warnings=diagnostics.warning_messages(),
                            diagnostics=diagnostics.to_import_error_payload(),
                        )

                    project = self._load_project_file(staging_dir / self.project_manager.PROJECT_FILE)
                    self._claim_imported_project(project, staging_dir / self.project_manager.PROJECT_FILE)
                    target_name = self._resolve_target_project_name(
                        project,
                        manifest=manifest,
                        root_parts=root_parts,
                        uploaded_filename=uploaded_filename,
                    )
                    target_name, conflict_resolution = self._resolve_conflict(
                        target_name,
                        project_title=str(project.get("title") or "").strip(),
                        conflict_policy=conflict_policy,
                    )

                    self._ensure_standard_subdirs(staging_dir)
                    self._install_project_dir(
                        staging_dir,
                        target_name,
                        overwrite=(conflict_policy == "overwrite"),
                    )

                    target_dir = self._target_project_dir(target_name)
                    self.project_manager.repair_claude_symlink(target_dir)

                    imported_project = self.project_manager.load_project(target_name)
                    emit_project_change_hint(
                        target_name,
                        source="webui",
                        changed_paths=[self.project_manager.PROJECT_FILE],
                        user_id=getattr(self.project_manager, "user_id", None),
                    )

                    return ProjectImportResult(
                        project_name=target_name,
                        project=imported_project,
                        warnings=diagnostics.warning_messages(),
                        conflict_resolution=conflict_resolution,
                        diagnostics=diagnostics.to_import_success_payload(),
                    )
        except zipfile.BadZipFile as exc:
            raise ProjectArchiveValidationError(
                "上传文件不是有效的 ZIP 归档",
                errors=[str(exc)],
            ) from exc

    def _prepare_export_snapshot(
        self,
        project_name: str,
        *,
        scope: str,
    ) -> tuple[tempfile.TemporaryDirectory[str], Path, dict[str, Any], ArchiveDiagnostics]:
        source_dir = self.project_manager.get_project_path(project_name)
        temp_dir = tempfile.TemporaryDirectory(prefix="arcreel-export-")
        snapshot_dir = Path(temp_dir.name) / project_name
        self._copy_visible_tree(source_dir, snapshot_dir)

        diagnostics = self._repair_project_tree(snapshot_dir)
        diagnostics.extend_validation(self.validator.validate_project_tree(snapshot_dir))

        # 从源目录收集非标准顶层条目，记录到诊断中（即使已被过滤不导出）
        excluded_entries = self._collect_pass_through_entries(source_dir)
        for entry in excluded_entries:
            diagnostics.add(
                "warnings",
                "non_standard_entry_excluded",
                f"非标准顶层目录/文件 '{entry}' 未包含在导出中",
                location=entry,
            )

        snapshot_project = self._load_json_file(snapshot_dir / self.project_manager.PROJECT_FILE)
        if isinstance(snapshot_project, dict):
            self._append_travel_video_export_checks(snapshot_project, snapshot_dir, diagnostics)
        manifest = self._build_archive_manifest(
            project_name,
            snapshot_project,
            project_dir=snapshot_dir,
            scope=scope,
            diagnostics=diagnostics.to_export_payload(),
            pass_through_entries=excluded_entries,
        )
        return temp_dir, snapshot_dir, manifest, diagnostics

    def _build_archive_manifest(
        self,
        project_name: str,
        project: dict[str, Any] | None,
        *,
        project_dir: Path,
        scope: str,
        diagnostics: dict[str, Any],
        pass_through_entries: list[str],
    ) -> dict[str, Any]:
        project_payload = project or {}
        content_type = project_payload.get("content_type") if isinstance(project_payload.get("content_type"), str) else None
        workflow_preset = get_workflow_preset(content_type)
        content_mode = workflow_preset.content_mode if workflow_preset else project_payload.get("content_mode", "")
        delivery_report = self._build_delivery_report(project_dir, project_payload)
        model_rule_audit = self._build_model_rule_audit(project_name)
        delivery_report["model_rule_audit"] = self._model_rule_audit_delivery_summary(model_rule_audit)
        manifest = {
            "format_version": ARCHIVE_FORMAT_VERSION,
            "script_schema_version": ARCHIVE_SCRIPT_SCHEMA_VERSION,
            "project_name": project_name,
            "project_title": project_payload.get("title", project_name),
            "content_type": content_type,
            "content_mode": content_mode,
            "aspect_ratio": project_payload.get("aspect_ratio") or (workflow_preset.aspect_ratio if workflow_preset else None),
            "generation_mode": project_payload.get("generation_mode") or (
                workflow_preset.generation_mode if workflow_preset else None
            ),
            "scope": scope,
            "exported_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "export_diagnostics": diagnostics,
            "delivery_report": delivery_report,
            "model_rule_audit": model_rule_audit,
            "pass_through_entries": pass_through_entries,
        }
        travel_route_assets = self._build_travel_route_asset_manifest(
            project_dir,
            project_payload,
            delivery_report,
        )
        if travel_route_assets is not None:
            manifest["travel_route_assets"] = travel_route_assets
        return manifest

    def _build_delivery_report(
        self,
        project_dir: Path,
        project: dict[str, Any],
    ) -> dict[str, Any]:
        episodes = project.get("episodes") if isinstance(project.get("episodes"), list) else []
        episode_reports = [
            self._build_episode_delivery_report(project_dir, episode)
            for episode in episodes
            if isinstance(episode, dict)
        ]
        totals = {
            "episodes": len(episode_reports),
            "ready_episodes": sum(1 for episode in episode_reports if episode["status"] == "ready"),
            "scripts_ready": sum(1 for episode in episode_reports if episode["script_ready"]),
            "storyboards_ready": sum(episode["storyboards"]["ready"] for episode in episode_reports),
            "storyboards_total": sum(episode["storyboards"]["total"] for episode in episode_reports),
            "videos_ready": sum(episode["videos"]["ready"] for episode in episode_reports),
            "videos_total": sum(episode["videos"]["total"] for episode in episode_reports),
            "blocking_issues": sum(len(episode["blocking_issues"]) for episode in episode_reports),
            "warnings": sum(len(episode["warnings"]) for episode in episode_reports),
        }
        status = (
            "needs_work"
            if totals["blocking_issues"] > 0
            else "ready_with_warnings"
            if totals["warnings"] > 0
            else "ready"
        )
        report = {
            "format_version": 1,
            "status": status,
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "totals": totals,
            "episodes": episode_reports,
        }
        travel_route_report = self._build_travel_route_delivery_report(project_dir, project)
        if travel_route_report is not None:
            report["travel_route"] = travel_route_report
        return report

    def _build_episode_delivery_report(
        self,
        project_dir: Path,
        episode: dict[str, Any],
    ) -> dict[str, Any]:
        episode_number = episode.get("episode")
        title = str(episode.get("title") or f"Episode {episode_number or ''}").strip()
        script_file = episode.get("script_file") if isinstance(episode.get("script_file"), str) else ""
        script_path = project_dir / script_file if script_file else project_dir / "__missing_script__.json"
        script = self._load_json_file(script_path)
        blocking_issues: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = []

        if not script_file or script is None:
            blocking_issues.append(
                {
                    "code": "missing_script",
                    "message": "分集剧本缺失或无法解析",
                    "location": script_file or "project.json episodes[].script_file",
                }
            )
            return {
                "episode": episode_number,
                "title": title,
                "script_file": script_file,
                "script_ready": False,
                "status": "needs_work",
                "storyboards": {"ready": 0, "total": 0, "missing": []},
                "videos": {"ready": 0, "total": 0, "missing": []},
                "blocking_issues": blocking_issues,
                "warnings": warnings,
            }

        items, mode = self._delivery_items_from_script(script)
        storyboards_total = 0 if mode == "reference_video" else len(items)
        storyboards_ready = 0 if mode == "reference_video" else sum(1 for item in items if item["has_storyboard"])
        missing_storyboards = [] if mode == "reference_video" else [
            item["id"] for item in items if not item["has_storyboard"]
        ]
        videos_ready = sum(1 for item in items if item["has_video"])
        missing_videos = [item["id"] for item in items if not item["has_video"]]
        missing_thumbnails = [
            item["id"]
            for item in items
            if item["has_video"] and not item["has_thumbnail"]
        ]

        if missing_storyboards:
            blocking_issues.append(
                {
                    "code": "missing_storyboards",
                    "message": f"{len(missing_storyboards)} 个分镜/宫格未生成",
                    "items": missing_storyboards,
                }
            )
        if missing_videos:
            blocking_issues.append(
                {
                    "code": "missing_videos",
                    "message": f"{len(missing_videos)} 个视频未生成",
                    "items": missing_videos,
                }
            )
        if missing_thumbnails:
            warnings.append(
                {
                    "code": "missing_video_thumbnails",
                    "message": f"{len(missing_thumbnails)} 个视频缺少缩略图",
                    "items": missing_thumbnails,
                }
            )

        return {
            "episode": episode_number,
            "title": title,
            "script_file": script_file,
            "script_ready": True,
            "status": "needs_work" if blocking_issues else "ready",
            "storyboards": {
                "ready": storyboards_ready,
                "total": storyboards_total,
                "missing": missing_storyboards,
            },
            "videos": {
                "ready": videos_ready,
                "total": len(items),
                "missing": missing_videos,
            },
            "blocking_issues": blocking_issues,
            "warnings": warnings,
        }

    @staticmethod
    def _delivery_items_from_script(script: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
        content_mode = script.get("content_mode")
        if content_mode == "reference_video" or isinstance(script.get("video_units"), list):
            raw_items = script.get("video_units") if isinstance(script.get("video_units"), list) else []
            return [
                ProjectArchiveService._delivery_item(
                    item,
                    id_field="unit_id",
                    storyboard_required=False,
                )
                for item in raw_items
                if isinstance(item, dict)
            ], "reference_video"

        if content_mode == "drama":
            raw_items = script.get("scenes") if isinstance(script.get("scenes"), list) else []
            return [
                ProjectArchiveService._delivery_item(item, id_field="scene_id")
                for item in raw_items
                if isinstance(item, dict)
            ], "drama"

        raw_items = script.get("segments") if isinstance(script.get("segments"), list) else []
        return [
            ProjectArchiveService._delivery_item(item, id_field="segment_id")
            for item in raw_items
            if isinstance(item, dict)
        ], "narration"

    @staticmethod
    def _delivery_item(
        item: dict[str, Any],
        *,
        id_field: str,
        storyboard_required: bool = True,
    ) -> dict[str, Any]:
        assets = item.get("generated_assets") if isinstance(item.get("generated_assets"), dict) else {}
        item_id = str(item.get(id_field) or item.get("id") or "unknown")
        return {
            "id": item_id,
            "has_storyboard": not storyboard_required or bool(assets.get("storyboard_image")),
            "has_video": bool(assets.get("video_clip")),
            "has_thumbnail": bool(assets.get("video_thumbnail")),
        }

    def _build_travel_route_delivery_report(
        self,
        project_dir: Path,
        project: dict[str, Any],
    ) -> dict[str, Any] | None:
        if project.get("content_type") != "travel_video":
            return None

        settings = project.get("travel_video_settings")
        if not isinstance(settings, dict):
            settings = {}
        route_preview = settings.get("route_preview")
        preview = route_preview if isinstance(route_preview, dict) else {}
        raw_nodes = preview.get("nodes") if isinstance(preview.get("nodes"), list) else []
        nodes = [node for node in raw_nodes if isinstance(node, dict)]
        unit_texts = self._collect_travel_video_unit_texts(project_dir, project)
        node_reports: list[dict[str, Any]] = []

        for index, node in enumerate(nodes, start=1):
            matched_units = [
                unit["id"]
                for unit in unit_texts
                if self._travel_route_node_matches_unit(node, unit["text"])
            ]
            node_reports.append(
                {
                    "id": self._text(node.get("id")) or f"node-{index}",
                    "label": self._text(node.get("label")) or f"路线节点 {index}",
                    "instruction": self._text(node.get("instruction")) or None,
                    "source": self._text(node.get("source")) or None,
                    "covered": len(matched_units) > 0,
                    "matched_units": matched_units,
                }
            )

        refs = self._travel_reference_images(settings, include_preview=True)
        usable_refs = [ref for ref in refs if self._is_usable_travel_reference(project_dir, ref)]
        origin = self._text(settings.get("origin") or preview.get("origin"))
        destination = self._text(settings.get("destination") or preview.get("destination"))
        route_notes = self._text(settings.get("route_notes"))
        summary = self._text(preview.get("summary")) or route_notes
        if not summary and (origin or destination):
            summary = " → ".join(part for part in (origin, destination) if part)

        return {
            "route_ready": bool(preview.get("route_ready")),
            "source": self._text(preview.get("source") or settings.get("route_source")) or None,
            "origin": origin or None,
            "destination": destination or None,
            "summary": summary or None,
            "distance_text": self._text(preview.get("distance_text")) or None,
            "duration_text": self._text(preview.get("duration_text")) or None,
            "nodes_total": len(node_reports),
            "nodes_covered": sum(1 for node in node_reports if node["covered"]),
            "reference_images_count": len(refs),
            "usable_reference_images_count": len(usable_refs),
            "nodes": node_reports,
        }

    def _build_travel_route_asset_manifest(
        self,
        project_dir: Path,
        project: dict[str, Any],
        delivery_report: dict[str, Any],
    ) -> dict[str, Any] | None:
        if project.get("content_type") != "travel_video":
            return None

        route_report = delivery_report.get("travel_route")
        if not isinstance(route_report, dict):
            return None

        settings = project.get("travel_video_settings")
        if not isinstance(settings, dict):
            settings = {}
        route_preview = settings.get("route_preview")
        preview = route_preview if isinstance(route_preview, dict) else {}
        raw_nodes = preview.get("nodes") if isinstance(preview.get("nodes"), list) else []
        preview_nodes = [node for node in raw_nodes if isinstance(node, dict)]
        preview_nodes_by_id = {
            self._text(node.get("id")): node
            for node in preview_nodes
            if self._text(node.get("id"))
        }
        refs = self._travel_reference_images(settings, include_preview=True)
        route_nodes = route_report.get("nodes") if isinstance(route_report.get("nodes"), list) else []
        unit_details_by_id = {
            unit["id"]: self._travel_route_unit_detail(unit)
            for unit in self._collect_travel_video_unit_texts(project_dir, project)
            if isinstance(unit.get("id"), str) and unit.get("id")
        }
        node_assets: list[dict[str, Any]] = []

        for index, route_node in enumerate(route_nodes):
            if not isinstance(route_node, dict):
                continue
            node_id = self._text(route_node.get("id")) or f"node-{index + 1}"
            preview_node = preview_nodes_by_id.get(node_id)
            if preview_node is None and index < len(preview_nodes):
                preview_node = preview_nodes[index]
            node_refs = [
                ref
                for ref in refs
                if self._travel_reference_matches_node(ref, route_node)
                or (isinstance(preview_node, dict) and self._travel_reference_matches_node(ref, preview_node))
            ]
            matched_units = [
                item
                for item in route_node.get("matched_units", [])
                if isinstance(item, str) and item.strip()
            ]
            matched_unit_details = [
                unit_details_by_id.get(unit_id, {"id": unit_id})
                for unit_id in matched_units
            ]
            node_payload: dict[str, Any] = {
                "id": node_id,
                "label": self._text(route_node.get("label")) or f"路线节点 {index + 1}",
                "instruction": self._text(route_node.get("instruction")) or None,
                "source": self._text(route_node.get("source")) or None,
                "covered": bool(route_node.get("covered")),
                "matched_units": matched_units,
                "matched_unit_details": matched_unit_details,
                "reference_images": node_refs,
            }
            if isinstance(preview_node, dict):
                for text_field in ("distance_text", "duration_text", "street_view_status", "pano_id"):
                    value = self._text(preview_node.get(text_field))
                    if value:
                        node_payload[text_field] = value
                for numeric_field in ("lat", "lng", "heading", "street_view_lat", "street_view_lng"):
                    value = preview_node.get(numeric_field)
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        node_payload[numeric_field] = value
            node_assets.append(node_payload)

        reference_assets: list[dict[str, Any]] = []
        for index, ref in enumerate(refs, start=1):
            usable = self._is_usable_travel_reference(project_dir, ref)
            is_remote = "://" in ref
            used_by_nodes = [
                node["id"]
                for node in node_assets
                if ref in node.get("reference_images", [])
            ]
            reference_assets.append(
                {
                    "id": f"reference-{index}",
                    "path": ref,
                    "kind": "remote" if is_remote else "local",
                    "usable": usable,
                    "archive_path": ref if usable and not is_remote else None,
                    "html_src": ref if is_remote else f"../{ref}" if usable else None,
                    "used_by_nodes": used_by_nodes,
                }
            )

        return {
            "format_version": 1,
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "route": {
                "route_ready": bool(route_report.get("route_ready")),
                "source": self._text(route_report.get("source")) or None,
                "origin": self._text(route_report.get("origin")) or None,
                "destination": self._text(route_report.get("destination")) or None,
                "summary": self._text(route_report.get("summary")) or None,
                "distance_text": self._text(route_report.get("distance_text")) or None,
                "duration_text": self._text(route_report.get("duration_text")) or None,
            },
            "node_coverage": {
                "total": len(node_assets),
                "covered": sum(1 for node in node_assets if node["covered"]),
                "missing": [
                    node["id"]
                    for node in node_assets
                    if not node["covered"]
                ],
            },
            "reference_images": {
                "total": len(reference_assets),
                "usable": sum(1 for ref in reference_assets if ref["usable"]),
                "items": reference_assets,
            },
            "nodes": node_assets,
        }

    def _build_model_rule_audit(self, project_name: str) -> dict[str, Any]:
        try:
            tasks = self._load_model_rule_audit_tasks(project_name)
        except Exception:
            logger.warning(
                "Failed to build model rule audit for project %s",
                project_name,
                exc_info=True,
            )
            tasks = []
        return self._model_rule_audit_from_tasks(project_name, tasks)

    def _load_model_rule_audit_tasks(self, project_name: str) -> list[dict[str, Any]]:
        user_id = getattr(self.project_manager, "user_id", None)
        from lib import PROJECT_ROOT

        if self.project_manager.projects_root.resolve() != (PROJECT_ROOT / "projects").resolve():
            return []

        async def load() -> list[dict[str, Any]]:
            from lib.db.engine import safe_session_factory
            from lib.db.repositories.task_repo import TaskRepository

            async with safe_session_factory() as session:
                repo = TaskRepository(session)
                result = await repo.list_tasks(
                    project_name=project_name,
                    user_id=user_id,
                    page=1,
                    page_size=500,
                )
                items = result.get("items")
                return items if isinstance(items, list) else []

        return self._run_async(load)

    @staticmethod
    def _run_async(coro_factory):
        def run():
            from lib.db.engine import dispose_pool

            dispose_pool()
            return asyncio.run(coro_factory())

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop is not None and loop.is_running():
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                return pool.submit(run).result()
        return run()

    @classmethod
    def _model_rule_audit_from_tasks(
        cls,
        project_name: str,
        tasks: list[dict[str, Any]],
    ) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        for task in tasks:
            if not isinstance(task, dict):
                continue
            payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
            summary = payload.get("model_rule_summary") if isinstance(payload.get("model_rule_summary"), dict) else None
            if not summary:
                continue
            item = cls._model_rule_audit_item(task, summary)
            if item is not None:
                items.append(item)

        items.sort(
            key=lambda item: cls._text(item.get("updated_at") or item.get("queued_at")),
            reverse=True,
        )
        by_mode = cls._count_audit_items(items, ("rule", "mode"))
        by_media_type = cls._count_audit_items(items, ("rule", "media_type"))
        return {
            "format_version": 1,
            "project_name": project_name,
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "total": len(items),
            "by_mode": by_mode,
            "by_media_type": by_media_type,
            "items": items,
        }

    @classmethod
    def _model_rule_audit_item(
        cls,
        task: dict[str, Any],
        summary: dict[str, Any],
    ) -> dict[str, Any] | None:
        task_id = cls._text(task.get("task_id"))
        if not task_id:
            return None
        task_type = cls._text(task.get("task_type") or summary.get("task_type"))
        media_type = cls._text(summary.get("media_type") or task.get("media_type"))
        mode = cls._text(summary.get("mode")) or "default"
        rule: dict[str, Any] = {
            "media_type": media_type or None,
            "rule_target": cls._text(summary.get("rule_target")) or None,
            "mode": mode,
            "mode_label": cls._text(summary.get("mode_label")) or cls._model_rule_mode_label(mode),
            "provider_id": cls._text(summary.get("provider_id")) or None,
            "model_id": cls._text(summary.get("model_id")) or None,
            "target_label": cls._text(summary.get("target_label")) or None,
            "skill_name": cls._text(summary.get("skill_name")) or None,
            "billing_mode": cls._text(summary.get("billing_mode")) or None,
        }
        return {
            "task_id": task_id,
            "task_type": task_type or None,
            "media_type": media_type or None,
            "resource_id": cls._text(task.get("resource_id")) or None,
            "script_file": cls._text(task.get("script_file")) or None,
            "status": cls._text(task.get("status")) or None,
            "source": cls._text(task.get("source")) or None,
            "queued_at": cls._text(task.get("queued_at")) or None,
            "started_at": cls._text(task.get("started_at")) or None,
            "finished_at": cls._text(task.get("finished_at")) or None,
            "updated_at": cls._text(task.get("updated_at")) or None,
            "rule": rule,
        }

    @classmethod
    def _count_audit_items(
        cls,
        items: list[dict[str, Any]],
        path: tuple[str, str],
    ) -> dict[str, int]:
        counts: dict[str, int] = {}
        parent_key, child_key = path
        for item in items:
            parent = item.get(parent_key) if isinstance(item.get(parent_key), dict) else {}
            value = cls._text(parent.get(child_key)) or "unknown"
            counts[value] = counts.get(value, 0) + 1
        return counts

    @classmethod
    def _model_rule_audit_delivery_summary(cls, audit: dict[str, Any]) -> dict[str, Any]:
        return {
            "total": int(audit.get("total") or 0),
            "by_mode": audit.get("by_mode") if isinstance(audit.get("by_mode"), dict) else {},
            "by_media_type": audit.get("by_media_type") if isinstance(audit.get("by_media_type"), dict) else {},
            "artifact_files": [
                MODEL_RULE_AUDIT_JSON_NAME,
                MODEL_RULE_AUDIT_MARKDOWN_NAME,
            ],
        }

    @staticmethod
    def _model_rule_mode_label(mode: str) -> str:
        return {
            "default": "默认规则",
            "prompt": "Prompt",
            "github_skill": "GitHub Skill",
            "uploaded_skill": "上传 Skill",
        }.get(mode, mode or "默认规则")

    def _collect_travel_video_unit_texts(
        self,
        project_dir: Path,
        project: dict[str, Any],
    ) -> list[dict[str, Any]]:
        units: list[dict[str, Any]] = []
        episodes = project.get("episodes") if isinstance(project.get("episodes"), list) else []
        for episode in episodes:
            if not isinstance(episode, dict):
                continue
            script_file = episode.get("script_file")
            if not isinstance(script_file, str) or not script_file.strip():
                continue
            episode_number = self._episode_number(episode.get("episode"))
            episode_title = self._text(episode.get("title"))
            script = self._load_json_file(project_dir / script_file)
            if not isinstance(script, dict):
                continue
            raw_units = script.get("video_units") if isinstance(script.get("video_units"), list) else []
            for unit in raw_units:
                if not isinstance(unit, dict):
                    continue
                unit_id = self._text(unit.get("unit_id") or unit.get("id")) or "unknown"
                parts = [unit_id, self._text(unit.get("note"))]
                shots = unit.get("shots") if isinstance(unit.get("shots"), list) else []
                for shot in shots:
                    if isinstance(shot, dict):
                        parts.append(self._text(shot.get("text")))
                generated_assets = unit.get("generated_assets") if isinstance(unit.get("generated_assets"), dict) else {}
                entry: dict[str, Any] = {
                    "id": unit_id,
                    "text": " ".join(part for part in parts if part),
                    "script_file": script_file.strip(),
                }
                if episode_number is not None:
                    entry["episode"] = episode_number
                if episode_title:
                    entry["title"] = episode_title
                video_clip = self._text(generated_assets.get("video_clip"))
                if video_clip:
                    entry["video_clip"] = video_clip
                video_thumbnail = self._text(generated_assets.get("video_thumbnail"))
                if video_thumbnail:
                    entry["video_thumbnail"] = video_thumbnail
                status = self._text(generated_assets.get("status"))
                if status:
                    entry["status"] = status
                units.append(entry)
        return units

    @staticmethod
    def _episode_number(value: Any) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            text = value.strip()
            if text.isdigit():
                return int(text)
        return None

    @classmethod
    def _travel_route_unit_detail(cls, unit: dict[str, Any]) -> dict[str, Any]:
        detail: dict[str, Any] = {"id": cls._text(unit.get("id"))}
        episode = cls._episode_number(unit.get("episode"))
        if episode is not None:
            detail["episode"] = episode
        for field_name in ("title", "script_file", "video_clip", "video_thumbnail", "status"):
            value = cls._text(unit.get(field_name))
            if value:
                detail[field_name] = value
        return detail

    @classmethod
    def _travel_route_node_matches_unit(cls, node: dict[str, Any], unit_text: str) -> bool:
        text = cls._normalize_travel_match_text(unit_text)
        if not text:
            return False
        for field_name in ("label", "instruction"):
            value = cls._normalize_travel_match_text(cls._text(node.get(field_name)))
            if value and value in text:
                return True
        return False

    @staticmethod
    def _normalize_travel_match_text(value: str) -> str:
        return "".join(str(value or "").lower().split())

    @classmethod
    def _travel_reference_matches_node(cls, ref: str, node: dict[str, Any]) -> bool:
        normalized_ref = cls._normalize_travel_match_text(ref.replace("\\", "/"))
        if not normalized_ref:
            return False

        candidates: list[str] = []
        for field_name in ("instruction", "reference_image", "image", "thumbnail", "path"):
            value = node.get(field_name)
            if isinstance(value, str):
                candidates.append(value.replace("\\", "/"))

        raw_refs = node.get("reference_images")
        if isinstance(raw_refs, list):
            candidates.extend(
                item.replace("\\", "/")
                for item in raw_refs
                if isinstance(item, str)
            )

        for candidate in candidates:
            normalized_candidate = cls._normalize_travel_match_text(candidate)
            if normalized_candidate == normalized_ref or normalized_ref in normalized_candidate:
                return True
        return False

    @classmethod
    def _render_travel_route_assets_html(cls, manifest: dict[str, Any]) -> str:
        route = manifest.get("route") if isinstance(manifest.get("route"), dict) else {}
        coverage = manifest.get("node_coverage") if isinstance(manifest.get("node_coverage"), dict) else {}
        refs = manifest.get("reference_images") if isinstance(manifest.get("reference_images"), dict) else {}
        ref_items = refs.get("items") if isinstance(refs.get("items"), list) else []
        nodes = manifest.get("nodes") if isinstance(manifest.get("nodes"), list) else []

        def esc(value: Any) -> str:
            return html_lib.escape(str(value or ""), quote=True)

        def stat(label: str, value: Any) -> str:
            return (
                '<div class="stat">'
                f'<span>{esc(label)}</span>'
                f'<strong>{esc(value)}</strong>'
                "</div>"
            )

        node_cards: list[str] = []
        for index, node in enumerate(nodes, start=1):
            if not isinstance(node, dict):
                continue
            covered = bool(node.get("covered"))
            matched_units = node.get("matched_units") if isinstance(node.get("matched_units"), list) else []
            matched_unit_details = node.get("matched_unit_details") if isinstance(node.get("matched_unit_details"), list) else []
            unit_details_by_id = {
                item.get("id"): item
                for item in matched_unit_details
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            reference_images = node.get("reference_images") if isinstance(node.get("reference_images"), list) else []
            matched_pills: list[str] = []
            for unit in matched_units:
                if not isinstance(unit, str) or not unit.strip():
                    continue
                detail = unit_details_by_id.get(unit)
                extra = ""
                if isinstance(detail, dict):
                    episode = detail.get("episode")
                    title = esc(detail.get("title"))
                    if isinstance(episode, int) and not isinstance(episode, bool):
                        extra = f" · E{episode}"
                    if title:
                        extra = f"{extra} · {title}" if extra else f" · {title}"
                matched_pills.append(f'<span class="pill">{esc(unit)}{extra}</span>')
            matched_html = "".join(matched_pills) or '<span class="muted">未匹配视频单元</span>'
            refs_html = "".join(
                f'<span class="pill soft">{esc(ref)}</span>'
                for ref in reference_images
                if isinstance(ref, str) and ref.strip()
            ) or '<span class="muted">未绑定参考图</span>'
            node_meta = " · ".join(
                part
                for part in (
                    esc(node.get("source") or "unknown"),
                    esc(node.get("distance_text")),
                    esc(node.get("duration_text")),
                    esc(node.get("street_view_status")),
                )
                if part
            )
            node_cards.append(
                '<article class="card node-card">'
                '<div class="card-head">'
                f'<span class="index">{index:02d}</span>'
                f'<span class="badge {"ok" if covered else "warn"}">{"已覆盖" if covered else "未覆盖"}</span>'
                "</div>"
                f'<h3>{esc(node.get("label") or node.get("id") or f"路线节点 {index}")}</h3>'
                f'<p class="instruction">{esc(node.get("instruction") or "暂无节点说明")}</p>'
                f'<p class="meta">{node_meta or "无额外路线元数据"}</p>'
                '<div class="section-label">匹配视频单元</div>'
                f'<div class="pill-row">{matched_html}</div>'
                '<div class="section-label">关联参考图</div>'
                f'<div class="pill-row">{refs_html}</div>'
                "</article>"
            )

        ref_cards: list[str] = []
        for item in ref_items:
            if not isinstance(item, dict):
                continue
            path = item.get("path")
            html_src = item.get("html_src")
            usable = bool(item.get("usable"))
            used_by_nodes = item.get("used_by_nodes") if isinstance(item.get("used_by_nodes"), list) else []
            used_by_html = ", ".join(
                esc(node_id)
                for node_id in used_by_nodes
                if isinstance(node_id, str) and node_id.strip()
            ) or "未绑定节点"
            preview = (
                f'<img src="{esc(html_src)}" alt="{esc(path)}">'
                if isinstance(html_src, str) and html_src.strip()
                else '<div class="missing-preview">未打包或不可预览</div>'
            )
            ref_cards.append(
                '<article class="card ref-card">'
                f'<div class="thumb">{preview}</div>'
                f'<span class="badge {"ok" if usable else "warn"}">{"可用" if usable else "缺失"}</span>'
                f'<h3>{esc(path)}</h3>'
                f'<p class="meta">类型: {esc(item.get("kind") or "local")}</p>'
                f'<p class="meta">关联节点: {used_by_html}</p>'
                "</article>"
            )

        if not node_cards:
            node_cards.append('<div class="empty">暂无路线节点。</div>')
        if not ref_cards:
            ref_cards.append('<div class="empty">暂无参考图。</div>')

        route_status = "已预检" if route.get("route_ready") else "未通过/未预检"
        origin_destination = " / ".join(
            part
            for part in (
                esc(route.get("origin") or "-"),
                esc(route.get("destination") or "-"),
            )
            if part
        )
        stats_html = "".join(
            [
                stat("路线状态", route_status),
                stat("路线节点覆盖", f"{coverage.get('covered', 0)} / {coverage.get('total', 0)}"),
                stat("参考图数量", f"{refs.get('usable', 0)} / {refs.get('total', 0)} 可用"),
                stat("路线来源", route.get("source") or "-"),
            ]
        )

        return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Scenelet 旅游路线素材清单</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #070b14;
      --panel: #101827;
      --panel-soft: #152033;
      --border: #243247;
      --text: #edf4ff;
      --muted: #8fa0b8;
      --accent: #77e0c6;
      --warn: #ffc36b;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    main {{
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 24px 48px;
    }}
    header {{
      display: grid;
      gap: 12px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }}
    h1, h2, h3, p {{ margin: 0; }}
    h1 {{ font-size: 28px; }}
    h2 {{ margin: 28px 0 12px; font-size: 18px; }}
    h3 {{ margin-top: 10px; font-size: 14px; word-break: break-word; }}
    .summary {{ color: var(--muted); max-width: 820px; }}
    .stats {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-top: 16px;
    }}
    .stat, .card {{
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 10px;
    }}
    .stat {{ padding: 12px; }}
    .stat span, .meta, .muted {{ color: var(--muted); }}
    .stat strong {{ display: block; margin-top: 4px; font-size: 18px; }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 12px;
    }}
    .card {{ padding: 14px; }}
    .card-head {{ display: flex; align-items: center; justify-content: space-between; gap: 8px; }}
    .index {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }}
    .badge {{
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      border: 1px solid currentColor;
    }}
    .badge.ok {{ color: var(--accent); background: rgba(119, 224, 198, .1); }}
    .badge.warn {{ color: var(--warn); background: rgba(255, 195, 107, .1); }}
    .instruction {{ margin-top: 8px; color: #cbd7ea; min-height: 48px; }}
    .section-label {{ margin-top: 12px; color: var(--muted); font-size: 12px; }}
    .pill-row {{ display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }}
    .pill {{
      border-radius: 6px;
      padding: 3px 7px;
      background: rgba(119, 224, 198, .12);
      color: #b8f7e8;
      font-size: 12px;
      word-break: break-all;
    }}
    .pill.soft {{ background: rgba(143, 160, 184, .14); color: #d3dceb; }}
    .thumb {{
      position: relative;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--panel-soft);
    }}
    .thumb img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
    .missing-preview {{
      height: 100%;
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 13px;
    }}
    .ref-card .badge {{ margin-top: 10px; }}
    .empty {{
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 18px;
      color: var(--muted);
      background: rgba(16, 24, 39, .5);
    }}
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Scenelet 旅游路线素材清单</h1>
      <p class="summary">{esc(route.get("summary") or "暂无路线摘要")}</p>
      <p class="meta">出发地 / 目的地: {origin_destination}</p>
      <p class="meta">路线距离 / 预计时长: {esc(route.get("distance_text") or "-")} / {esc(route.get("duration_text") or "-")}</p>
      <div class="stats">{stats_html}</div>
    </header>

    <section>
      <h2>路线节点覆盖</h2>
      <div class="grid">{"".join(node_cards)}</div>
    </section>

    <section>
      <h2>参考图清单</h2>
      <div class="grid">{"".join(ref_cards)}</div>
    </section>
  </main>
</body>
</html>
"""

    @staticmethod
    def _render_delivery_report_markdown(report: dict[str, Any]) -> str:
        totals = report.get("totals") if isinstance(report.get("totals"), dict) else {}
        status_label = {
            "ready": "可交付",
            "ready_with_warnings": "可交付（有提醒）",
            "needs_work": "需处理",
        }.get(str(report.get("status")), str(report.get("status") or "未知"))
        lines = [
            "# Scenelet 交付检查报告",
            "",
            f"- 交付状态: {status_label}",
            f"- 分集: {totals.get('ready_episodes', 0)} / {totals.get('episodes', 0)}",
            f"- 剧本: {totals.get('scripts_ready', 0)} / {totals.get('episodes', 0)}",
            f"- 分镜/宫格: {totals.get('storyboards_ready', 0)} / {totals.get('storyboards_total', 0)}",
            f"- 视频: {totals.get('videos_ready', 0)} / {totals.get('videos_total', 0)}",
            f"- 阻断项: {totals.get('blocking_issues', 0)}",
            f"- 提醒项: {totals.get('warnings', 0)}",
            "",
        ]
        travel_route = report.get("travel_route") if isinstance(report.get("travel_route"), dict) else None
        if travel_route:
            lines.extend(ProjectArchiveService._render_travel_route_report_markdown(travel_route))
            lines.append("")
        model_rule_audit = report.get("model_rule_audit") if isinstance(report.get("model_rule_audit"), dict) else None
        if model_rule_audit:
            lines.extend(ProjectArchiveService._render_model_rule_audit_report_markdown(model_rule_audit))
            lines.append("")
        lines.extend(["## 分集明细", ""])
        episodes = report.get("episodes") if isinstance(report.get("episodes"), list) else []
        for episode in episodes:
            if not isinstance(episode, dict):
                continue
            lines.append(f"### E{episode.get('episode')} {episode.get('title', '')}")
            lines.append(f"- 状态: {episode.get('status')}")
            storyboards = episode.get("storyboards") if isinstance(episode.get("storyboards"), dict) else {}
            videos = episode.get("videos") if isinstance(episode.get("videos"), dict) else {}
            lines.append(f"- 分镜/宫格: {storyboards.get('ready', 0)} / {storyboards.get('total', 0)}")
            lines.append(f"- 视频: {videos.get('ready', 0)} / {videos.get('total', 0)}")
            for bucket_key, bucket_title in (("blocking_issues", "阻断"), ("warnings", "提醒")):
                bucket = episode.get(bucket_key) if isinstance(episode.get(bucket_key), list) else []
                for item in bucket:
                    if isinstance(item, dict):
                        lines.append(f"- {bucket_title}: {item.get('message')}")
            lines.append("")
        return "\n".join(lines)

    @classmethod
    def _render_model_rule_audit_markdown(cls, audit: dict[str, Any]) -> str:
        total = int(audit.get("total") or 0)
        by_mode = audit.get("by_mode") if isinstance(audit.get("by_mode"), dict) else {}
        by_media = audit.get("by_media_type") if isinstance(audit.get("by_media_type"), dict) else {}
        lines = [
            "# Scenelet 模型规则审计",
            "",
            f"- 项目: {audit.get('project_name') or '-'}",
            f"- 生成时间: {audit.get('generated_at') or '-'}",
            f"- 记录任务: {total}",
            f"- 规则来源: {cls._render_counter_summary(by_mode, labeler=cls._model_rule_mode_label)}",
            f"- 媒体类型: {cls._render_counter_summary(by_media, labeler=cls._model_rule_media_label)}",
            "",
            "## 任务明细",
            "",
        ]
        items = audit.get("items") if isinstance(audit.get("items"), list) else []
        if not items:
            lines.append("暂无带模型规则摘要的生成任务。")
            return "\n".join(lines)

        for item in items:
            if not isinstance(item, dict):
                continue
            rule = item.get("rule") if isinstance(item.get("rule"), dict) else {}
            parts = [
                cls._text(item.get("resource_id") or item.get("task_id")),
                cls._text(item.get("status")),
                cls._model_rule_media_label(cls._text(rule.get("media_type"))),
                cls._text(rule.get("mode_label")) or cls._model_rule_mode_label(cls._text(rule.get("mode"))),
                cls._text(rule.get("target_label")) or cls._provider_model_text(rule),
            ]
            skill_name = cls._text(rule.get("skill_name"))
            if skill_name:
                parts.append(f"Skill: {skill_name}")
            billing_mode = cls._model_rule_billing_label(cls._text(rule.get("billing_mode")))
            if billing_mode:
                parts.append(billing_mode)
            script_file = cls._text(item.get("script_file"))
            if script_file:
                parts.append(script_file)
            lines.append(f"- {' · '.join(part for part in parts if part)}")
        return "\n".join(lines)

    @classmethod
    def _render_model_rule_audit_report_markdown(cls, summary: dict[str, Any]) -> list[str]:
        by_mode = summary.get("by_mode") if isinstance(summary.get("by_mode"), dict) else {}
        by_media = summary.get("by_media_type") if isinstance(summary.get("by_media_type"), dict) else {}
        files = summary.get("artifact_files") if isinstance(summary.get("artifact_files"), list) else []
        lines = [
            "## 模型规则审计",
            "",
            f"- 记录任务: {int(summary.get('total') or 0)}",
            f"- 规则来源: {cls._render_counter_summary(by_mode, labeler=cls._model_rule_mode_label)}",
            f"- 媒体类型: {cls._render_counter_summary(by_media, labeler=cls._model_rule_media_label)}",
        ]
        if files:
            lines.append(
                "- 审计文件: " + " / ".join(str(item) for item in files if isinstance(item, str) and item.strip())
            )
        return lines

    @staticmethod
    def _render_counter_summary(
        counts: dict[str, Any],
        *,
        labeler,
    ) -> str:
        parts = []
        for key, value in counts.items():
            if isinstance(value, bool) or not isinstance(value, int):
                continue
            parts.append(f"{labeler(str(key))} {value}")
        return " / ".join(parts) if parts else "-"

    @staticmethod
    def _model_rule_media_label(media_type: str) -> str:
        return {
            "image": "图片",
            "video": "视频",
            "text": "文本",
        }.get(media_type, media_type or "未知")

    @staticmethod
    def _model_rule_billing_label(billing_mode: str) -> str:
        return {
            "byok": "自填 API",
            "platform_credits": "平台积分",
        }.get(billing_mode, billing_mode)

    @classmethod
    def _provider_model_text(cls, rule: dict[str, Any]) -> str:
        provider = cls._text(rule.get("provider_id"))
        model = cls._text(rule.get("model_id"))
        if provider and model:
            return f"{provider} / {model}"
        return provider or model

    @staticmethod
    def _render_travel_route_report_markdown(travel_route: dict[str, Any]) -> list[str]:
        route_status = "已预检" if travel_route.get("route_ready") else "未通过/未预检"
        nodes_total = travel_route.get("nodes_total", 0)
        nodes_covered = travel_route.get("nodes_covered", 0)
        refs_total = travel_route.get("reference_images_count", 0)
        refs_usable = travel_route.get("usable_reference_images_count", 0)
        lines = [
            "## 旅游路线检查",
            "",
            f"- 路线状态: {route_status}",
            f"- 路线摘要: {travel_route.get('summary') or '-'}",
            f"- 出发地 / 目的地: {travel_route.get('origin') or '-'} / {travel_route.get('destination') or '-'}",
            f"- 路线距离 / 预计时长: {travel_route.get('distance_text') or '-'} / {travel_route.get('duration_text') or '-'}",
            f"- 路线节点覆盖: {nodes_covered} / {nodes_total}",
            f"- 参考图数量: {refs_usable} / {refs_total} 可用",
        ]
        nodes = travel_route.get("nodes") if isinstance(travel_route.get("nodes"), list) else []
        missing_nodes = [
            node
            for node in nodes
            if isinstance(node, dict) and not node.get("covered")
        ]
        if missing_nodes:
            labels = ", ".join(
                str(node.get("label") or node.get("id") or "未命名节点")
                for node in missing_nodes[:6]
            )
            suffix = f" 等 {len(missing_nodes)} 个" if len(missing_nodes) > 6 else ""
            lines.append(f"- 未覆盖节点: {labels}{suffix}")
        return lines

    @classmethod
    def _append_travel_video_export_checks(
        cls,
        project: dict[str, Any],
        project_dir: Path,
        diagnostics: ArchiveDiagnostics,
    ) -> None:
        if project.get("content_type") != "travel_video":
            return

        settings = project.get("travel_video_settings")
        if not isinstance(settings, dict):
            settings = {}

        route_source = cls._text(settings.get("route_source")) or "google_street_view"
        origin = cls._text(settings.get("origin"))
        destination = cls._text(settings.get("destination"))
        route_notes = cls._text(settings.get("route_notes"))
        configured_refs = cls._travel_reference_images(settings, include_preview=False)
        all_refs = cls._travel_reference_images(settings, include_preview=True)
        usable_refs = [
            ref
            for ref in configured_refs
            if cls._is_usable_travel_reference(project_dir, ref)
        ]
        has_text_route = bool(route_notes or (origin and destination))
        has_reference_route = len(usable_refs) > 0

        if not has_text_route and not has_reference_route:
            diagnostics.add(
                "blocking",
                "travel_route_missing",
                "旅游视频缺少路线依据：请填写出发地+目的地、手动路线说明，或上传至少一张可用路线参考图。",
                location="project.travel_video_settings",
            )
            return

        route_preview = settings.get("route_preview")
        if not isinstance(route_preview, dict):
            diagnostics.add(
                "blocking",
                "travel_route_preview_missing",
                "旅游视频尚未完成路线预检。请先在项目总览或路线设置中运行路线预检，再导出成品包。",
                location="project.travel_video_settings.route_preview",
            )
        elif not bool(route_preview.get("route_ready")):
            diagnostics.add(
                "blocking",
                "travel_route_preview_not_ready",
                cls._first_route_preview_warning(route_preview)
                or "旅游视频路线预检未通过，请先补充路线说明、地点或参考图。",
                location="project.travel_video_settings.route_preview",
            )
        else:
            preview_refs = cls._travel_reference_images(settings, include_preview=True)
            preview_missing = [
                ref
                for ref in preview_refs[:TRAVEL_REFERENCE_IMAGE_LIMIT]
                if not cls._is_usable_travel_reference(project_dir, ref)
            ]
            if preview_missing:
                diagnostics.add(
                    "warnings",
                    "travel_route_preview_reference_missing",
                    f"路线预检引用的 {len(preview_missing)} 张旅游参考图在项目目录中不存在，导出包不会包含这些图片。",
                    location="project.travel_video_settings.route_preview.reference_images",
                )

        if route_source == "reference_images" and not usable_refs:
            diagnostics.add(
                "warnings",
                "travel_reference_images_empty",
                "路线来源选择了多图参考，但导出时没有找到可用参考图；将只能依赖已填写的地点或路线说明。",
                location="project.travel_video_settings.reference_images",
            )

        if len(configured_refs) > TRAVEL_REFERENCE_IMAGE_LIMIT:
            diagnostics.add(
                "warnings",
                "travel_reference_images_limit",
                f"旅游视频参考图最多使用 {TRAVEL_REFERENCE_IMAGE_LIMIT} 张，导出前请保留最关键的路线、街景或人物参考。",
                location="project.travel_video_settings.reference_images",
            )

        missing_refs = [
            ref
            for ref in all_refs[:TRAVEL_REFERENCE_IMAGE_LIMIT]
            if not cls._is_usable_travel_reference(project_dir, ref)
        ]
        if missing_refs:
            diagnostics.add(
                "warnings",
                "travel_reference_images_missing_files",
                f"旅游视频有 {len(missing_refs)} 张参考图文件缺失，导出包不会包含这些图片。",
                location="project.travel_video_settings.reference_images",
            )

    @staticmethod
    def _text(value: Any) -> str:
        return str(value or "").strip()

    @classmethod
    def _travel_reference_images(
        cls,
        settings: dict[str, Any],
        *,
        include_preview: bool,
    ) -> list[str]:
        raw_refs: list[Any] = []
        configured_refs = settings.get("reference_images")
        if isinstance(configured_refs, list):
            raw_refs.extend(configured_refs)
        if include_preview:
            route_preview = settings.get("route_preview")
            preview_refs = route_preview.get("reference_images") if isinstance(route_preview, dict) else None
            if isinstance(preview_refs, list):
                raw_refs.extend(preview_refs)

        seen: set[str] = set()
        refs: list[str] = []
        for item in raw_refs:
            if not isinstance(item, str):
                continue
            ref = item.strip().replace("\\", "/")
            if not ref or ref in seen:
                continue
            seen.add(ref)
            refs.append(ref)
        return refs

    @staticmethod
    def _is_usable_travel_reference(project_dir: Path, ref: str) -> bool:
        if "://" in ref:
            return True
        candidate = Path(ref)
        if candidate.is_absolute() or ".." in candidate.parts:
            return False
        resolved = (project_dir / candidate).resolve(strict=False)
        project_root = project_dir.resolve(strict=False)
        try:
            resolved.relative_to(project_root)
        except ValueError:
            return False
        return resolved.exists() and resolved.is_file()

    @staticmethod
    def _first_route_preview_warning(route_preview: dict[str, Any]) -> str:
        warnings = route_preview.get("warnings")
        if not isinstance(warnings, list):
            return ""
        for item in warnings:
            if not isinstance(item, dict):
                continue
            message = str(item.get("message") or "").strip()
            if message:
                return message
        return ""

    @staticmethod
    def _write_directory_entry(
        archive: zipfile.ZipFile,
        parts: tuple[str, ...],
    ) -> None:
        dirname = "/".join(parts).rstrip("/") + "/"
        info = zipfile.ZipInfo(dirname)
        info.external_attr = (0o40755 & 0xFFFF) << 16
        archive.writestr(info, b"")

    def _write_snapshot_members(
        self,
        archive: zipfile.ZipFile,
        snapshot_dir: Path,
        *,
        project_name: str,
        scope: str,
    ) -> None:
        is_current = scope == "current"

        for current_dir, dirnames, filenames in os.walk(snapshot_dir):
            current_path = Path(current_dir)
            is_root = current_path == snapshot_dir
            dirnames[:] = [
                name
                for name in sorted(dirnames)
                if not name.startswith(".")
                and not (current_path / name).is_symlink()
                and not (is_root and name in self._AGENT_RUNTIME_EXCLUDES)
            ]

            relative_dir = current_path.relative_to(snapshot_dir)
            if is_current and relative_dir.parts == ("versions",):
                dirnames[:] = [name for name in dirnames if name not in self._VERSION_HISTORY_DIRS]

            visible_files = [
                name
                for name in sorted(filenames)
                if not name.startswith(".")
                and not (current_path / name).is_symlink()
                and not (is_root and name in self._AGENT_RUNTIME_EXCLUDES)
            ]

            if relative_dir != Path("."):
                self._write_directory_entry(
                    archive,
                    (project_name, *relative_dir.parts),
                )

            for filename in visible_files:
                source_path = current_path / filename
                archive_name = Path(project_name, relative_dir, filename).as_posix()

                if is_current and relative_dir.parts == ("versions",) and filename == "versions.json":
                    payload = self._load_json_file(source_path) or {}
                    archive.writestr(
                        archive_name,
                        json.dumps(
                            self._trim_versions_payload(payload),
                            ensure_ascii=False,
                            indent=2,
                        ),
                    )
                    continue

                archive.write(source_path, arcname=archive_name)

    @staticmethod
    def _trim_versions_payload(payload: dict[str, Any]) -> dict[str, Any]:
        trimmed = json.loads(json.dumps(payload))
        for resource_type_data in trimmed.values():
            if not isinstance(resource_type_data, dict):
                continue
            for resource_info in resource_type_data.values():
                if not isinstance(resource_info, dict):
                    continue
                current_ver = resource_info.get("current_version")
                versions_list = resource_info.get("versions", [])
                if current_ver is not None and isinstance(versions_list, list):
                    resource_info["versions"] = [
                        version
                        for version in versions_list
                        if isinstance(version, dict) and version.get("version") == current_ver
                    ]
        return trimmed

    def _copy_visible_tree(self, source_dir: Path, target_dir: Path) -> None:
        target_dir.mkdir(parents=True, exist_ok=True)
        for current_dir, dirnames, filenames in os.walk(source_dir):
            current_path = Path(current_dir)
            is_root = current_path == source_dir
            dirnames[:] = [
                name
                for name in sorted(dirnames)
                if not name.startswith(".")
                and not (current_path / name).is_symlink()
                and not (is_root and name in self._AGENT_RUNTIME_EXCLUDES)
                and not (is_root and name not in self._ROOT_VISIBLE_ENTRIES)
            ]
            relative_dir = current_path.relative_to(source_dir)
            destination_dir = target_dir / relative_dir
            destination_dir.mkdir(parents=True, exist_ok=True)

            for filename in sorted(filenames):
                source_path = current_path / filename
                if filename.startswith(".") or source_path.is_symlink():
                    continue
                if is_root and filename in self._AGENT_RUNTIME_EXCLUDES:
                    continue
                if is_root and filename not in self._ROOT_VISIBLE_ENTRIES:
                    continue
                destination_path = destination_dir / filename
                destination_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, destination_path)

    def _repair_project_tree(self, project_dir: Path) -> ArchiveDiagnostics:
        diagnostics = ArchiveDiagnostics()
        project_path = project_dir / self.project_manager.PROJECT_FILE
        project = self._load_json_file(project_path)
        if project is None:
            diagnostics.add(
                "blocking",
                "invalid_project_json",
                f"无法解析 {self.project_manager.PROJECT_FILE}: {project_path}",
                location=self.project_manager.PROJECT_FILE,
            )
            return diagnostics

        basename_index = self._build_basename_index(project_dir)
        versions_payload = self._load_versions_payload(project_dir)
        project_changed = False

        if self._repair_project_workflow_fields(project, diagnostics):
            project_changed = True

        style_image_rel = project.get("style_image") or "style_reference.png"
        if self._repair_path_to_canonical(
            project_dir,
            project,
            field_name="style_image",
            canonical_rel=style_image_rel,
            location="project.style_image",
            diagnostics=diagnostics,
        ):
            project_changed = True

        characters = project.get("characters")
        if isinstance(characters, dict):
            for char_name, char_data in characters.items():
                if not isinstance(char_data, dict):
                    continue
                if self._repair_path_to_canonical(
                    project_dir,
                    char_data,
                    field_name="character_sheet",
                    canonical_rel=f"characters/{char_name}.png",
                    location=f"characters[{char_name}].character_sheet",
                    diagnostics=diagnostics,
                    resource_type="characters",
                    resource_id=char_name,
                    versions_payload=versions_payload,
                ):
                    project_changed = True
                if self._repair_path_to_canonical(
                    project_dir,
                    char_data,
                    field_name="reference_image",
                    canonical_rel=f"characters/refs/{char_name}.png",
                    location=f"characters[{char_name}].reference_image",
                    diagnostics=diagnostics,
                ):
                    project_changed = True

        scenes = project.get("scenes")
        if isinstance(scenes, dict):
            for scene_name, scene_data in scenes.items():
                if not isinstance(scene_data, dict):
                    continue
                if self._repair_path_to_canonical(
                    project_dir,
                    scene_data,
                    field_name="scene_sheet",
                    canonical_rel=f"scenes/{scene_name}.png",
                    location=f"scenes[{scene_name}].scene_sheet",
                    diagnostics=diagnostics,
                    resource_type="scenes",
                    resource_id=scene_name,
                    versions_payload=versions_payload,
                ):
                    project_changed = True

        props = project.get("props")
        if isinstance(props, dict):
            for prop_name, prop_data in props.items():
                if not isinstance(prop_data, dict):
                    continue
                if self._repair_path_to_canonical(
                    project_dir,
                    prop_data,
                    field_name="prop_sheet",
                    canonical_rel=f"props/{prop_name}.png",
                    location=f"props[{prop_name}].prop_sheet",
                    diagnostics=diagnostics,
                    resource_type="props",
                    resource_id=prop_name,
                    versions_payload=versions_payload,
                ):
                    project_changed = True

        project_characters = {name for name, payload in (characters or {}).items() if isinstance(payload, dict)}
        project_scenes = {name for name, payload in (scenes or {}).items() if isinstance(payload, dict)}
        project_props = {name for name, payload in (props or {}).items() if isinstance(payload, dict)}

        episodes = project.get("episodes")
        if isinstance(episodes, list):
            for index, episode_meta in enumerate(episodes):
                if not isinstance(episode_meta, dict):
                    continue

                script_location = f"episodes[{index}].script_file"
                script_file = episode_meta.get("script_file")
                if isinstance(script_file, str) and script_file.strip():
                    repaired_script = self._repair_relative_reference(
                        project_dir,
                        script_file,
                        default_dir="scripts",
                        basename_index=basename_index,
                        preferred_prefix="scripts/",
                    )
                    if repaired_script and repaired_script != script_file.replace("\\", "/"):
                        episode_meta["script_file"] = repaired_script
                        project_changed = True
                        diagnostics.add(
                            "auto_fixed",
                            "script_file_repaired",
                            f"{script_location}: 自动修复为 {repaired_script}",
                            location=script_location,
                        )
                    script_path_rel = repaired_script or script_file.replace("\\", "/")
                else:
                    script_path_rel = None

                if not script_path_rel:
                    continue

                script_path = project_dir / script_path_rel
                if not script_path.exists():
                    diagnostics.add(
                        "blocking",
                        "missing_script_file",
                        f"{script_location}: 引用的文件不存在: {script_path_rel}",
                        location=script_location,
                    )
                    continue

                script_payload = self._load_json_file(script_path)
                if script_payload is None:
                    diagnostics.add(
                        "blocking",
                        "invalid_script_json",
                        f"无法解析剧本文件: {script_path_rel}",
                        location=script_location,
                    )
                    continue

                script_changed, project_changed_from_script = self._repair_script_payload(
                    project_dir,
                    script_path_rel=script_path_rel,
                    script_payload=script_payload,
                    project_payload=project,
                    project_characters=project_characters,
                    project_scenes=project_scenes,
                    project_props=project_props,
                    versions_payload=versions_payload,
                    diagnostics=diagnostics,
                    basename_index=basename_index,
                )
                if script_changed:
                    self._write_json_file(script_path, script_payload)
                if project_changed_from_script:
                    project_changed = True

        if project_changed:
            self._write_json_file(project_path, project)

        return diagnostics

    @staticmethod
    def _repair_project_workflow_fields(
        project: dict[str, Any],
        diagnostics: ArchiveDiagnostics,
    ) -> bool:
        content_type = project.get("content_type")
        workflow_preset = get_workflow_preset(content_type if isinstance(content_type, str) else None)
        if workflow_preset is None:
            return False

        changed = False
        if project.get("content_mode") != workflow_preset.content_mode:
            previous = project.get("content_mode")
            project["content_mode"] = workflow_preset.content_mode
            changed = True
            diagnostics.add(
                "auto_fixed",
                "content_mode_repaired",
                f"project.content_mode 已按内容类型 {workflow_preset.id} 修复为 {workflow_preset.content_mode}",
                location="project.content_mode",
            )
            logger.debug(
                "Repaired project content_mode from %r to %s for content_type=%s",
                previous,
                workflow_preset.content_mode,
                workflow_preset.id,
            )

        if not project.get("aspect_ratio"):
            project["aspect_ratio"] = workflow_preset.aspect_ratio
            changed = True
            diagnostics.add(
                "auto_fixed",
                "aspect_ratio_backfilled",
                f"project.aspect_ratio 已按内容类型 {workflow_preset.id} 补全为 {workflow_preset.aspect_ratio}",
                location="project.aspect_ratio",
            )

        if not project.get("generation_mode"):
            project["generation_mode"] = workflow_preset.generation_mode
            changed = True
            diagnostics.add(
                "auto_fixed",
                "generation_mode_backfilled",
                (
                    "project.generation_mode 已按内容类型 "
                    f"{workflow_preset.id} 补全为 {workflow_preset.generation_mode}"
                ),
                location="project.generation_mode",
            )

        return changed

    def _repair_script_payload(
        self,
        project_dir: Path,
        *,
        script_path_rel: str,
        script_payload: dict[str, Any],
        project_payload: dict[str, Any],
        project_characters: set[str],
        project_scenes: set[str],
        project_props: set[str],
        versions_payload: dict[str, Any],
        diagnostics: ArchiveDiagnostics,
        basename_index: dict[str, list[str]],
    ) -> tuple[bool, bool]:
        script_changed = False
        project_changed = False

        novel = script_payload.get("novel")
        if isinstance(novel, dict) and "source_file" in novel:
            novel.pop("source_file")
            script_changed = True
            diagnostics.add(
                "auto_fixed",
                "deprecated_source_file_removed",
                "novel.source_file 字段已废弃，已移除",
                location=f"{script_path_rel}:novel.source_file",
            )

        # 剥离废弃的 episode 级聚合字段
        for deprecated_field in ("characters_in_episode", "clues_in_episode"):
            if deprecated_field in script_payload:
                script_payload.pop(deprecated_field)
                script_changed = True
                diagnostics.add(
                    "auto_fixed",
                    "deprecated_field_removed",
                    f"{deprecated_field} 字段已废弃（改为读时计算），已移除",
                    location=f"{script_path_rel}:{deprecated_field}",
                )

        project_content_type = project_payload.get("content_type")
        workflow_preset = get_workflow_preset(project_content_type if isinstance(project_content_type, str) else None)
        content_mode = str(
            script_payload.get("content_mode")
            or (workflow_preset.content_mode if workflow_preset is not None else None)
            or project_payload.get("content_mode")
            or "narration"
        )
        items_key = "segments" if content_mode == "narration" else "scenes"
        id_field = "segment_id" if content_mode == "narration" else "scene_id"
        chars_field = "characters_in_segment" if content_mode == "narration" else "characters_in_scene"

        raw_items = script_payload.get(items_key)
        if not isinstance(raw_items, list):
            return script_changed, project_changed

        for index, item in enumerate(raw_items):
            if not isinstance(item, dict):
                continue

            location_prefix = f"{script_path_rel}:{items_key}[{index}]"
            resource_id = str(item.get(id_field) or "").strip()

            for legacy_field in ("clues_in_segment", "clues_in_scene", "clues"):
                if legacy_field in item:
                    item.pop(legacy_field)
                    script_changed = True
                    diagnostics.add(
                        "auto_fixed",
                        "deprecated_clue_field_removed",
                        f"{items_key}[{index}]: 废弃字段 {legacy_field} 已移除（请改用 scenes/props）",
                        location=f"{location_prefix}.{legacy_field}",
                    )

            for asset_field in ("scenes", "props"):
                if asset_field not in item:
                    item[asset_field] = []
                    script_changed = True
                    diagnostics.add(
                        "auto_fixed",
                        f"missing_{asset_field}_field",
                        f"{items_key}[{index}]: 补全缺失字段 {asset_field}",
                        location=f"{location_prefix}.{asset_field}",
                    )

            assets = item.get("generated_assets")
            if assets is None:
                item["generated_assets"] = self.project_manager.create_generated_assets(content_mode)
                script_changed = True
                diagnostics.add(
                    "auto_fixed",
                    "missing_generated_assets",
                    f"{items_key}[{index}]: 补全缺失字段 generated_assets",
                    location=f"{location_prefix}.generated_assets",
                )
                assets = item["generated_assets"]
            elif isinstance(assets, dict):
                template = self.project_manager.create_generated_assets(content_mode)
                missing_keys = [key for key in template if key not in assets]
                if missing_keys:
                    for key in missing_keys:
                        assets[key] = template[key]
                    script_changed = True
                    # 补全值非 None 的才报诊断，避免 no-op 补全产生噪音
                    non_null_keys = sorted(k for k in missing_keys if template[k] is not None)
                    if non_null_keys:
                        diagnostics.add(
                            "auto_fixed",
                            "generated_assets_defaults",
                            (f"{items_key}[{index}].generated_assets: 补全默认字段 {', '.join(non_null_keys)}"),
                            location=f"{location_prefix}.generated_assets",
                        )

            characters = item.get(chars_field)
            if isinstance(characters, list):
                for character_name in characters:
                    if not isinstance(character_name, str):
                        continue
                    if character_name in project_characters:
                        continue
                    project_payload.setdefault("characters", {})
                    if not isinstance(project_payload.get("characters"), dict):
                        continue
                    project_payload["characters"][character_name] = {
                        "description": self._PLACEHOLDER_CHARACTER_DESCRIPTION,
                    }
                    project_characters.add(character_name)
                    project_changed = True
                    diagnostics.add(
                        "auto_fixed",
                        "placeholder_character_added",
                        f"自动补充缺失角色定义: {character_name}",
                        location=f"characters[{character_name}]",
                    )

            for asset_field, pool, label in (
                ("scenes", project_scenes, "场景"),
                ("props", project_props, "道具"),
            ):
                refs = item.get(asset_field)
                if not isinstance(refs, list):
                    continue
                missing = sorted({name for name in refs if isinstance(name, str) and name not in pool})
                if missing:
                    diagnostics.add(
                        "blocking",
                        f"missing_{asset_field.rstrip('s')}_definition",
                        (
                            f"{items_key}[{index}]: {asset_field} 引用了不存在于 "
                            f"project.json 的{label}: {', '.join(missing)}"
                        ),
                        location=f"{location_prefix}.{asset_field}",
                    )

            if isinstance(assets, dict) and resource_id:
                for field_name, resource_type in (
                    ("storyboard_image", "storyboards"),
                    ("video_clip", "videos"),
                ):
                    if self._repair_path_to_canonical(
                        project_dir,
                        assets,
                        field_name=field_name,
                        canonical_rel=self._canonical_resource_path(
                            resource_type,
                            resource_id,
                        ),
                        location=f"{location_prefix}.generated_assets.{field_name}",
                        diagnostics=diagnostics,
                        resource_type=resource_type,
                        resource_id=resource_id,
                        versions_payload=versions_payload,
                    ):
                        script_changed = True

        return script_changed, project_changed

    def _repair_path_to_canonical(
        self,
        project_dir: Path,
        payload: dict[str, Any],
        *,
        field_name: str,
        canonical_rel: str,
        location: str,
        diagnostics: ArchiveDiagnostics,
        resource_type: str | None = None,
        resource_id: str | None = None,
        versions_payload: dict[str, Any] | None = None,
    ) -> bool:
        raw_value = payload.get(field_name)
        if not isinstance(raw_value, str) or not raw_value.strip():
            return False

        normalized_value = raw_value.strip().replace("\\", "/")
        canonical_path = project_dir / canonical_rel
        resolved_raw = self._resolve_existing_relative(project_dir, normalized_value)

        if canonical_path.exists():
            if normalized_value != canonical_rel:
                payload[field_name] = canonical_rel
                diagnostics.add(
                    "auto_fixed",
                    "canonical_path_normalized",
                    f"{location}: 规范化为 {canonical_rel}",
                    location=location,
                )
                return True
            return False

        if resolved_raw:
            if (
                resource_type
                and resource_id
                and resolved_raw.startswith(f"versions/{resource_type}/")
                and Path(resolved_raw).name.startswith(f"{resource_id}_v")
            ):
                if self._materialize_current_file(
                    project_dir / resolved_raw,
                    canonical_path,
                ):
                    payload[field_name] = canonical_rel
                    diagnostics.add(
                        "auto_fixed",
                        "current_asset_materialized",
                        f"{location}: 从 {resolved_raw} 恢复当前文件 {canonical_rel}",
                        location=location,
                    )
                    return True
            return False

        if resource_type and resource_id and versions_payload is not None:
            version_rel = self._resolve_version_file(
                project_dir,
                versions_payload,
                resource_type=resource_type,
                resource_id=resource_id,
            )
            if version_rel:
                if self._materialize_current_file(
                    project_dir / version_rel,
                    canonical_path,
                ):
                    payload[field_name] = canonical_rel
                    diagnostics.add(
                        "auto_fixed",
                        "current_asset_restored_from_version",
                        f"{location}: 从 {version_rel} 恢复当前文件 {canonical_rel}",
                        location=location,
                    )
                    return True

        return False

    def _resolve_version_file(
        self,
        project_dir: Path,
        versions_payload: dict[str, Any],
        *,
        resource_type: str,
        resource_id: str,
    ) -> str | None:
        type_payload = versions_payload.get(resource_type, {})
        resource_info = type_payload.get(resource_id) if isinstance(type_payload, dict) else None
        if isinstance(resource_info, dict):
            current_version = resource_info.get("current_version")
            versions = resource_info.get("versions", [])
            if current_version is not None and isinstance(versions, list):
                for version in versions:
                    if (
                        isinstance(version, dict)
                        and version.get("version") == current_version
                        and isinstance(version.get("file"), str)
                    ):
                        rel_path = version["file"].replace("\\", "/")
                        if self._resolve_existing_relative(project_dir, rel_path):
                            return rel_path

        version_dir = project_dir / "versions" / resource_type
        if not version_dir.exists():
            return None

        prefix = f"{resource_id}_v"
        extension = self._RESOURCE_EXTENSIONS[resource_type]
        candidates: list[str] = []
        for candidate in sorted(version_dir.iterdir(), key=lambda path: path.name):
            if candidate.is_file() and candidate.name.startswith(prefix) and candidate.suffix == extension:
                candidates.append(candidate.relative_to(project_dir).as_posix())

        if len(candidates) == 1:
            return candidates[0]
        return None

    def _repair_relative_reference(
        self,
        project_dir: Path,
        raw_value: str,
        *,
        default_dir: str,
        basename_index: dict[str, list[str]],
        preferred_prefix: str | None = None,
        allow_single_preferred_candidate: bool = False,
    ) -> str | None:
        normalized = raw_value.strip().replace("\\", "/")
        if not normalized:
            return None

        resolved = self._resolve_existing_relative(
            project_dir,
            normalized,
            default_dir=default_dir,
        )
        if resolved:
            return resolved

        if "/" not in normalized:
            basename = Path(normalized).name
            preferred_matches = [
                candidate
                for candidate in basename_index.get(basename, [])
                if candidate.startswith(preferred_prefix or "")
            ]
            if len(preferred_matches) == 1:
                return preferred_matches[0]

            all_matches = basename_index.get(basename, [])
            if len(all_matches) == 1:
                return all_matches[0]

        if allow_single_preferred_candidate and preferred_prefix:
            preferred_candidates = sorted(
                {
                    candidate
                    for candidates in basename_index.values()
                    for candidate in candidates
                    if candidate.startswith(preferred_prefix)
                }
            )
            if len(preferred_candidates) == 1:
                return preferred_candidates[0]

        return None

    def _build_basename_index(self, project_dir: Path) -> dict[str, list[str]]:
        index: dict[str, list[str]] = {}
        for item in sorted(project_dir.rglob("*")):
            if not item.is_file() or item.is_symlink():
                continue
            relative = item.relative_to(project_dir)
            if self._is_hidden_path(relative):
                continue
            index.setdefault(item.name, []).append(relative.as_posix())
        return index

    def _load_versions_payload(self, project_dir: Path) -> dict[str, Any]:
        versions_path = project_dir / "versions" / "versions.json"
        payload = self._load_json_file(versions_path)
        if payload is None:
            return {
                "storyboards": {},
                "videos": {},
                "characters": {},
                "scenes": {},
                "props": {},
            }
        return payload

    def _collect_pass_through_entries(self, project_dir: Path) -> list[str]:
        entries: list[str] = []
        if not project_dir.exists():
            return entries

        for child in sorted(project_dir.iterdir(), key=lambda item: item.name):
            if self._is_hidden_path(Path(child.name)):
                continue
            if child.name in self._AGENT_RUNTIME_EXCLUDES:
                continue
            if child.name not in self._ROOT_VISIBLE_ENTRIES:
                entries.append(child.name)
        return entries

    @staticmethod
    def _is_hidden_path(path: Path) -> bool:
        return any(part.startswith(".") or part == "__MACOSX" for part in path.parts)

    def _materialize_current_file(self, source_path: Path, target_path: Path) -> bool:
        if not source_path.exists() or source_path.resolve() == target_path.resolve():
            return False
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target_path)
        return True

    def _resolve_existing_relative(
        self,
        project_dir: Path,
        raw_path: str,
        *,
        default_dir: str | None = None,
    ) -> str | None:
        normalized = raw_path.strip().replace("\\", "/")
        if not normalized:
            return None

        candidates = [Path(normalized)]
        if default_dir and len(candidates[0].parts) == 1:
            candidates.append(Path(default_dir) / candidates[0])

        project_root = project_dir.resolve()
        seen: set[str] = set()
        for candidate in candidates:
            key = candidate.as_posix()
            if key in seen:
                continue
            seen.add(key)

            try:
                resolved = (project_dir / candidate).resolve(strict=False)
                resolved.relative_to(project_root)
            except ValueError:
                continue

            if resolved.exists():
                return candidate.as_posix()

        return None

    @classmethod
    def _canonical_resource_path(cls, resource_type: str, resource_id: str) -> str:
        extension = cls._RESOURCE_EXTENSIONS[resource_type]
        if resource_type in {"storyboards", "videos"}:
            return f"{resource_type}/scene_{resource_id}{extension}"
        return f"{resource_type}/{resource_id}{extension}"

    def _load_json_file(self, path: Path) -> dict[str, Any] | None:
        real = os.path.realpath(path)
        base = os.path.realpath(self.project_manager.projects_root) + os.sep
        tmp = os.path.realpath(tempfile.gettempdir()) + os.sep
        if not (real.startswith(base) or real.startswith(tmp)):
            logger.warning("路径越界，拒绝读取: %s", real)
            return None
        try:
            return load_json(Path(real))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _write_json_file(self, path: Path, payload: dict[str, Any]) -> None:
        real = os.path.realpath(path)
        base = os.path.realpath(self.project_manager.projects_root) + os.sep
        tmp = os.path.realpath(tempfile.gettempdir()) + os.sep
        if real.startswith(base):
            os.makedirs(os.path.dirname(real), exist_ok=True)
            with open(real, "w", encoding="utf-8") as handle:  # noqa: PTH123
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            return
        if real.startswith(tmp):
            os.makedirs(os.path.dirname(real), exist_ok=True)
            with open(real, "w", encoding="utf-8") as handle:  # noqa: PTH123
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            return
        raise ValueError(f"路径越界，拒绝写入: {real}")

    @staticmethod
    def _validate_scope(scope: str) -> None:
        if scope not in {"full", "current"}:
            raise ValueError(f"scope 仅支持 full 或 current，收到: {scope}")

    def _scan_archive_members(self, archive: zipfile.ZipFile) -> list[ArchiveMember]:
        members: list[ArchiveMember] = []
        for info in archive.infolist():
            if info.flag_bits & 0x1:
                raise ProjectArchiveValidationError(
                    "导入包校验失败",
                    errors=[f"ZIP 包含加密条目，无法导入: {info.filename}"],
                )

            normalized_name = info.filename.replace("\\", "/")
            if normalized_name.startswith("/"):
                raise ProjectArchiveValidationError(
                    "导入包校验失败",
                    errors=[f"ZIP 包含绝对路径条目: {info.filename}"],
                )

            stripped_name = normalized_name.strip("/")
            if not stripped_name:
                continue

            parts = tuple(part for part in stripped_name.split("/") if part)
            if parts and len(parts[0]) == 2 and parts[0][1] == ":":
                raise ProjectArchiveValidationError(
                    "导入包校验失败",
                    errors=[f"ZIP 包含绝对路径条目: {info.filename}"],
                )
            if any(part == ".." for part in parts):
                raise ProjectArchiveValidationError(
                    "导入包校验失败",
                    errors=[f"ZIP 包含路径穿越条目: {info.filename}"],
                )

            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                raise ProjectArchiveValidationError(
                    "导入包校验失败",
                    errors=[f"ZIP 包含符号链接条目: {info.filename}"],
                )

            members.append(
                ArchiveMember(
                    info=info,
                    parts=parts,
                    is_dir=info.is_dir() or normalized_name.endswith("/"),
                )
            )

        return members

    @staticmethod
    def _is_hidden_member(parts: tuple[str, ...]) -> bool:
        return any(part.startswith(".") or part == "__MACOSX" for part in parts)

    def _load_member_json(
        self,
        archive: zipfile.ZipFile,
        member: ArchiveMember,
        label: str,
    ) -> dict[str, Any]:
        try:
            with archive.open(member.info) as handle:
                return json.loads(handle.read().decode("utf-8"))
        except Exception as exc:
            raise ProjectArchiveValidationError(
                "导入包校验失败",
                errors=[f"无法解析 {label}: {'/'.join(member.parts)}"],
            ) from exc

    def _locate_project_root(
        self,
        archive: zipfile.ZipFile,
        members: list[ArchiveMember],
    ) -> tuple[tuple[str, ...], dict[str, Any] | None]:
        visible_members = [member for member in members if not self._is_hidden_member(member.parts)]

        manifest_members = [member for member in visible_members if member.parts[-1] == ARCHIVE_MANIFEST_NAME]
        if manifest_members:
            root_candidates = {member.parts[:-1] for member in manifest_members}
            if len(root_candidates) != 1:
                raise ProjectArchiveValidationError(
                    "导入包校验失败",
                    errors=["ZIP 中包含多个 arcreel-export.json，无法确定项目根目录"],
                )

            root_parts = next(iter(root_candidates))
            if not any(member.parts == (*root_parts, self.project_manager.PROJECT_FILE) for member in visible_members):
                raise ProjectArchiveValidationError(
                    "导入包校验失败",
                    errors=["官方导出包缺少 project.json"],
                )

            manifest = self._load_member_json(
                archive,
                manifest_members[0],
                ARCHIVE_MANIFEST_NAME,
            )
            return root_parts, manifest

        project_members = [
            member for member in visible_members if member.parts[-1] == self.project_manager.PROJECT_FILE
        ]
        root_candidates = {member.parts[:-1] for member in project_members}
        if not root_candidates:
            raise ProjectArchiveValidationError(
                "导入包校验失败",
                errors=["ZIP 中未找到 project.json"],
            )
        if len(root_candidates) != 1:
            raise ProjectArchiveValidationError(
                "导入包校验失败",
                errors=["ZIP 中包含多个 project.json，无法确定项目根目录"],
            )

        return next(iter(root_candidates)), None

    def _extract_archive_root(
        self,
        archive: zipfile.ZipFile,
        members: list[ArchiveMember],
        root_parts: tuple[str, ...],
        staging_dir: Path,
    ) -> None:
        staging_root = staging_dir.resolve()
        root_length = len(root_parts)

        for member in members:
            if member.parts[:root_length] != root_parts:
                continue

            relative_parts = member.parts[root_length:]
            if not relative_parts:
                continue
            if relative_parts == (ARCHIVE_MANIFEST_NAME,):
                continue
            if self._is_hidden_member(relative_parts):
                continue

            target_path = staging_dir.joinpath(*relative_parts)
            try:
                target_path.resolve(strict=False).relative_to(staging_root)
            except ValueError as exc:
                raise ProjectArchiveValidationError(
                    "导入包校验失败",
                    errors=[f"解压路径越界: {'/'.join(member.parts)}"],
                ) from exc

            if member.is_dir:
                target_path.mkdir(parents=True, exist_ok=True)
                continue

            target_path.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member.info) as source, open(target_path, "wb") as target:
                shutil.copyfileobj(source, target)

    def _normalize_project_name(self, value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        try:
            return self.project_manager.normalize_project_name(value)
        except ValueError:
            return None

    def _resolve_target_project_name(
        self,
        project: dict[str, Any],
        *,
        manifest: dict[str, Any] | None,
        root_parts: tuple[str, ...],
        uploaded_filename: str | None,
    ) -> str:
        manifest_name = self._normalize_project_name((manifest or {}).get("project_name"))
        if manifest_name:
            return manifest_name

        root_name = self._normalize_project_name(root_parts[-1] if root_parts else None)
        if root_name:
            return root_name

        project_title = str(project.get("title") or "").strip()
        if project_title:
            return self.project_manager.generate_project_name(project_title)

        filename_stem = Path(uploaded_filename or DEFAULT_IMPORT_FILENAME).stem
        return self.project_manager.generate_project_name(filename_stem)

    @staticmethod
    def _load_project_file(project_path: Path) -> dict[str, Any]:
        with open(project_path, encoding="utf-8") as handle:
            return json.load(handle)

    def _resolve_conflict(
        self,
        preferred_name: str,
        *,
        project_title: str,
        conflict_policy: str,
    ) -> tuple[str, str]:
        target_dir = self._target_project_dir(preferred_name)
        if conflict_policy == "prompt":
            if target_dir.exists():
                raise ProjectArchiveValidationError(
                    "检测到项目编号冲突",
                    status_code=409,
                    errors=[f"项目编号 '{preferred_name}' 已存在，请选择覆盖现有项目或自动重命名导入。"],
                    extra={"conflict_project_name": preferred_name},
                )
            return preferred_name, "none"

        if conflict_policy == "rename":
            if target_dir.exists():
                generated_name = self.project_manager.generate_project_name(project_title or preferred_name)
                return generated_name, "renamed"
            return preferred_name, "none"

        if target_dir.exists():
            return preferred_name, "overwritten"
        return preferred_name, "none"

    def _target_project_dir(self, project_name: str) -> Path:
        if hasattr(self.project_manager, "get_project_storage_path"):
            return self.project_manager.get_project_storage_path(project_name)
        return self.project_manager.projects_root / project_name

    def _claim_imported_project(self, project: dict[str, Any], project_file: Path) -> None:
        user_id = getattr(self.project_manager, "user_id", None)
        if user_id is None:
            return
        project["owner_user_id"] = str(user_id)
        project.pop("project_access", None)
        atomic_write_json(project_file, project)

    def _ensure_standard_subdirs(self, project_dir: Path) -> None:
        for subdir in self.project_manager.SUBDIRS:
            (project_dir / subdir).mkdir(parents=True, exist_ok=True)

    def _install_project_dir(
        self,
        staging_dir: Path,
        project_name: str,
        *,
        overwrite: bool,
    ) -> None:
        target_dir = self._target_project_dir(project_name)
        backup_dir: Path | None = None

        try:
            if overwrite and target_dir.exists():
                backup_dir = target_dir.with_name(f".import-backup-{target_dir.name}-{secrets.token_hex(4)}")
                target_dir.rename(backup_dir)

            shutil.move(str(staging_dir), str(target_dir))
        except Exception:
            if target_dir.exists():
                shutil.rmtree(target_dir, ignore_errors=True)
            if backup_dir and backup_dir.exists():
                backup_dir.rename(target_dir)
            raise

        if backup_dir and backup_dir.exists():
            shutil.rmtree(backup_dir)
