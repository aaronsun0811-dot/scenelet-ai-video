from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import pytest
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import lib
import lib.config.resolver as config_resolver_module
import lib.db as db_module
import lib.generation_queue as generation_queue_module
import lib.script_generator as script_generator_module
import lib.text_backends.factory as text_factory_module
import lib.usage_tracker as usage_tracker_module
import server.routers.generate as generate_router
import server.services.billing as billing_module
import server.services.generation_tasks as generation_tasks_module
import server.services.reference_video_tasks as reference_video_tasks_module
from lib.config.service import ConfigService
from lib.content_workflows import preset_project_defaults
from lib.db.base import PLATFORM_USER_ID, Base
from lib.db.repositories.credential_repository import CredentialRepository
from lib.db.repositories.credit_repository import CreditRepository
from lib.generation_queue import GenerationQueue
from lib.generation_worker import GenerationWorker
from lib.project_manager import ProjectManager
from lib.script_generator import ScriptGenerator
from lib.storyboard_sequence import find_storyboard_item, get_storyboard_items
from lib.style_templates import resolve_template_prompt
from server.auth import CurrentUserInfo
from server.routers.generate import GenerationPreflightRequest
from server.services.billing import (
    ensure_platform_credits_balance,
    estimate_generation_task_credits,
    reserve_platform_credits_for_task_or_cancel,
)
from server.services.project_archive import ProjectArchiveService
from tests.conftest import make_translator

USER_ID = "qa-platform-user"
QA_TEXT_BACKEND = "qa-fake/qa-fake-text"
QA_IMAGE_BACKEND = "qa-fake/qa-fake-image"
QA_VIDEO_BACKEND = "qa-fake/qa-fake-video"


@pytest.fixture
async def qa_fake_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    root = tmp_path / "workspace"
    projects_root = root / "projects"
    manager = ProjectManager(projects_root)
    queue = GenerationQueue(session_factory=factory)

    monkeypatch.setattr(lib, "PROJECT_ROOT", root)
    monkeypatch.setattr(db_module, "async_session_factory", factory)
    monkeypatch.setattr(db_module, "safe_session_factory", factory)
    monkeypatch.setattr(usage_tracker_module, "safe_session_factory", factory)
    monkeypatch.setattr(text_factory_module, "async_session_factory", factory)
    monkeypatch.setattr(script_generator_module, "async_session_factory", factory)
    monkeypatch.setattr(config_resolver_module, "_project_manager", manager)
    monkeypatch.setattr(billing_module, "async_session_factory", factory)
    monkeypatch.setattr(generation_tasks_module, "pm", manager)
    monkeypatch.setattr(reference_video_tasks_module, "async_session_factory", factory)
    monkeypatch.setattr(generate_router, "pm", manager)
    monkeypatch.setattr(generate_router, "async_session_factory", factory)
    monkeypatch.setattr(generation_queue_module, "_QUEUE_INSTANCE", queue)
    generation_tasks_module.invalidate_backend_cache()

    async with factory() as session:
        svc = ConfigService(session, user_id=PLATFORM_USER_ID)
        await svc.set_setting("default_text_backend", QA_TEXT_BACKEND)
        await svc.set_setting("text_backend_script", QA_TEXT_BACKEND)
        await svc.set_setting("text_backend_overview", QA_TEXT_BACKEND)
        await svc.set_setting("text_backend_style", QA_TEXT_BACKEND)
        await svc.set_setting("default_image_backend", QA_IMAGE_BACKEND)
        await svc.set_setting("default_video_backend", QA_VIDEO_BACKEND)

        platform_creds = CredentialRepository(session, user_id=PLATFORM_USER_ID)
        await platform_creds.create("qa-fake", "QA Fake", api_key="qa-fake")
        user_creds = CredentialRepository(session, user_id=USER_ID)
        await user_creds.create("qa-fake", "QA Fake", api_key="qa-fake")
        await CreditRepository(session, user_id=USER_ID).add_entry(amount=100_000, kind="grant")
        await session.commit()

    yield {
        "factory": factory,
        "manager": manager,
        "queue": queue,
        "worker": GenerationWorker(queue=queue),
    }

    generation_tasks_module.invalidate_backend_cache()
    await engine.dispose()


