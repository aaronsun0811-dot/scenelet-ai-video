"""scope provider credentials and custom providers by user

Revision ID: f3c2b1a0d9e8
Revises: a205678752dc
Create Date: 2026-05-01 00:00:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f3c2b1a0d9e8"
down_revision: str | Sequence[str] | None = "a205678752dc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("provider_credential", schema=None) as batch_op:
        batch_op.drop_index("uq_provider_credential_one_active")
        batch_op.add_column(sa.Column("user_id", sa.String(), server_default="default", nullable=False))
        batch_op.create_foreign_key(
            "fk_provider_credential_user_id",
            "users",
            ["user_id"],
            ["id"],
            ondelete="CASCADE",
        )
        batch_op.create_index(batch_op.f("ix_provider_credential_user_id"), ["user_id"], unique=False)
        batch_op.create_index(
            "uq_provider_credential_one_active",
            ["user_id", "provider"],
            unique=True,
            sqlite_where=sa.text("is_active = 1"),
            postgresql_where=sa.text("is_active"),
        )

    with op.batch_alter_table("custom_provider", schema=None) as batch_op:
        batch_op.add_column(sa.Column("user_id", sa.String(), server_default="default", nullable=False))
        batch_op.create_foreign_key(
            "fk_custom_provider_user_id",
            "users",
            ["user_id"],
            ["id"],
            ondelete="CASCADE",
        )
        batch_op.create_index(batch_op.f("ix_custom_provider_user_id"), ["user_id"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    # Collapse duplicate active credentials before restoring the old global unique index.
    op.execute(
        sa.text(
            """
            UPDATE provider_credential
            SET is_active = 0
            WHERE is_active = 1
              AND id NOT IN (
                SELECT MIN(id)
                FROM provider_credential
                WHERE is_active = 1
                GROUP BY provider
              )
            """
        )
    )

    with op.batch_alter_table("custom_provider", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_custom_provider_user_id"))
        batch_op.drop_constraint("fk_custom_provider_user_id", type_="foreignkey")
        batch_op.drop_column("user_id")

    with op.batch_alter_table("provider_credential", schema=None) as batch_op:
        batch_op.drop_index("uq_provider_credential_one_active")
        batch_op.drop_index(batch_op.f("ix_provider_credential_user_id"))
        batch_op.drop_constraint("fk_provider_credential_user_id", type_="foreignkey")
        batch_op.drop_column("user_id")
        batch_op.create_index(
            "uq_provider_credential_one_active",
            ["provider"],
            unique=True,
            sqlite_where=sa.text("is_active = 1"),
            postgresql_where=sa.text("is_active"),
        )
