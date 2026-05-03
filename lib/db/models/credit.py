"""User credit ledger models."""

from __future__ import annotations

from sqlalchemy import Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from lib.db.base import Base, TimestampMixin, UserOwnedMixin


class CreditLedgerEntry(TimestampMixin, UserOwnedMixin, Base):
    """Append-only signed credit ledger entry.

    Positive amounts add credits, negative amounts spend credits.
    """

    __tablename__ = "credit_ledger_entries"
    __table_args__ = (
        Index("ix_credit_ledger_user_created", "user_id", "created_at"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_credit_ledger_user_idempotency_key"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="posted", server_default="posted")
    reference_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reference_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True)


class CreditReconciliationAudit(TimestampMixin, UserOwnedMixin, Base):
    """Audit trail for credit reconciliation actions and manual notes."""

    __tablename__ = "credit_reconciliation_audits"
    __table_args__ = (
        Index("ix_credit_reconciliation_audit_user_created", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="completed", server_default="completed")
    actor_user_id: Mapped[str | None] = mapped_column(String, nullable=True)
    fixed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    snapshot_json: Mapped[str | None] = mapped_column(Text, nullable=True)
