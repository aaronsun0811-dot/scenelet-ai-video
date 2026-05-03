from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from lib.db.base import Base
from lib.db.repositories.credit_repository import CreditRepository
from server.services import billing


@pytest.fixture
async def session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield factory
    await engine.dispose()


async def test_ensure_platform_credits_balance_uses_estimated_required_credits(
    session_factory,
    monkeypatch,
):
    monkeypatch.setattr(billing, "async_session_factory", session_factory)
    async with session_factory() as session:
        await CreditRepository(session, user_id="user-a").add_entry(amount=50, kind="grant")
        await session.commit()

    with pytest.raises(HTTPException) as exc:
        await billing.ensure_platform_credits_balance(
            {"billing_mode": "platform_credits"},
            "user-a",
            required_credits=67,
        )

    assert exc.value.status_code == 402
    assert "67" in str(exc.value.detail)


async def test_estimate_storyboard_credits_from_image_model():
    project = {
        "billing_mode": "platform_credits",
        "image_backend": "gemini-aistudio/gemini-3.1-flash-image-preview",
    }

    credits = await billing.estimate_generation_task_credits(
        project,
        "storyboard",
        {"image_provider": "gemini-aistudio", "image_model": "gemini-3.1-flash-image-preview"},
        user_id="user-a",
        project_name="demo",
    )

    assert credits == 67


async def test_estimate_video_credits_uses_duration_and_audio_flag():
    project = {
        "billing_mode": "platform_credits",
        "video_backend": "gemini-aistudio/veo-3.1-lite-generate-preview",
        "video_generate_audio": False,
    }

    credits = await billing.estimate_generation_task_credits(
        project,
        "video",
        {"duration_seconds": 8},
        user_id="user-a",
        project_name="demo",
    )

    assert credits == 640


async def test_resolve_video_backend_uses_loaded_project_audio_override(monkeypatch):
    calls: list[dict] = []

    class FakeResolver:
        def __init__(self, *_args, **_kwargs):
            pass

        def session(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def default_video_backend(self):
            return "gemini-aistudio", "veo-3.1-lite-generate-preview"

        async def video_generate_audio_from_project(self, project):
            calls.append(project)
            return project.get("video_generate_audio", True)

    monkeypatch.setattr("lib.config.resolver.ConfigResolver", FakeResolver)

    project = {
        "billing_mode": "platform_credits",
        "video_generate_audio": False,
    }
    provider, model, generate_audio = await billing._resolve_video_backend(
        project,
        {},
        user_id="user-a",
        project_name="demo",
    )

    assert provider == "gemini-aistudio"
    assert model == "veo-3.1-lite-generate-preview"
    assert generate_audio is False
    assert calls == [project]


async def test_reserve_or_cancel_cancels_enqueued_task_when_reservation_fails(monkeypatch):
    cancel_calls: list[dict] = []

    class Queue:
        async def cancel_task(self, task_id: str, *, user_id: str | None = None):
            cancel_calls.append({"task_id": task_id, "user_id": user_id})

    async def fail_reserve(*_args, **_kwargs):
        raise HTTPException(status_code=402, detail="积分余额不足")

    monkeypatch.setattr(billing, "reserve_platform_credits_for_task", fail_reserve)

    with pytest.raises(HTTPException) as exc:
        await billing.reserve_platform_credits_for_task_or_cancel(
            {"billing_mode": "platform_credits"},
            "user-a",
            task_id="task-1",
            required_credits=67,
            task_type="video",
            project_name="demo",
            queue=Queue(),
        )

    assert exc.value.status_code == 402
    assert cancel_calls == [{"task_id": "task-1", "user_id": "user-a"}]


async def test_reserve_or_cancel_does_not_mask_original_reservation_error(monkeypatch):
    class Queue:
        async def cancel_task(self, task_id: str, *, user_id: str | None = None):
            raise RuntimeError("queue unavailable")

    async def fail_reserve(*_args, **_kwargs):
        raise HTTPException(status_code=402, detail="积分余额不足")

    monkeypatch.setattr(billing, "reserve_platform_credits_for_task", fail_reserve)

    with pytest.raises(HTTPException) as exc:
        await billing.reserve_platform_credits_for_task_or_cancel(
            {"billing_mode": "platform_credits"},
            "user-a",
            task_id="task-1",
            required_credits=67,
            task_type="video",
            project_name="demo",
            queue=Queue(),
        )

    assert exc.value.status_code == 402
