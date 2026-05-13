"""Per-task generation executors.

Extracted from ``generation_tasks.py``. Each ``execute_*`` is the body invoked by
the worker for a given ``task_type``; they're indexed in ``_TASK_EXECUTORS`` in
the main module.

Functions that tests monkeypatch on the main ``generation_tasks`` module
(``get_project_manager_for_user``, ``get_media_generator``, ``extract_video_thumbnail``,
``_resolve_effective_image_backend``, ``resolve_credential_user_id``, etc.) are
looked up via the deferred ``_gt()`` accessor so those patches still apply.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from lib.asset_types import ASSET_SPECS
from lib.config.registry import PROVIDER_REGISTRY
from lib.content_workflows import get_workflow_preset
from lib.db.base import DEFAULT_USER_ID
from lib.default_duration import normalize_project_default_duration
from lib.model_rules import append_model_rule_for_model
from lib.prompt_builders import build_character_prompt, build_prop_prompt, build_scene_prompt
from lib.prompt_utils import (
    image_prompt_to_yaml,
    is_structured_image_prompt,
    is_structured_video_prompt,
    video_prompt_to_yaml,
)
from lib.storyboard_sequence import (
    build_previous_storyboard_reference,
    find_storyboard_item,
    get_storyboard_items,
    resolve_previous_storyboard_path,
)
from server.services.resolution_resolver import resolve_resolution


def _gt():
    """Deferred lookup of generation_tasks helpers to avoid circular import.

    Reading attributes through this proxy is what makes test monkeypatches on
    ``generation_tasks`` (e.g. ``get_project_manager_for_user``,
    ``get_media_generator``, ``extract_video_thumbnail``) flow through to these
    executors.
    """
    from server.services import generation_tasks as _main

    return _main


# ---------------------------------------------------------------------------
# Aspect ratio + prompt normalization
# ---------------------------------------------------------------------------


def get_aspect_ratio(project: dict, resource_type: str) -> str:
    if resource_type == "characters":
        return "3:4"
    if resource_type in ("scenes", "props"):
        return "16:9"
    # 优先读顶层字段；缺失时按内容类型预设推导，最后按 content_mode 兼容旧项目。
    val = project.get("aspect_ratio")
    if isinstance(val, str):
        return val
    if isinstance(val, dict) and resource_type in val:
        return val[resource_type]
    content_type = project.get("content_type")
    workflow_preset = get_workflow_preset(content_type if isinstance(content_type, str) else None)
    if workflow_preset is not None:
        return workflow_preset.aspect_ratio
    return "9:16" if project.get("content_mode", "narration") == "narration" else "16:9"


def _normalize_storyboard_prompt(prompt: str | dict, style: str) -> str:
    if isinstance(prompt, str):
        if not prompt.strip():
            raise ValueError("prompt must not be empty")
        return prompt

    if not isinstance(prompt, dict):
        raise ValueError("prompt must be a string or object")

    if not is_structured_image_prompt(prompt):
        raise ValueError("prompt must be a string or include scene/composition")

    scene_text = str(prompt.get("scene", "")).strip()
    if not scene_text:
        raise ValueError("prompt.scene must not be empty")

    composition = prompt.get("composition") if isinstance(prompt.get("composition"), dict) else {}
    normalized_prompt = {
        "scene": scene_text,
        "composition": {
            "shot_type": str(composition.get("shot_type") or "Medium Shot"),
            "lighting": str(composition.get("lighting", "") or ""),
            "ambiance": str(composition.get("ambiance", "") or ""),
        },
    }
    return image_prompt_to_yaml(normalized_prompt, style)


def _normalize_video_prompt(prompt: str | dict) -> str:
    if isinstance(prompt, str):
        if not prompt.strip():
            raise ValueError("prompt must not be empty")
        return prompt

    if not isinstance(prompt, dict):
        raise ValueError("prompt must be a string or object")

    if not is_structured_video_prompt(prompt):
        raise ValueError("prompt must be a string or include action/camera_motion")

    action_text = str(prompt.get("action", "")).strip()
    if not action_text:
        raise ValueError("prompt.action must not be empty")

    dialogue = prompt.get("dialogue", [])
    if dialogue is None:
        dialogue = []
    if not isinstance(dialogue, list):
        raise ValueError("prompt.dialogue must be an array")

    normalized_dialogue = []
    for item in dialogue:
        if not isinstance(item, dict):
            continue
        speaker = str(item.get("speaker", "") or "").strip()
        line = str(item.get("line", "") or "").strip()
        if speaker or line:
            normalized_dialogue.append({"speaker": speaker, "line": line})

    normalized_prompt: dict[str, Any] = {
        "action": action_text,
        "camera_motion": str(prompt.get("camera_motion", "") or "") or "Static",
        "ambiance_audio": str(prompt.get("ambiance_audio", "") or ""),
        "dialogue": normalized_dialogue,
    }
    return video_prompt_to_yaml(normalized_prompt)


# ---------------------------------------------------------------------------
# Reference image collection
# ---------------------------------------------------------------------------


def _get_model_default_duration(provider_name: str, model_name: str | None) -> int:
    """从 PROVIDER_REGISTRY 查找模型的 supported_durations[0]，找不到则 fallback 4。"""
    provider_meta = PROVIDER_REGISTRY.get(provider_name)
    if provider_meta and model_name:
        model_info = provider_meta.models.get(model_name)
        if model_info and model_info.supported_durations:
            return model_info.supported_durations[0]
    # 自定义供应商或 registry 中无此模型时 fallback
    return 4


def _collect_sheet_paths(
    project: dict,
    project_path: Path,
    items: list[dict],
    *,
    char_field: str,
    scene_field: str,
    prop_field: str,
    max_count: int = 0,
) -> tuple[list[Path], set[str]]:
    """Collect character_sheet, scene_sheet and prop_sheet paths from scene/segment items.

    Returns (list of existing Paths, set of relative sheet strings for dedup).
    If *max_count* > 0 collection stops after that many images.
    """
    seen: set[str] = set()
    paths: list[Path] = []

    characters = project.get("characters", {})
    project_scenes = project.get("scenes", {})
    project_props = project.get("props", {})

    for item in items:
        for char_name in item.get(char_field, []):
            sheet = characters.get(char_name, {}).get("character_sheet")
            if sheet and sheet not in seen:
                path = project_path / sheet
                if path.exists():
                    paths.append(path)
                    seen.add(sheet)
        for scene_name in item.get(scene_field, []):
            sheet = project_scenes.get(scene_name, {}).get("scene_sheet")
            if sheet and sheet not in seen:
                path = project_path / sheet
                if path.exists():
                    paths.append(path)
                    seen.add(sheet)
        for prop_name in item.get(prop_field, []):
            sheet = project_props.get(prop_name, {}).get("prop_sheet")
            if sheet and sheet not in seen:
                path = project_path / sheet
                if path.exists():
                    paths.append(path)
                    seen.add(sheet)
        if max_count and len(paths) >= max_count:
            break

    return paths, seen


def _collect_reference_images(
    project: dict,
    project_path: Path,
    target_item: dict,
    *,
    char_field: str,
    scene_field: str,
    prop_field: str,
    extra_reference_images: list[str] | None = None,
    previous_storyboard_path: Path | None = None,
) -> list[object] | None:
    sheet_paths, _ = _collect_sheet_paths(
        project, project_path, [target_item], char_field=char_field, scene_field=scene_field, prop_field=prop_field
    )
    reference_images: list[object] = list(sheet_paths)

    for extra in extra_reference_images or []:
        extra_path = Path(extra)
        if not extra_path.is_absolute():
            extra_path = project_path / extra_path
        if extra_path.exists():
            reference_images.append(extra_path)

    if previous_storyboard_path and previous_storyboard_path.exists():
        reference_images.append(build_previous_storyboard_reference(previous_storyboard_path))

    return reference_images or None


# ---------------------------------------------------------------------------
# Executors
# ---------------------------------------------------------------------------


async def execute_storyboard_task(
    project_name: str, resource_id: str, payload: dict[str, Any], *, user_id: str = DEFAULT_USER_ID
) -> dict[str, Any]:
    gt = _gt()
    script_file = payload.get("script_file")
    if not script_file:
        raise ValueError("script_file is required for storyboard task")

    prompt = payload.get("prompt")
    if prompt is None:
        raise ValueError("prompt is required for storyboard task")

    def _prepare():
        _pm = gt.get_project_manager_for_user(user_id)
        _project = _pm.load_project(project_name)
        _project_path = _pm.get_project_path(project_name)
        _script = _pm.load_script(project_name, script_file)
        _items, _id_field, _char_field, _scene_field, _prop_field = get_storyboard_items(_script)

        _resolved = find_storyboard_item(_items, _id_field, resource_id)
        if _resolved is None:
            raise ValueError(f"scene/segment not found: {resource_id}")
        _target_item, _ = _resolved

        _prev_path = resolve_previous_storyboard_path(_project_path, _items, _id_field, resource_id)
        _prompt_text = _normalize_storyboard_prompt(prompt, _project.get("style", ""))
        _ref_images = _collect_reference_images(
            _project,
            _project_path,
            _target_item,
            char_field=_char_field,
            scene_field=_scene_field,
            prop_field=_prop_field,
            extra_reference_images=payload.get("extra_reference_images") or [],
            previous_storyboard_path=_prev_path,
        )
        return _project, _project_path, _prompt_text, _ref_images

    project, project_path, prompt_text, reference_images = await asyncio.to_thread(_prepare)

    generator = await gt.get_media_generator(
        project_name,
        payload=payload,
        user_id=user_id,
    )
    aspect_ratio = get_aspect_ratio(project, "storyboards")

    image_provider_id, image_model_id = await gt._resolve_effective_image_backend(project, payload, user_id=user_id)
    image_size = await resolve_resolution(project, image_provider_id, image_model_id)
    prompt_text = await append_model_rule_for_model(
        prompt_text,
        provider_id=image_provider_id,
        model_id=image_model_id,
        media_type="image",
        user_id=gt.resolve_credential_user_id(project, user_id),
    )

    _, version = await generator.generate_image_async(
        prompt=prompt_text,
        resource_type="storyboards",
        resource_id=resource_id,
        reference_images=reference_images,
        aspect_ratio=aspect_ratio,
        image_size=image_size,
    )

    def _finalize():
        gt.get_project_manager_for_user(user_id).update_scene_asset(
            project_name=project_name,
            script_filename=script_file,
            scene_id=resource_id,
            asset_type="storyboard_image",
            asset_path=f"storyboards/scene_{resource_id}.png",
        )
        return generator.versions.get_versions("storyboards", resource_id)["versions"][-1]["created_at"]

    created_at = await asyncio.to_thread(_finalize)

    return {
        "version": version,
        "file_path": f"storyboards/scene_{resource_id}.png",
        "created_at": created_at,
        "resource_type": "storyboards",
        "resource_id": resource_id,
    }


async def execute_video_task(
    project_name: str, resource_id: str, payload: dict[str, Any], *, user_id: str = DEFAULT_USER_ID
) -> dict[str, Any]:
    gt = _gt()
    script_file = payload.get("script_file")
    if not script_file:
        raise ValueError("script_file is required for video task")

    prompt = payload.get("prompt")
    if prompt is None:
        raise ValueError("prompt is required for video task")

    def _load():
        _pm = gt.get_project_manager_for_user(user_id)
        _project = _pm.load_project(project_name)
        _project_path = _pm.get_project_path(project_name)
        _script = _pm.load_script(project_name, script_file)
        _items, _id_field, _, _, _ = get_storyboard_items(_script)
        _resolved = find_storyboard_item(_items, _id_field, resource_id)
        _item = _resolved[0] if _resolved else {}
        return _project, _project_path, _item

    project, project_path, item = await asyncio.to_thread(_load)
    generator = await gt.get_media_generator(project_name, payload=payload, user_id=user_id)

    # 优先读取 generated_assets.storyboard_image，回退默认路径。
    # 旧宫格项目 storyboard_image 指向 scene_{id}_first.png，仍可正常解析。
    assets = item.get("generated_assets", {})
    storyboard_rel = assets.get("storyboard_image") if isinstance(assets, dict) else None
    if storyboard_rel:
        storyboard_file = project_path / storyboard_rel
    else:
        storyboard_file = project_path / "storyboards" / f"scene_{resource_id}.png"
    if not storyboard_file.exists():
        raise ValueError(f"storyboard not found: {storyboard_file.name}")

    prompt_text = _normalize_video_prompt(prompt)
    aspect_ratio = get_aspect_ratio(project, "videos")
    seed = payload.get("seed")
    service_tier = payload.get("video_provider_settings", {}).get("service_tier", "default")

    # 解析 provider / model，供 duration fallback 和分辨率查找共用
    provider_settings = payload.get("video_provider_settings", {})
    model_name = provider_settings.get("model")
    # payload 中 video_provider 由任务入队时设置；project 中存的是 video_backend（"provider/model" 格式）
    provider_name = payload.get("video_provider")
    registry_provider_id = provider_name  # 用于 PROVIDER_REGISTRY 查找的原始 provider_id
    if not provider_name:
        video_backend = project.get("video_backend") or ""
        if "/" in video_backend:
            provider_name, model_name = video_backend.split("/", 1)
            registry_provider_id = provider_name
    if not provider_name:
        from lib.config.resolver import ConfigResolver
        from lib.db import async_session_factory

        _resolver = ConfigResolver(async_session_factory, user_id=gt.resolve_credential_user_id(project, user_id))
        try:
            default_provider_id, default_model_id = await _resolver.default_video_backend()
        except Exception:
            default_provider_id, default_model_id = "gemini-aistudio", "veo-3.1-lite-generate-preview"
        registry_provider_id = default_provider_id
        model_name = model_name or default_model_id
        provider_name = gt._VIDEO_PROVIDER_ID_TO_BACKEND.get(default_provider_id, default_provider_id)

    resolution = await resolve_resolution(
        project,
        registry_provider_id or provider_name,
        model_name or "",
    )

    # duration fallback: payload > explicit project.default_duration > supported_durations[0] > 4
    duration_seconds = payload.get("duration_seconds") or normalize_project_default_duration(project)
    if not duration_seconds:
        duration_seconds = _get_model_default_duration(registry_provider_id, model_name)

    prompt_text = await append_model_rule_for_model(
        prompt_text,
        provider_id=registry_provider_id or provider_name,
        model_id=model_name or "",
        backend_name=provider_name,
        media_type="video",
        user_id=gt.resolve_credential_user_id(project, user_id),
    )

    end_image = None  # 宫格模式不再使用首尾帧，统一走普通图生视频

    _, version, _, video_uri = await generator.generate_video_async(
        prompt=prompt_text,
        resource_type="videos",
        resource_id=resource_id,
        start_image=storyboard_file,
        end_image=end_image,
        aspect_ratio=aspect_ratio,
        duration_seconds=duration_seconds,
        resolution=resolution,
        seed=seed,
        service_tier=service_tier,
    )

    def _update_video_metadata():
        _pm = gt.get_project_manager_for_user(user_id)
        _pm.update_scene_asset(
            project_name=project_name,
            script_filename=script_file,
            scene_id=resource_id,
            asset_type="video_clip",
            asset_path=f"videos/scene_{resource_id}.mp4",
        )
        if video_uri:
            _pm.update_scene_asset(
                project_name=project_name,
                script_filename=script_file,
                scene_id=resource_id,
                asset_type="video_uri",
                asset_path=video_uri,
            )

    await asyncio.to_thread(_update_video_metadata)

    # 提取视频首帧作为缩略图
    video_file = project_path / f"videos/scene_{resource_id}.mp4"
    thumbnail_file = project_path / f"thumbnails/scene_{resource_id}.jpg"
    if await gt.extract_video_thumbnail(video_file, thumbnail_file):
        await asyncio.to_thread(
            gt.get_project_manager_for_user(user_id).update_scene_asset,
            project_name=project_name,
            script_filename=script_file,
            scene_id=resource_id,
            asset_type="video_thumbnail",
            asset_path=f"thumbnails/scene_{resource_id}.jpg",
        )
    else:
        thumbnail_file.unlink(missing_ok=True)

    created_at = await asyncio.to_thread(
        lambda: generator.versions.get_versions("videos", resource_id)["versions"][-1]["created_at"]
    )

    return {
        "version": version,
        "file_path": f"videos/scene_{resource_id}.mp4",
        "created_at": created_at,
        "resource_type": "videos",
        "resource_id": resource_id,
        "video_uri": video_uri,
    }


async def execute_character_task(
    project_name: str, resource_id: str, payload: dict[str, Any], *, user_id: str = DEFAULT_USER_ID
) -> dict[str, Any]:
    gt = _gt()
    prompt = str(payload.get("prompt", "") or "").strip()
    if not prompt:
        raise ValueError("prompt is required for character task")

    def _prepare_char():
        _pm = gt.get_project_manager_for_user(user_id)
        _project = _pm.load_project(project_name)
        _project_path = _pm.get_project_path(project_name)
        if resource_id not in _project.get("characters", {}):
            raise ValueError(f"character not found: {resource_id}")
        _char_data = _project["characters"][resource_id]
        _style = _project.get("style", "")
        _style_desc = _project.get("style_description", "")
        _character_style = _project.get("character_style_prompt", "")
        _full_prompt = build_character_prompt(
            resource_id,
            prompt,
            _style,
            _style_desc,
            str(_character_style or ""),
        )
        _ref_images = None
        _ref_path = _char_data.get("reference_image")
        if _ref_path:
            _full_ref = _project_path / _ref_path
            if _full_ref.exists():
                _ref_images = [_full_ref]
        return _project, _full_prompt, _ref_images

    project, full_prompt, reference_images = await asyncio.to_thread(_prepare_char)

    generator = await gt.get_media_generator(project_name, payload=payload, user_id=user_id)
    aspect_ratio = get_aspect_ratio(project, "characters")

    image_provider_id, image_model_id = await gt._resolve_effective_image_backend(project, payload, user_id=user_id)
    image_size = await resolve_resolution(project, image_provider_id, image_model_id)
    full_prompt = await append_model_rule_for_model(
        full_prompt,
        provider_id=image_provider_id,
        model_id=image_model_id,
        media_type="image",
        user_id=gt.resolve_credential_user_id(project, user_id),
    )

    _, version = await generator.generate_image_async(
        prompt=full_prompt,
        resource_type="characters",
        resource_id=resource_id,
        reference_images=reference_images,
        aspect_ratio=aspect_ratio,
        image_size=image_size,
    )

    sheet_path = f"characters/{resource_id}.png"

    def _finalize_char():
        def _set_character_sheet(p: dict) -> None:
            p["characters"][resource_id]["character_sheet"] = sheet_path

        gt.get_project_manager_for_user(user_id).update_project(project_name, _set_character_sheet)
        return generator.versions.get_versions("characters", resource_id)["versions"][-1]["created_at"]

    created_at = await asyncio.to_thread(_finalize_char)

    return {
        "version": version,
        "file_path": f"characters/{resource_id}.png",
        "created_at": created_at,
        "resource_type": "characters",
        "resource_id": resource_id,
    }


# 仅保留 design 任务的「prompt 构造器」差异；bucket_key 与 sheet 写入由 ASSET_SPECS 与
# ProjectManager._update_asset_sheet 统一派发。
_DESIGN_PROMPT_BUILDERS: dict[str, Any] = {
    "scene": build_scene_prompt,
    "prop": build_prop_prompt,
}


async def execute_design_task(
    kind: str,
    project_name: str,
    resource_id: str,
    payload: dict[str, Any],
    *,
    user_id: str = DEFAULT_USER_ID,
) -> dict[str, Any]:
    """合并 execute_scene_task / execute_prop_task：按 kind 查表派发。"""
    gt = _gt()
    spec = ASSET_SPECS[kind]
    bucket_key = spec.bucket_key
    prompt_builder = _DESIGN_PROMPT_BUILDERS[kind]

    prompt = str(payload.get("prompt", "") or "").strip()
    if not prompt:
        raise ValueError(f"prompt is required for {kind} task")

    def _prepare():
        project = gt.get_project_manager_for_user(user_id).load_project(project_name)
        if resource_id not in project.get(bucket_key, {}):
            raise ValueError(f"{kind} not found: {resource_id}")
        style = project.get("style", "")
        style_desc = project.get("style_description", "")
        full_prompt = prompt_builder(resource_id, prompt, style, style_desc)
        return project, full_prompt

    project, full_prompt = await asyncio.to_thread(_prepare)

    generator = await gt.get_media_generator(project_name, payload=payload, user_id=user_id)
    aspect_ratio = get_aspect_ratio(project, bucket_key)

    image_provider_id, image_model_id = await gt._resolve_effective_image_backend(project, payload, user_id=user_id)
    image_size = await resolve_resolution(project, image_provider_id, image_model_id)
    full_prompt = await append_model_rule_for_model(
        full_prompt,
        provider_id=image_provider_id,
        model_id=image_model_id,
        media_type="image",
        user_id=gt.resolve_credential_user_id(project, user_id),
    )

    _, version = await generator.generate_image_async(
        prompt=full_prompt,
        resource_type=bucket_key,
        resource_id=resource_id,
        aspect_ratio=aspect_ratio,
        image_size=image_size,
    )

    sheet_path = f"{bucket_key}/{resource_id}.png"

    def _finalize():
        gt.get_project_manager_for_user(user_id)._update_asset_sheet(kind, project_name, resource_id, sheet_path)
        return generator.versions.get_versions(bucket_key, resource_id)["versions"][-1]["created_at"]

    created_at = await asyncio.to_thread(_finalize)

    return {
        "version": version,
        "file_path": sheet_path,
        "created_at": created_at,
        "resource_type": bucket_key,
        "resource_id": resource_id,
    }


async def execute_scene_task(
    project_name: str, resource_id: str, payload: dict[str, Any], *, user_id: str = DEFAULT_USER_ID
) -> dict[str, Any]:
    return await execute_design_task("scene", project_name, resource_id, payload, user_id=user_id)


async def execute_prop_task(
    project_name: str, resource_id: str, payload: dict[str, Any], *, user_id: str = DEFAULT_USER_ID
) -> dict[str, Any]:
    return await execute_design_task("prop", project_name, resource_id, payload, user_id=user_id)


__all__ = [
    "_DESIGN_PROMPT_BUILDERS",
    "_collect_reference_images",
    "_collect_sheet_paths",
    "_get_model_default_duration",
    "_normalize_storyboard_prompt",
    "_normalize_video_prompt",
    "execute_character_task",
    "execute_design_task",
    "execute_prop_task",
    "execute_scene_task",
    "execute_storyboard_task",
    "execute_video_task",
    "get_aspect_ratio",
]
