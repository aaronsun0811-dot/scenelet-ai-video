"""Generation-success event publishing — extracted from ``generation_tasks.py``.

After a task executor returns, ``execute_generation_task`` calls
:func:`emit_generation_success_batch` to compute affected asset fingerprints
(file mtimes), build a focus hint, and emit a project-change event so SSE
subscribers can refresh just what's needed.

Helpers from the main ``generation_tasks`` module (``get_project_manager_for_user``)
are accessed via deferred module-attribute lookup so that test monkeypatches keep
applying.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from lib.asset_types import ASSET_SPECS
from lib.db.base import DEFAULT_USER_ID

logger = logging.getLogger(__name__)


def _gt():
    from server.services import generation_tasks as _main

    return _main


def _resolve_script_episode(project_name: str, script_file: str | None, *, user_id: str = DEFAULT_USER_ID) -> int | None:
    if not script_file:
        return None
    try:
        script = _gt().get_project_manager_for_user(user_id).load_script(project_name, script_file)
    except Exception:
        return None

    episode = script.get("episode")
    if isinstance(episode, int):
        return episode
    return None


def _compute_affected_fingerprints(
    project_name: str,
    task_type: str,
    resource_id: str,
    *,
    user_id: str = DEFAULT_USER_ID,
) -> dict[str, int]:
    """计算受影响文件的 mtime 指纹"""
    try:
        project_path = _gt().get_project_manager_for_user(user_id).get_project_path(project_name)
    except Exception:
        return {}

    paths: list[tuple[str, Path]] = []

    if task_type == "storyboard":
        paths.append(
            (
                f"storyboards/scene_{resource_id}.png",
                project_path / "storyboards" / f"scene_{resource_id}.png",
            )
        )
    elif task_type == "video":
        paths.append(
            (
                f"videos/scene_{resource_id}.mp4",
                project_path / "videos" / f"scene_{resource_id}.mp4",
            )
        )
        paths.append(
            (
                f"thumbnails/scene_{resource_id}.jpg",
                project_path / "thumbnails" / f"scene_{resource_id}.jpg",
            )
        )
    elif task_type == "character":
        paths.append(
            (
                f"characters/{resource_id}.png",
                project_path / "characters" / f"{resource_id}.png",
            )
        )
    elif task_type == "scene":
        paths.append(
            (
                f"scenes/{resource_id}.png",
                project_path / "scenes" / f"{resource_id}.png",
            )
        )
    elif task_type == "prop":
        paths.append(
            (
                f"props/{resource_id}.png",
                project_path / "props" / f"{resource_id}.png",
            )
        )
    elif task_type == "grid":
        paths.append(
            (
                f"grids/{resource_id}.png",
                project_path / "grids" / f"{resource_id}.png",
            )
        )
    elif task_type == "reference_video":
        paths.append(
            (
                f"reference_videos/{resource_id}.mp4",
                project_path / "reference_videos" / f"{resource_id}.mp4",
            )
        )
        paths.append(
            (
                f"reference_videos/thumbnails/{resource_id}.jpg",
                project_path / "reference_videos" / "thumbnails" / f"{resource_id}.jpg",
            )
        )

    result: dict[str, int] = {}
    for rel, abs_path in paths:
        if abs_path.exists():
            result[rel] = abs_path.stat().st_mtime_ns

    return result


# (entity_type, action, label_tpl, include_script_episode)
# 三类项目级资产（character / scene / prop）的 spec 由 lib.asset_types.ASSET_SPECS 派生。
_TASK_CHANGE_SPECS: dict[str, tuple] = {
    "storyboard": ("segment", "storyboard_ready", "分镜「{}」", True),
    "video": ("segment", "video_ready", "分镜「{}」", True),
    "grid": ("grid", "grid_ready", "宫格「{}」", True),
    "reference_video": ("reference_video_unit", "reference_video_ready", "参考视频「{}」", True),
    **{atype: (atype, "updated", f"{spec.label_zh}「{{}}」设计图", False) for atype, spec in ASSET_SPECS.items()},
}


def _build_generation_focus(
    task_type: str,
    resource_id: str,
    payload: dict[str, Any],
    episode: int | None,
) -> dict[str, Any] | None:
    if not isinstance(episode, int):
        return None

    if task_type in {"storyboard", "video"}:
        return {
            "pane": "episode",
            "episode": episode,
            "anchor_type": "segment",
            "anchor_id": resource_id,
        }

    if task_type == "reference_video":
        return {
            "pane": "episode",
            "episode": episode,
            "anchor_type": "reference-unit",
            "anchor_id": resource_id,
        }

    if task_type == "grid":
        scene_ids = payload.get("scene_ids")
        if not isinstance(scene_ids, list):
            return None
        first_scene_id = next((str(item) for item in scene_ids if str(item or "").strip()), "")
        if not first_scene_id:
            return None
        return {
            "pane": "episode",
            "episode": episode,
            "anchor_type": "segment",
            "anchor_id": first_scene_id,
        }

    return None


def emit_generation_success_batch(
    *,
    task_type: str,
    project_name: str,
    resource_id: str,
    payload: dict[str, Any],
    user_id: str = DEFAULT_USER_ID,
) -> None:
    spec = _TASK_CHANGE_SPECS.get(task_type)
    if spec is None:
        return

    entity_type, action, label_tpl, include_script_episode = spec
    asset_fingerprints = _compute_affected_fingerprints(project_name, task_type, resource_id, user_id=user_id)

    change: dict[str, Any] = {
        "entity_type": entity_type,
        "action": action,
        "entity_id": resource_id,
        "label": label_tpl.format(resource_id),
        "focus": None,
        "important": True,
        "asset_fingerprints": asset_fingerprints,
    }
    if include_script_episode:
        script_file = str(payload.get("script_file") or "") or None
        episode = _resolve_script_episode(project_name, script_file, user_id=user_id)
        change["script_file"] = script_file
        change["episode"] = episode
        change["focus"] = _build_generation_focus(task_type, resource_id, payload, episode)

    try:
        # Looked up via main module so test monkeypatches on generation_tasks.emit_project_change_batch apply.
        _gt().emit_project_change_batch(project_name, [change], source="worker", user_id=user_id)
    except Exception:
        logger.exception(
            "发送生成完成项目事件失败 project=%s task_type=%s resource_id=%s",
            project_name,
            task_type,
            resource_id,
        )


__all__ = [
    "_TASK_CHANGE_SPECS",
    "_build_generation_focus",
    "_compute_affected_fingerprints",
    "_resolve_script_episode",
    "emit_generation_success_batch",
]