def _write_source(project_dir: Path, content_type: str) -> None:
    source = project_dir / "source" / "qa.md"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(
        f"QA source for {content_type}. 林遥带着红色行李箱来到城市路口，准备沿路线出发。",
        encoding="utf-8",
    )


def _write_reference_images(project_dir: Path, count: int = 10) -> list[str]:
    refs: list[str] = []
    ref_dir = project_dir / "travel_references"
    ref_dir.mkdir(parents=True, exist_ok=True)
    for index in range(1, count + 1):
        rel = f"travel_references/ref-{index:02d}.png"
        path = project_dir / rel
        image = Image.new("RGB", (320, 180), (40 + index * 9, 90, 140))
        image.save(path)
        refs.append(rel)
    return refs


def _create_project(manager: ProjectManager, name: str, content_type: str) -> Path:
    scoped = manager.for_user(USER_ID)
    project_dir = scoped.create_project(name)
    defaults = preset_project_defaults(content_type)
    extras = {
        **defaults,
        "style": resolve_template_prompt(str(defaults.get("style_template_id") or "")),
        "owner_user_id": USER_ID,
        "billing_mode": "platform_credits",
        "image_backend": QA_IMAGE_BACKEND,
        "video_backend": QA_VIDEO_BACKEND,
        "text_backend_script": QA_TEXT_BACKEND,
        "text_backend_overview": QA_TEXT_BACKEND,
        "text_backend_style": QA_TEXT_BACKEND,
    }
    if content_type == "travel_video":
        refs = _write_reference_images(project_dir, count=10)
        extras["travel_video_settings"] = {
            "route_source": "reference_images",
            "origin": "外滩",
            "destination": "人民广场",
            "route_notes": "从外滩沿南京东路步行到人民广场，路牌和街景连续。",
            "reference_images": refs,
            "target_duration": "45s",
            "orientation": "16:9",
            "route_preview": {
                "route_ready": True,
                "summary": "外滩到人民广场步行路线",
                "distance_text": "2.5 km",
                "duration_text": "35 min",
                "reference_images": refs,
            },
        }
    scoped.create_project_metadata(name, f"QA {content_type}", extras=extras)
    _write_source(project_dir, content_type)
    if content_type == "travel_video":
        _mark_travel_references_applied(scoped, name)
    return project_dir


def _mark_travel_references_applied(manager: ProjectManager, project_name: str) -> None:
    project_dir = manager.get_project_path(project_name)
    project = manager.load_project(project_name)
    refs = project["travel_video_settings"]["reference_images"]
    scenes_dir = project_dir / "scenes"
    scenes_dir.mkdir(parents=True, exist_ok=True)
    scenes = project.setdefault("scenes", {})
    for index, ref in enumerate(refs, 1):
        scene_name = f"路线参考{index:02d}"
        scene_rel = f"scenes/route-ref-{index:02d}.png"
        shutil.copyfile(project_dir / ref, project_dir / scene_rel)
        scenes[scene_name] = {
            "description": f"旅游路线参考图 {index}",
            "scene_sheet": scene_rel,
            "asset_source": {
                "kind": "asset_library",
                "asset_id": f"qa-ref-{index:02d}",
                "asset_type": "scene",
                "source_kind": "travel_reference",
                "source_project": project_name,
                "source_file": ref,
            },
        }
    manager.save_project(project_name, project)


async def _prepare_text_flow(manager: ProjectManager, project_name: str) -> dict[str, Any]:
    scoped = manager.for_user(USER_ID)
    await scoped.generate_overview(project_name, user_id=USER_ID)
    await scoped.generate_characters(project_name, user_id=USER_ID)
    await scoped.generate_scenes(project_name, user_id=USER_ID)
    await scoped.generate_props(project_name, user_id=USER_ID)
    await scoped.generate_episode_draft(project_name, 1, user_id=USER_ID)
    generator = await ScriptGenerator.create(scoped.get_project_path(project_name), user_id=USER_ID)
    script_path = await generator.generate(1)
    scoped.sync_episode_from_script(project_name, script_path.name)
    return scoped.load_script(project_name, script_path.name)


