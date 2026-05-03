"""add credit reconciliation audits

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-05-02 08:15:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6a7"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "credit_reconciliation_audits",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="completed", nullable=False),
        sa.Column("actor_user_id", sa.String(), nullable=True),
        sa.Column("fixed_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skipped_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("snapshot_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.String(), server_default="default", nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("credit_reconciliation_audits", schema=None) as batch_op:
        batch_op.create_index(
            "ix_credit_reconciliation_audit_user_created",
            ["user_id", "created_at"],
            unique=False,
        )
        batch_op.create_index(batch_op.f("ix_credit_reconciliation_audits_user_id"), ["user_id"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("credit_reconciliation_audits", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_credit_reconciliation_audits_user_id"))
        batch_op.drop_index("ix_credit_reconciliation_audit_user_created")
    op.drop_table("credit_reconciliation_audits")
