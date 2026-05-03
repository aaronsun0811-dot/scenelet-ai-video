"""Tests for TaskRepository."""

import asyncio

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from lib.db.base import Base
from lib.db.repositories.credit_repository import CreditRepository
from lib.db.repositories.task_repo import TaskRepository


@pytest.fixture
async def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest.fixture
async def db_session(engine):
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session


class TestTaskRepository:
    async def test_enqueue_dedupe_claim_succeed(self, db_session):
        repo = TaskRepository(db_session)

        first = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={"prompt": "test"},
            script_file="ep1.json",
        )
        assert not first["deduped"]

        deduped = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={"prompt": "test2"},
            script_file="ep1.json",
        )
        assert deduped["deduped"]
        assert deduped["task_id"] == first["task_id"]

        running = await repo.claim_next("image")
        assert running is not None
        assert running["status"] == "running"

        done = await repo.mark_succeeded(first["task_id"], {"file": "test.png"})
        assert done["status"] == "succeeded"

    async def test_enqueue_dedupe_is_scoped_by_user(self, db_session):
        repo = TaskRepository(db_session)

        user_a_task = await repo.enqueue(
            project_name="same-name",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={"prompt": "user a"},
            script_file="ep1.json",
            user_id="user-a",
        )
        user_b_task = await repo.enqueue(
            project_name="same-name",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={"prompt": "user b"},
            script_file="ep1.json",
            user_id="user-b",
        )
        user_a_deduped = await repo.enqueue(
            project_name="same-name",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={"prompt": "user a retry"},
            script_file="ep1.json",
            user_id="user-a",
        )

        assert not user_a_task["deduped"]
        assert not user_b_task["deduped"]
        assert user_b_task["task_id"] != user_a_task["task_id"]
        assert user_a_deduped["deduped"]
        assert user_a_deduped["task_id"] == user_a_task["task_id"]

    async def test_terminal_status_releases_credit_reservation(self, db_session):
        task_repo = TaskRepository(db_session)
        credit_repo = CreditRepository(db_session, user_id="user-a")

        task = await task_repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={"prompt": "test"},
            user_id="user-a",
        )
        await credit_repo.add_entry(amount=100, kind="grant")
        await credit_repo.reserve_generation_credits(task_id=task["task_id"], amount=67)
        assert await credit_repo.get_available_balance() == 33

        await task_repo.mark_failed(task["task_id"], "boom")

        assert await credit_repo.get_reserved_generation_credits() == 0
        assert await credit_repo.get_available_balance() == 100

    async def test_event_sequence(self, db_session):
        repo = TaskRepository(db_session)

        task = await repo.enqueue(
            project_name="demo",
            task_type="video",
            media_type="video",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        await repo.claim_next("video")
        await repo.mark_failed(task["task_id"], "mock error")

        events = await repo.get_events_since(last_event_id=0)
        assert len(events) >= 3
        types = [e["event_type"] for e in events]
        assert types == ["queued", "running", "failed"]

    async def test_retry_failed_task_clones_task_into_queue(self, db_session):
        repo = TaskRepository(db_session)

        task = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={"prompt": "retry me"},
            script_file="ep1.json",
            source="webui",
            user_id="user-a",
        )
        await repo.claim_next("image")
        await repo.mark_failed(task["task_id"], "boom")

        retried = await repo.retry_failed_task(task["task_id"], user_id="user-a")

        assert retried["status"] == "queued"
        assert retried["task_id"] != task["task_id"]
        cloned = await repo.get(retried["task_id"], user_id="user-a")
        assert cloned["task_type"] == "storyboard"
        assert cloned["resource_id"] == "E1S01"
        assert cloned["payload"] == {"prompt": "retry me"}
        assert cloned["script_file"] == "ep1.json"

        original = await repo.get(task["task_id"], user_id="user-a")
        assert original["status"] == "failed"

    async def test_retry_failed_task_can_refresh_payload_before_clone(self, db_session):
        repo = TaskRepository(db_session)

        task = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={
                "prompt": "retry me",
                "model_rule_summary": {"mode": "default", "rule_target": "__media__/image"},
            },
            script_file="ep1.json",
            user_id="user-a",
        )
        await repo.claim_next("image")
        await repo.mark_failed(task["task_id"], "boom")

        async def _refresh(payload, task_context):
            assert task_context["task_type"] == "storyboard"
            assert task_context["media_type"] == "image"
            return {
                **payload,
                "model_rule_summary": {
                    "mode": "prompt",
                    "rule_target": "__media__/image",
                    "task_type": task_context["task_type"],
                },
            }

        retried = await repo.retry_failed_task(
            task["task_id"],
            user_id="user-a",
            payload_refresh=_refresh,
        )

        cloned = await repo.get(retried["task_id"], user_id="user-a")
        assert cloned["payload"]["prompt"] == "retry me"
        assert cloned["payload"]["model_rule_summary"]["mode"] == "prompt"
        assert retried["retried_tasks"][0]["payload"]["model_rule_summary"]["mode"] == "prompt"

    async def test_retry_failed_task_retries_failed_dependency_chain(self, db_session):
        repo = TaskRepository(db_session)

        first = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={"prompt": "first"},
            script_file="ep1.json",
            dependency_group="ep1:group:1",
            dependency_index=0,
        )
        second = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S02",
            payload={"prompt": "second"},
            script_file="ep1.json",
            dependency_task_id=first["task_id"],
            dependency_group="ep1:group:1",
            dependency_index=1,
        )

        await repo.claim_next("image")
        await repo.mark_failed(first["task_id"], "boom")

        retried_second = await repo.retry_failed_task(second["task_id"])
        cloned_second = await repo.get(retried_second["task_id"])
        cloned_first = await repo.get(cloned_second["dependency_task_id"])

        assert cloned_first["task_id"] != first["task_id"]
        assert cloned_first["status"] == "queued"
        assert cloned_first["resource_id"] == "E1S01"
        assert cloned_first["dependency_task_id"] is None
        assert cloned_second["task_id"] != second["task_id"]
        assert cloned_second["status"] == "queued"
        assert cloned_second["resource_id"] == "E1S02"
        assert cloned_second["dependency_task_id"] == cloned_first["task_id"]
        assert cloned_second["dependency_group"] == "ep1:group:1"
        assert cloned_second["dependency_index"] == 1
        assert [item["task_id"] for item in retried_second["retried_tasks"]] == [
            cloned_first["task_id"],
            cloned_second["task_id"],
        ]

    async def test_retry_failed_task_preserves_succeeded_dependency(self, db_session):
        repo = TaskRepository(db_session)

        first = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        second = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S02",
            payload={},
            script_file="ep1.json",
            dependency_task_id=first["task_id"],
            dependency_group="ep1:group:1",
            dependency_index=1,
        )

        await repo.claim_next("image")
        await repo.mark_succeeded(first["task_id"], {"file": "scene_E1S01.png"})
        await repo.claim_next("image")
        await repo.mark_failed(second["task_id"], "second failed")

        retried = await repo.retry_failed_task(second["task_id"])
        cloned = await repo.get(retried["task_id"])

        assert cloned["dependency_task_id"] == first["task_id"]
        assert cloned["dependency_group"] == "ep1:group:1"
        assert cloned["dependency_index"] == 1

    async def test_retry_failed_task_requires_owner_and_failed_status(self, db_session):
        repo = TaskRepository(db_session)

        task = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
            user_id="user-a",
        )

        with pytest.raises(ValueError, match="不存在"):
            await repo.retry_failed_task(task["task_id"], user_id="user-b")

        with pytest.raises(ValueError, match="失败"):
            await repo.retry_failed_task(task["task_id"], user_id="user-a")

    async def test_dependency_cascade_failure(self, db_session):
        repo = TaskRepository(db_session)

        first = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        second = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S02",
            payload={},
            script_file="ep1.json",
            dependency_task_id=first["task_id"],
        )

        await repo.claim_next("image")
        await repo.mark_failed(first["task_id"], "boom")

        dep_task = await repo.get(second["task_id"])
        assert dep_task["status"] == "failed"
        assert "blocked by failed dependency" in dep_task["error_message"]

    async def test_requeue_running_tasks(self, db_session):
        repo = TaskRepository(db_session)

        task = await repo.enqueue(
            project_name="demo",
            task_type="video",
            media_type="video",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        await repo.claim_next("video")
        count = await repo.requeue_running()
        assert count == 1

        queued = await repo.get(task["task_id"])
        assert queued["status"] == "queued"

    async def test_worker_lease(self, db_session):
        repo = TaskRepository(db_session)

        assert await repo.acquire_or_renew_lease(name="default", owner_id="a", ttl=2)
        assert not await repo.acquire_or_renew_lease(name="default", owner_id="b", ttl=2)
        assert await repo.is_worker_online(name="default")

        await repo.release_lease(name="default", owner_id="a")
        assert not await repo.is_worker_online(name="default")

    async def test_worker_lease_concurrent_first_acquire(self, tmp_path):
        db_path = tmp_path / "lease-race.db"
        engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        factory = async_sessionmaker(engine, expire_on_commit=False)
        start = asyncio.Event()

        async def _attempt(owner_id: str) -> bool:
            await start.wait()
            async with factory() as session:
                repo = TaskRepository(session)
                return await repo.acquire_or_renew_lease(
                    name="default",
                    owner_id=owner_id,
                    ttl=2,
                )

        first = asyncio.create_task(_attempt("worker-a"))
        second = asyncio.create_task(_attempt("worker-b"))
        start.set()

        a_ok, b_ok = await asyncio.gather(first, second)
        assert sorted([a_ok, b_ok]) == [False, True]

        async with factory() as session:
            repo = TaskRepository(session)
            lease = await repo.get_worker_lease(name="default")
            assert lease is not None
            assert lease["owner_id"] in {"worker-a", "worker-b"}

        await engine.dispose()

    async def test_list_tasks_with_filters(self, db_session):
        repo = TaskRepository(db_session)

        await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        await repo.enqueue(
            project_name="other",
            task_type="video",
            media_type="video",
            resource_id="E1S02",
            payload={},
            script_file="ep2.json",
        )

        result = await repo.list_tasks(project_name="demo")
        assert result["total"] == 1

        result = await repo.list_tasks()
        assert result["total"] == 2

    async def test_read_queries_can_be_scoped_by_user(self, db_session):
        repo = TaskRepository(db_session)

        task_a = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
            user_id="user-a",
        )
        task_b = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S02",
            payload={},
            script_file="ep1.json",
            user_id="user-b",
        )

        visible_to_a = await repo.list_tasks(user_id="user-a")
        assert visible_to_a["total"] == 1
        assert visible_to_a["items"][0]["task_id"] == task_a["task_id"]

        assert await repo.get(task_b["task_id"], user_id="user-a") is None

        stats_b = await repo.get_stats(project_name="demo", user_id="user-b")
        assert stats_b["queued"] == 1
        assert stats_b["total"] == 1

        events_a = await repo.get_events_since(last_event_id=0, project_name="demo", user_id="user-a")
        assert [event["data"]["task_id"] for event in events_a] == [task_a["task_id"]]

    async def test_task_has_cancelled_by_field(self, db_session):
        repo = TaskRepository(db_session)
        task = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        fetched = await repo.get(task["task_id"])
        assert fetched["cancelled_by"] is None

    async def test_cancel_single_queued_task(self, db_session):
        repo = TaskRepository(db_session)

        task = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )

        result = await repo.cancel_task(task["task_id"])
        assert len(result["cancelled"]) == 1
        assert result["cancelled"][0]["task_id"] == task["task_id"]
        assert result["cancelled"][0]["cancelled_by"] == "user"
        assert result["skipped_running"] == []

        cancelled = await repo.get(task["task_id"])
        assert cancelled["status"] == "cancelled"
        assert cancelled["cancelled_by"] == "user"

    async def test_get_stats(self, db_session):
        repo = TaskRepository(db_session)

        await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        stats = await repo.get_stats()
        assert stats["queued"] == 1
        assert stats["total"] == 1

    async def test_cancel_task_cascades_to_dependents(self, db_session):
        repo = TaskRepository(db_session)

        first = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        second = await repo.enqueue(
            project_name="demo",
            task_type="video",
            media_type="video",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
            dependency_task_id=first["task_id"],
        )

        result = await repo.cancel_task(first["task_id"])
        assert len(result["cancelled"]) == 2
        assert result["cancelled"][0]["task_id"] == first["task_id"]
        assert result["cancelled"][0]["cancelled_by"] == "user"
        assert result["cancelled"][1]["task_id"] == second["task_id"]
        assert result["cancelled"][1]["cancelled_by"] == "cascade"

        dep_task = await repo.get(second["task_id"])
        assert dep_task["status"] == "cancelled"
        assert dep_task["cancelled_by"] == "cascade"

    async def test_cancel_running_task_rejected(self, db_session):
        repo = TaskRepository(db_session)

        task = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        await repo.claim_next("image")

        with pytest.raises(ValueError, match="只有排队中的任务可以取消"):
            await repo.cancel_task(task["task_id"])

    async def test_cancel_preview(self, db_session):
        repo = TaskRepository(db_session)

        first = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        second = await repo.enqueue(
            project_name="demo",
            task_type="video",
            media_type="video",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
            dependency_task_id=first["task_id"],
        )

        preview = await repo.get_cancel_preview(first["task_id"])
        assert preview["task"]["task_id"] == first["task_id"]
        assert len(preview["cascaded"]) == 1
        assert preview["cascaded"][0]["task_id"] == second["task_id"]

    async def test_cancel_all_queued(self, db_session):
        repo = TaskRepository(db_session)

        await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        t2 = await repo.enqueue(
            project_name="demo",
            task_type="video",
            media_type="video",
            resource_id="E1S02",
            payload={},
            script_file="ep1.json",
        )
        # Claim one task so it becomes running
        await repo.claim_next("image")

        result = await repo.cancel_all_queued("demo")
        assert result["cancelled_count"] == 1  # only the queued video task
        assert result["skipped_running_count"] == 0  # running 任务在查询 queued 前已被 claim，不算 skipped

        task = await repo.get(t2["task_id"])
        assert task["status"] == "cancelled"

    async def test_cancel_all_queued_releases_credit_reservations(self, db_session):
        repo = TaskRepository(db_session)
        credit_repo = CreditRepository(db_session, user_id="user-a")
        await credit_repo.add_entry(amount=1000, kind="grant")

        task = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
            user_id="user-a",
        )
        await credit_repo.reserve_generation_credits(task_id=task["task_id"], amount=67)

        assert await credit_repo.get_reserved_generation_credits() == 67
        result = await repo.cancel_all_queued("demo", user_id="user-a")

        assert result["cancelled_count"] == 1
        assert await credit_repo.get_reserved_generation_credits() == 0
        entries = await credit_repo.list_entries()
        reservation = next(entry for entry in entries if entry["kind"] == "generation_reservation")
        assert reservation["status"] == "released"

    async def test_get_stats_includes_cancelled(self, db_session):
        repo = TaskRepository(db_session)

        task = await repo.enqueue(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={},
            script_file="ep1.json",
        )
        await repo.cancel_task(task["task_id"])

        stats = await repo.get_stats()
        assert stats["cancelled"] == 1
        assert stats["queued"] == 0