async def _process_queued_task(
    *,
    queue: GenerationQueue,
    worker: GenerationWorker,
    manager: ProjectManager,
    project_name: str,
    task_type: str,
    media_type: str,
    resource_id: str,
    payload: dict[str, Any],
    script_file: str | None = None,
    expect_status: str = "succeeded",
) -> dict[str, Any]:
    project = manager.for_user(USER_ID).load_project(project_name)
    required = await estimate_generation_task_credits(
        project,
        task_type,
        payload,
        user_id=USER_ID,
        project_name=project_name,
    )
    await ensure_platform_credits_balance(project, USER_ID, required_credits=required)
    enqueued = await queue.enqueue_task(
        project_name=project_name,
        task_type=task_type,
        media_type=media_type,
        resource_id=resource_id,
        payload=payload,
        script_file=script_file,
        source="qa",
        user_id=USER_ID,
    )
    if not enqueued.get("deduped"):
        await reserve_platform_credits_for_task_or_cancel(
            project,
            USER_ID,
            task_id=enqueued["task_id"],
            required_credits=required,
            task_type=task_type,
            project_name=project_name,
            queue=queue,
        )
    task = await queue.claim_next_task(media_type)
    assert task is not None
    assert task["task_id"] == enqueued["task_id"]
    await worker._process_task(task)
    saved = await queue.get_task(enqueued["task_id"], user_id=USER_ID)
    assert saved is not None
    assert saved["status"] == expect_status
    return saved


async def _retry_failed_task(
    *,
    queue: GenerationQueue,
    worker: GenerationWorker,
    manager: ProjectManager,
    project_name: str,
    failed_task_id: str,
    task_type: str,
    media_type: str,
    clean_payload: dict[str, Any],
) -> dict[str, Any]:
    async def refresh(_payload: dict[str, Any], _task: dict[str, Any]) -> dict[str, Any]:
        return clean_payload

    retry = await queue.retry_failed_task(failed_task_id, user_id=USER_ID, payload_refresh=refresh)
    project = manager.for_user(USER_ID).load_project(project_name)
    required = await estimate_generation_task_credits(
        project,
        task_type,
        clean_payload,
        user_id=USER_ID,
        project_name=project_name,
    )
    await reserve_platform_credits_for_task_or_cancel(
        project,
        USER_ID,
        task_id=retry["task_id"],
        required_credits=required,
        task_type=task_type,
        project_name=project_name,
        queue=queue,
    )
    task = await queue.claim_next_task(media_type)
    assert task is not None
    assert task["task_id"] == retry["task_id"]
    await worker._process_task(task)
    saved = await queue.get_task(retry["task_id"], user_id=USER_ID)
    assert saved is not None
    assert saved["status"] == "succeeded"
    return saved


async def _generate_assets_for_project(env: dict[str, Any], project_name: str) -> None:
    manager: ProjectManager = env["manager"]
    project = manager.for_user(USER_ID).load_project(project_name)
    for name, data in project.get("characters", {}).items():
        await _process_queued_task(
            queue=env["queue"],
            worker=env["worker"],
            manager=manager,
            project_name=project_name,
            task_type="character",
            media_type="image",
            resource_id=name,
            payload={"prompt": data.get("description") or "QA character"},
        )
    for name, data in project.get("scenes", {}).items():
        if data.get("scene_sheet"):
            continue
        await _process_queued_task(
            queue=env["queue"],
            worker=env["worker"],
            manager=manager,
            project_name=project_name,
            task_type="scene",
            media_type="image",
            resource_id=name,
            payload={"prompt": data.get("description") or "QA scene"},
        )
    for name, data in project.get("props", {}).items():
        await _process_queued_task(
            queue=env["queue"],
            worker=env["worker"],
            manager=manager,
            project_name=project_name,
            task_type="prop",
            media_type="image",
            resource_id=name,
            payload={"prompt": data.get("description") or "QA prop"},
        )


