"""scope active task dedupe by user

Revision ID: a1b2c3d4e5f6
Revises: 9d8c7b6a5e4f
Create Date: 2026-05-01 11:20:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "9d8c7b6a5e4f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # SQLite batch table rebuilds cannot reflect expression indexes reliably,
    # so older upgrade paths may already have lost this index.
    op.execute(sa.text("DROP INDEX IF EXISTS idx_tasks_dedupe_active"))
    op.create_index(
        "idx_tasks_dedupe_active",
        "tasks",
        ["user_id", "project_name", "task_type", "resource_id", sa.text("COALESCE(script_file, '')")],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
        sqlite_where=sa.text("status IN ('queued', 'running')"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(sa.text("DROP INDEX IF EXISTS idx_tasks_dedupe_active"))
    op.create_index(
        "idx_tasks_dedupe_active",
        "tasks",
        ["project_name", "task_type", "resource_id", sa.text("COALESCE(script_file, '')")],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
        sqlite_where=sa.text("status IN ('queued', 'running')"),
    )
