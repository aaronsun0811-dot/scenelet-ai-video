"""Tests for lib.db.engine configuration."""

import os
from unittest.mock import patch

from lib.db.engine import _default_sqlite_db_path, get_database_url, is_sqlite_backend


class TestGetDatabaseUrl:
    def test_default_returns_sqlite(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            url = get_database_url()
            assert url.startswith("sqlite+aiosqlite:///")
            assert ".scenelet.db" in url or ".arcreel.db" in url

    def test_env_override(self):
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql+asyncpg://localhost/test"}):
            url = get_database_url()
            assert url == "postgresql+asyncpg://localhost/test"

    def test_new_install_uses_scenelet_sqlite_name(self, tmp_path):
        assert _default_sqlite_db_path(tmp_path).name == ".scenelet.db"

    def test_existing_arcreel_sqlite_name_is_preserved(self, tmp_path):
        projects = tmp_path / "projects"
        projects.mkdir()
        (projects / ".arcreel.db").touch()

        assert _default_sqlite_db_path(tmp_path).name == ".arcreel.db"

    def test_scenelet_sqlite_name_wins_after_explicit_migration(self, tmp_path):
        projects = tmp_path / "projects"
        projects.mkdir()
        (projects / ".arcreel.db").touch()
        (projects / ".scenelet.db").touch()

        assert _default_sqlite_db_path(tmp_path).name == ".scenelet.db"


class TestIsSqliteBackend:
    def test_sqlite(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            assert is_sqlite_backend() is True

    def test_postgresql(self):
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql+asyncpg://localhost/test"}):
            assert is_sqlite_backend() is False
