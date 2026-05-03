"""Shared pytest fixtures for the ArcReel test suite."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable

from fastapi.testclient import TestClient


_ORIGINAL_TEST_CLIENT_EXIT = TestClient.__exit__


def _closing_test_client_exit(self: TestClient, *args: object) -> None:
    """Close TestClient's httpx transport after Starlette lifespan cleanup.

    Starlette's TestClient context manager closes the lifespan portal, but the
    inherited httpx transport is closed by ``close()``.  In wide pytest runs the
    leftover transport can keep socket pairs and an event loop alive until GC,
    which shows up as ResourceWarning noise in unrelated later tests.
    """

    try:
        _ORIGINAL_TEST_CLIENT_EXIT(self, *args)
    finally:
        self.close()


if getattr(TestClient.__exit__, "_arcreel_closes_transport", False) is not True:
    _closing_test_client_exit._arcreel_closes_transport = True  # type: ignore[attr-defined]
    TestClient.__exit__ = _closing_test_client_exit  # type: ignore[method-assign]


def make_translator(locale: str = "zh") -> Callable[..., str]:
    """Create a translator function bound to a fixed locale for testing."""
    from lib.i18n import _ as i18n_translate

    def translate(key: str, **kwargs) -> str:
        return i18n_translate(key, locale=locale, **kwargs)

    return translate


import os
import subprocess
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import lib.generation_queue as generation_queue_module
from lib.db.base import Base
from server.agent_runtime.session_manager import SessionManager
from server.agent_runtime.session_store import SessionMetaStore


@pytest.fixture(autouse=True)
def _close_leaked_default_event_loop():
    """Close a non-running default loop left on the event-loop policy.

    Some sync test helpers (notably TestClient/anyio combinations) can leave a
    selector loop attached to the main-thread policy after their own cleanup.
    Pytest may then collect it during an unrelated later async test and emit an
    "unclosed event loop" ResourceWarning.  Inspecting the policy slot avoids
    calling get_event_loop(), which would create a new loop just to clean up.
    """

    yield

    policy = asyncio.get_event_loop_policy()
    local = getattr(policy, "_local", None)
    loop = getattr(local, "_loop", None)
    if loop is None or loop.is_closed() or loop.is_running():
        return
    loop.close()
    with contextlib.suppress(Exception):
        policy.set_event_loop(None)

# ---------------------------------------------------------------------------
# General utilities
# ---------------------------------------------------------------------------


def make_test_video(path: Path, *, duration_sec: float = 1.0, fps: int = 30) -> None:
    """使用 ffmpeg 生成极短测试视频（64x64 像素）"""
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=black:size=64x64:duration={duration_sec}:rate={fps}",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        capture_output=True,
        check=True,
    )


@pytest.fixture()
def fd_count():
    """Return a callable that reports the current process file-descriptor count.

    Returns -1 on platforms where /dev/fd and /proc/self/fd are unavailable.
    """

    def _count() -> int:
        for fd_dir in ("/dev/fd", "/proc/self/fd"):
            try:
                return len(os.listdir(fd_dir))
            except OSError:
                continue
        return -1

    return _count


# ---------------------------------------------------------------------------
# SessionManager family (used by 3+ test files)
# ---------------------------------------------------------------------------


@pytest.fixture()
async def meta_store():
    """Create an async SessionMetaStore backed by in-memory SQLite."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    store = SessionMetaStore(session_factory=factory)
    yield store
    await engine.dispose()


@pytest.fixture()
async def session_manager(tmp_path: Path, meta_store: SessionMetaStore) -> SessionManager:
    """Create a SessionManager wired to *tmp_path* and *meta_store*."""
    manager = SessionManager(
        project_root=tmp_path,
        data_dir=tmp_path,
        meta_store=meta_store,
    )
    yield manager
    await manager.shutdown_gracefully(timeout=1.0)


# ---------------------------------------------------------------------------
# GenerationQueue family (used by 2+ test files)
# ---------------------------------------------------------------------------


@pytest.fixture()
async def generation_queue():
    """Create an async GenerationQueue backed by in-memory SQLite.

    Automatically resets the module singleton on teardown.
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    queue = generation_queue_module.GenerationQueue(session_factory=factory)
    generation_queue_module._QUEUE_INSTANCE = queue
    yield queue
    generation_queue_module._QUEUE_INSTANCE = None
    await engine.dispose()