async def _generate_storyboard_project(env: dict[str, Any], project_name: str, script: dict[str, Any]) -> None:
    items, id_field, _, _, _ = get_storyboard_items(script)
    item = items[0]
    resource_id = item[id_field]
    script_file = "scripts/episode_1.json"
    storyboard_payload = {"prompt": item["image_prompt"], "script_file": script_file}
    if project_name.endswith("retry"):
        failed = await _process_queued_task(
            queue=env["queue"],
            worker=env["worker"],
            manager=env["manager"],
            project_name=project_name,
            task_type="storyboard",
            media_type="image",
            resource_id=resource_id,
            payload={**storyboard_payload, "prompt": "[qa-fake:fail] forced storyboard failure"},
            script_file=script_file,
            expect_status="failed",
        )
        await _retry_failed_task(
            queue=env["queue"],
            worker=env["worker"],
            manager=env["manager"],
            project_name=project_name,
            failed_task_id=failed["task_id"],
            task_type="storyboard",
            media_type="image",
            clean_payload=storyboard_payload,
        )
    else:
        await _process_queued_task(
            queue=env["queue"],
            worker=env["worker"],
            manager=env["manager"],
            project_name=project_name,
            task_type="storyboard",
            media_type="image",
            resource_id=resource_id,
            payload=storyboard_payload,
            script_file=script_file,
        )
    fresh_script = env["manager"].for_user(USER_ID).load_script(project_name, script_file)
    fresh_item = find_storyboard_item(get_storyboard_items(fresh_script)[0], id_field, resource_id)[0]
    await _process_queued_task(
        queue=env["queue"],
        worker=env["worker"],
        manager=env["manager"],
        project_name=project_name,
        task_type="video",
        media_type="video",
        resource_id=resource_id,
        payload={"prompt": fresh_item["video_prompt"], "script_file": script_file, "duration_seconds": 4},
        script_file=script_file,
    )


async def _generate_reference_project(env: dict[str, Any], project_name: str, script: dict[str, Any]) -> None:
    unit = script["video_units"][0]
    await _process_queued_task(
        queue=env["queue"],
        worker=env["worker"],
        manager=env["manager"],
        project_name=project_name,
        task_type="reference_video",
        media_type="video",
        resource_id=unit["unit_id"],
        payload={"script_file": "scripts/episode_1.json"},
        script_file="scripts/episode_1.json",
    )


async def _assert_generation_preflight_green(project_name: str) -> None:
    response = await generate_router.generation_preflight(
        project_name,
        GenerationPreflightRequest(task_type="workflow", payload={}, count=1),
        CurrentUserInfo(id=USER_ID, sub=USER_ID, role="admin"),
        make_translator("zh"),
    )
    assert response.can_submit is True
    assert response.billing_mode == "platform_credits"
    assert not response.blocking
    assert not any(item.code == "travel_reference_scene_assets_incomplete" for item in response.warnings)


async def _assert_credits_closed(factory: Any, initial_balance: int) -> None:
    async with factory() as session:
        repo = CreditRepository(session, user_id=USER_ID)
        assert await repo.get_reserved_generation_credits() == 0
        assert await repo.get_balance() < initial_balance


@pytest.mark.parametrize(
    ("content_type", "project_suffix"),
    [
        ("short_drama", "retry"),
        ("scene_sketch", "green"),
        ("travel_video", "green"),
    ],
)
async def test_qa_fake_platform_generation_flow_runs_green(
    qa_fake_env: dict[str, Any],
    content_type: str,
    project_suffix: str,
):
    manager: ProjectManager = qa_fake_env["manager"]
    project_name = f"qa-{content_type.replace('_', '-')}-{project_suffix}"
    _create_project(manager, project_name, content_type)
    script = await _prepare_text_flow(manager, project_name)
    await _generate_assets_for_project(qa_fake_env, project_name)
    await _assert_generation_preflight_green(project_name)

    if content_type == "travel_video":
        await _generate_reference_project(qa_fake_env, project_name, script)
    else:
        await _generate_storyboard_project(qa_fake_env, project_name, script)

    scoped = manager.for_user(USER_ID)
    preflight = ProjectArchiveService(scoped).get_export_preflight(project_name, scope="current")
    assert preflight["diagnostics"]["blocking"] == []
    assert preflight["delivery_report"]["totals"]["videos_ready"] == 1
    if content_type == "travel_video":
        assert preflight["travel_route_assets"] is not None

    await _assert_credits_closed(qa_fake_env["factory"], 100_000)
