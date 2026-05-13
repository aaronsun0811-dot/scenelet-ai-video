"""Grid generation task — extracted from ``generation_tasks.py``.

``execute_grid_task`` is the executor for ``task_type == "grid"`` in the queue.
It loads a :class:`GridGeneration`, generates the grid image via
:class:`MediaGenerator`, splits the cells, and assigns each cell back to its
target scene as a storyboard frame.

Re-exported from ``generation_tasks`` so callers and tests that import via
the original module path keep working unchanged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import traceback
from pathlib import Path
from typing import Any

from lib.db.base import DEFAULT_USER_ID
from lib.storyboard_sequence import get_storyboard_items, group_scenes_by_segment_break
from server.services.resolution_resolver import resolve_resolution

logger = logging.getLogger(__name__)


def _gt():
    """Deferred lookup of generation_tasks helpers to avoid circular import."""
    from server.services import generation_tasks as _main

    return _main


def _group_scenes_by_segment_break(items: list[dict], id_field: str) -> list[list[dict]]:
    """Groups consecutive scene dicts, breaking at segment_break=True.

    Delegates to :func:`lib.storyboard_sequence.group_scenes_by_segment_break`.
    """
    return group_scenes_by_segment_break(items, id_field)


def _resolve_grid_script_path(project_path: Path, script_file: Any) -> Path | None:
    """Resolve a grid script path inside ``project_path/scripts``.

    Grid records may store either ``episode_1.json`` or ``scripts/episode_1.json``.
    Normalize both forms while keeping the path bounded to the scripts directory.
    """
    rel = str(script_file or "").strip()
    if not rel:
        return None
    if rel.startswith("scripts/"):
        rel = rel[len("scripts/") :]

    scripts_dir = (project_path / "scripts").resolve(strict=False)
    candidate = (scripts_dir / rel).resolve(strict=False)
    try:
        candidate.relative_to(scripts_dir)
    except ValueError:
        return None
    return candidate


def _collect_grid_reference_images(
    project_path: Path,
    payload: dict[str, Any],
    scene_ids: list[str],
) -> tuple[list[object] | None, list[dict]]:
    """Collect character/scene/prop sheet images referenced by grid scenes.

    Returns a tuple of ``(image_paths, metadata)``:
    - *image_paths*: up to 6 :class:`~pathlib.Path` objects for the generation API.
    - *metadata*: list of dicts ``{path, name, ref_type}`` for persisting in
      :class:`~lib.grid.models.GridGeneration`.
    """
    project_json = project_path / "project.json"
    if not project_json.exists():
        return None, []

    project = json.loads(project_json.read_text(encoding="utf-8"))

    script_path = _resolve_grid_script_path(project_path, payload.get("script_file"))
    if script_path is None or not script_path.exists():
        return None, []

    script = json.loads(script_path.read_text(encoding="utf-8"))

    items, id_field, char_field, scene_field, prop_field = get_storyboard_items(script)

    scene_id_set = set(scene_ids)
    matched_items = [item for item in items if str(item.get(id_field, "")) in scene_id_set]

    characters = project.get("characters", {})
    project_scenes = project.get("scenes", {})
    project_props = project.get("props", {})

    seen: set[str] = set()
    paths: list[Path] = []
    metadata: list[dict] = []
    max_count = 6

    for item in matched_items:
        for char_name in item.get(char_field, []):
            sheet = characters.get(char_name, {}).get("character_sheet")
            if sheet and sheet not in seen:
                p = project_path / sheet
                if p.exists():
                    paths.append(p)
                    seen.add(sheet)
                    metadata.append({"path": sheet, "name": char_name, "ref_type": "character"})
        for scene_name in item.get(scene_field, []):
            sheet = project_scenes.get(scene_name, {}).get("scene_sheet")
            if sheet and sheet not in seen:
                p = project_path / sheet
                if p.exists():
                    paths.append(p)
                    seen.add(sheet)
                    metadata.append({"path": sheet, "name": scene_name, "ref_type": "scene"})
        for prop_name in item.get(prop_field, []):
            sheet = project_props.get(prop_name, {}).get("prop_sheet")
            if sheet and sheet not in seen:
                p = project_path / sheet
                if p.exists():
                    paths.append(p)
                    seen.add(sheet)
                    metadata.append({"path": sheet, "name": prop_name, "ref_type": "prop"})
        if len(paths) >= max_count:
            break

    return list(paths[:max_count]) or None, metadata[:max_count]


async def execute_grid_task(
    project_name: str, resource_id: str, payload: dict[str, Any], *, user_id: str = DEFAULT_USER_ID
) -> dict[str, Any]:
    """Execute a grid image generation task.

    resource_id is the grid_id. Steps:
    1. Load GridGeneration, set status to generating
    2. Generate image via MediaGenerator
    3. Split grid image into cells
    4. Assign cell images to scenes in the script
    5. Mark completed
    """
    from PIL import Image

    from lib.grid.models import ReferenceImage
    from lib.grid.splitter import split_grid_image
    from lib.grid_manager import GridManager

    gt = _gt()
    manager = gt.get_project_manager_for_user(user_id)
    project_path = await asyncio.to_thread(manager.get_project_path, project_name)
    grid_manager = GridManager(project_path)

    grid = grid_manager.get(resource_id)
    if grid is None:
        raise ValueError(f"grid not found: {resource_id}")

    script_file = grid.script_file

    try:
        grid.status = "generating"
        grid.error_message = None
        grid_manager.save(grid)

        reference_images, ref_metadata = await asyncio.to_thread(
            _collect_grid_reference_images, project_path, payload, grid.scene_ids
        )
        grid.reference_images = [ReferenceImage.from_dict(m) for m in ref_metadata] if ref_metadata else []
        grid_manager.save(grid)

        prompt_text = payload.get("prompt") or grid.prompt
        if not prompt_text:
            raise ValueError("prompt is required for grid task")

        generator = await gt.get_media_generator(
            project_name,
            payload=payload,
            user_id=user_id,
        )

        project = await asyncio.to_thread(manager.load_project, project_name)
        aspect_ratio = payload.get("grid_aspect_ratio") or gt.get_aspect_ratio(project, "storyboards")

        image_provider_id, image_model_id = await gt._resolve_effective_image_backend(project, payload, user_id=user_id)
        image_size = await resolve_resolution(project, image_provider_id, image_model_id) or "2K"  # 宫格图保底高分辨率

        image_path, version = await generator.generate_image_async(
            prompt=prompt_text,
            resource_type="grids",
            resource_id=resource_id,
            reference_images=reference_images,
            aspect_ratio=aspect_ratio,
            image_size=image_size,
        )

        grid.grid_image_path = f"grids/{resource_id}.png"
        grid.status = "splitting"
        grid_manager.save(grid)

        grid_image = Image.open(image_path)
        video_aspect_ratio = gt.get_aspect_ratio(project, "videos")
        cells = split_grid_image(grid_image, grid.rows, grid.cols, video_aspect_ratio)

        storyboards_dir = project_path / "storyboards"
        storyboards_dir.mkdir(parents=True, exist_ok=True)

        def _assign_cells():
            asset_updates: list[tuple[str, str, str]] = []

            # 宫格已统一走普通图生视频（不再使用 first_last 模式），cell 仅作为
            # next_scene_id 的起始分镜图，文件名与普通分镜对齐为 scene_{id}.png。
            for cell, frame in zip(cells, grid.frame_chain):
                if frame.frame_type == "placeholder":
                    continue
                if frame.frame_type not in ("first", "transition"):
                    continue
                if not frame.next_scene_id:
                    continue

                cell_rel = f"storyboards/scene_{frame.next_scene_id}.png"
                cell_path = storyboards_dir / f"scene_{frame.next_scene_id}.png"
                cell.save(cell_path, format="PNG")
                frame.image_path = cell_rel
                asset_updates.append((frame.next_scene_id, "storyboard_image", cell_rel))
                asset_updates.append((frame.next_scene_id, "grid_id", resource_id))
                asset_updates.append((frame.next_scene_id, "grid_cell_index", frame.index))

            if asset_updates:
                manager.batch_update_scene_assets(
                    project_name=project_name,
                    script_filename=script_file,
                    updates=asset_updates,
                )

        await asyncio.to_thread(_assign_cells)

        grid.status = "completed"
        grid_manager.save(grid)

    except Exception:
        grid.status = "failed"
        grid.error_message = traceback.format_exc()
        grid_manager.save(grid)
        raise

    created_at = grid.created_at

    return {
        "version": version,
        "file_path": f"grids/{resource_id}.png",
        "created_at": created_at,
        "resource_type": "grids",
        "resource_id": resource_id,
    }


__all__ = [
    "_collect_grid_reference_images",
    "_group_scenes_by_segment_break",
    "_resolve_grid_script_path",
    "execute_grid_task",
]
