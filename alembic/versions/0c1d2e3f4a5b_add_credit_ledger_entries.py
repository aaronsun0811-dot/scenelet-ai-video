"""add credit ledger entries

Revision ID: 0c1d2e3f4a5b
Revises: f3c2b1a0d9e8
Create Date: 2026-05-01 00:10:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0c1d2e3f4a5b"
down_revision: str | Sequence[str] | None = "f3c2b1a0d9e8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _ensure_platform_user() -> None:
    conn = op.get_bind()
    exists = conn.execute(sa.text("SELECT 1 FROM users WHERE id = :id"), {"id": "platform"}).first()
    if exists:
        return

    users = sa.table(
        "users",
        sa.column("id", sa.String),
        sa.column("username", sa.String),
        sa.column("role", sa.String),
        sa.column("is_active", sa.Boolean),
        sa.column("created_at", sa.DateTime),
        sa.column("updated_at", sa.DateTime),
    )
    conn.execute(
        users.insert().values(
            id="platform",
            username="platform",
            role="service",
            is_active=True,
            created_at=sa.func.now(),
            updated_at=sa.func.now(),
        )
    )


def upgrade() -> None:
    """Upgrade schema."""
    _ensure_platform_user()

    op.create_table(
        "credit_ledger_entries",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="posted", nullable=False),
        sa.Column("reference_type", sa.String(length=64), nullable=True),
        sa.Column("reference_id", sa.String(length=128), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.Text(), nullable=True),
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.String(), server_default="default", nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_credit_ledger_user_idempotency_key"),
    )
    with op.batch_alter_table("credit_ledger_entries", schema=None) as batch_op:
        batch_op.create_index("ix_credit_ledger_entries_user_id", ["user_id"], unique=False)
        batch_op.create_index("ix_credit_ledger_user_created", ["user_id", "created_at"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("credit_ledger_entries", schema=None) as batch_op:
        batch_op.drop_index("ix_credit_ledger_user_created")
        batch_op.drop_index("ix_credit_ledger_entries_user_id")
    op.drop_table("credit_ledger_entries")
