"""Task execution service for queued generation jobs.

This module is the public entrypoint for the generation worker. The actual work
is split across focused submodules:

- ``_generation_backends`` — provider/MediaGenerator resolution + cache.
- ``_generation_events``   — fingerprint + emit project-change events on success.
- ``_generation_executors`` — per-task executors (storyboard/video/character/...).
- ``_generation_grid``     — grid task executor.

Symbols are re-exported below so existing callers, sub-modules, and tests that
monkeypatch via ``generation_tasks.X`` keep working unchanged.
"""

from __future__ import annotations

import logging
from typing import Any

from lib import PROJECT_ROOT
from lib.db.base import DEFAULT_USER_ID
from lib.project_change_hints import (
    emit_project_change_batch as emit_project_change_batch,  # noqa: PLC0414 — re-exported for tests/_generation_events that monkeypatch via this module
)
from lib.project_change_hints import project_change_source
from lib.project_manager import ProjectManager
from lib.thumbnail import (
    extract_video_thumbnail as extract_video_thumbnail,  # noqa: PLC0414 — re-exported for tests/_generation_executors that look it up via this module
)
from server.services.project_access import project_manager_for_user

pm = ProjectManager(PROJECT_ROOT / "projects")
logger = logging.getLogger(__name__)


def get_project_manager() -> ProjectManager:
    return pm


def get_project_manager_for_user(user_id: str | None) -> ProjectManager:
    return project_manager_for_user(get_project_manager(), user_id)
from server.services._generation_backends import (  # noqa: E402
    _IMAGE_PROVIDER_ID_TO_BACKEND as _IMAGE_PROVIDER_ID_TO_BACKEND,
)
from server.services._generation_backends import (
    _PROVIDER_ID_TO_BACKEND as _PROVIDER_ID_TO_BACKEND,
)
from server.services._generation_backends import (
    _VIDEO_PROVIDER_ID_TO_BACKEND as _VIDEO_PROVIDER_ID_TO_BACKEND,
)
from server.services._generation_backends import (
    _backend_cache as _backend_cache,
)
from server.services._generation_backends import (
    _create_custom_backend as _create_custom_backend,
)
from server.services._generation_backends import (
    _fill_simple_provider_kwargs as _fill_simple_provider_kwargs,
)
from server.services._generation_backends import (
    _get_or_create_image_backend as _get_or_create_image_backend,
)
from server.services._generation_backends import (
    _get_or_create_video_backend as _get_or_create_video_backend,
)
from server.services._generation_backends import (
    _parse_project_backend as _parse_project_backend,
)
from server.services._generation_backends import (
    _resolve_effective_image_backend as _resolve_effective_image_backend,
)
from server.services._generation_backends import (
    _resolve_video_backend as _resolve_video_backend,
)
from server.services._generation_backends import (
    get_media_generator as get_media_generator,
)
from server.services._generation_backends import (
    invalidate_backend_cache as invalidate_backend_cache,
)
from server.services._generation_backends import (
    rate_limiter as rate_limiter,
)
from server.services._generation_backends import (
    resolve_credential_user_id as resolve_credential_user_id,
)
from server.services._generation_events import (  # noqa: E402
    _TASK_CHANGE_SPECS as _TASK_CHANGE_SPECS,
)
from server.services._generation_events import (
    _build_generation_focus as _build_generation_focus,
)
from server.services._generation_events import (
    _compute_affected_fingerprints as _compute_affected_fingerprints,
)
from server.services._generation_events import (
    _resolve_script_episode as _resolve_script_episode,
)
from server.services._generation_events import (
    emit_generation_success_batch as _emit_generation_success_batch,
)

# Executors + their helpers (prompt normalization, sheet/reference collection,
# aspect ratio) live in _generation_executors.py. Re-exported below so external
# callers and tests that look these up via the main module keep working.
from server.services._generation_executors import (  # noqa: E402
    _DESIGN_PROMPT_BUILDERS as _DESIGN_PROMPT_BUILDERS,
)
from server.services._generation_executors import (
    _collect_reference_images as _collect_reference_images,
)
from server.services._generation_executors import (
    _collect_sheet_paths as _collect_sheet_paths,
)
from server.services._generation_executors import (
    _get_model_default_duration as _get_model_default_duration,
)
from server.services._generation_executors import (
    _normalize_storyboard_prompt as _normalize_storyboard_prompt,
)
from server.services._generation_executors import (
    _normalize_video_prompt as _normalize_video_prompt,
)
from server.services._generation_executors import (
    execute_character_task as execute_character_task,
)
from server.services._generation_executors import (
    execute_design_task as execute_design_task,
)
from server.services._generation_executors import (
    execute_prop_task as execute_prop_task,
)
from server.services._generation_executors import (
    execute_scene_task as execute_scene_task,
)
from server.services._generation_executors import (
    execute_storyboard_task as execute_storyboard_task,
)
from server.services._generation_executors import (
    execute_video_task as execute_video_task,
)
from server.services._generation_executors import (
    get_aspect_ratio as get_aspect_ratio,
)

# Grid task lives in _generation_grid.py — re-exported below so existing imports
# (tests, _TASK_EXECUTORS) keep working.
from server.services._generation_grid import (  # noqa: E402
    _collect_grid_reference_images as _collect_grid_reference_images,
)
from server.services._generation_grid import (
    _group_scenes_by_segment_break as _group_scenes_by_segment_break,
)
from server.services._generation_grid import (
    _resolve_grid_script_path as _resolve_grid_script_path,
)
from server.services._generation_grid import (
    execute_grid_task as execute_grid_task,
)


async def _execute_reference_video_task_proxy(
    project_name: str, resource_id: str, payload: dict[str, Any], *, user_id: str
) -> dict[str, Any]:
    """Lazy proxy to avoid circular import: reference_video_tasks imports from this module."""
    from server.services.reference_video_tasks import execute_reference_video_task

    return await execute_reference_video_task(project_name, resource_id, payload, user_id=user_id)


_TASK_EXECUTORS = {
    "storyboard": execute_storyboard_task,
    "video": execute_video_task,
    "character": execute_character_task,
    "scene": execute_scene_task,
    "prop": execute_prop_task,
    "grid": execute_grid_task,
    "reference_video": _execute_reference_video_task_proxy,
}


async def execute_generation_task(task: dict[str, Any]) -> dict[str, Any]:
    task_type = task.get("task_type")
    project_name = task.get("project_name")
    resource_id = str(task.get("resource_id"))
    payload = task.get("payload") or {}
    user_id = task.get("user_id", DEFAULT_USER_ID)

    if not project_name:
        raise ValueError("task.project_name is required")

    executor = _TASK_EXECUTORS.get(task_type)
    if executor is None:
        raise ValueError(f"unsupported task_type: {task_type}")

    with project_change_source("worker"):
        result = await executor(project_name, resource_id, payload, user_id=user_id)
        _emit_generation_success_batch(
            task_type=task_type,
            project_name=project_name,
            resource_id=resource_id,
            payload=payload,
            user_id=user_id,
        )
        return result
