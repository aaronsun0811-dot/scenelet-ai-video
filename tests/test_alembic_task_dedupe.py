"""Alembic task queue dedupe index migration tests."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config

from alembic import command

PROJECT_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def alembic_cfg(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")

    import logging.config

    real_file_config = logging.config.fileConfig
    monkeypatch.setattr(
        logging.config,
        "fileConfig",
        lambda *args, **kwargs: real_file_config(*args, **{**kwargs, "disable_existing_loggers": False}),
    )

    cfg = Config(str(PROJECT_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(PROJECT_ROOT / "alembic"))
    return cfg, db_path


def test_head_creates_user_scoped_active_task_dedupe_index(alembic_cfg):
    cfg, db_path = alembic_cfg

    command.upgrade(cfg, "head")

    engine = sa.create_engine(f"sqlite:///{db_path}")
    with engine.connect() as conn:
        rows = conn.execute(sa.text("PRAGMA index_xinfo('idx_tasks_dedupe_active')")).mappings().all()
        index_sql = conn.execute(
            sa.text("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_tasks_dedupe_active'")
        ).scalar_one()

    key_columns = [row["name"] for row in rows if row["key"] and row["cid"] >= 0]
    expression_columns = [row for row in rows if row["key"] and row["cid"] == -2]

    assert key_columns[:4] == ["user_id", "project_name", "task_type", "resource_id"]
    assert expression_columns
    assert "COALESCE(script_file, '')" in index_sql
    assert "WHERE status IN ('queued', 'running')" in index_sql
