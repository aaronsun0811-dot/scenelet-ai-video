"""Credit ledger repository."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import func, select

from lib.db.base import DEFAULT_USER_ID, dt_to_iso
from lib.db.models.credit import CreditLedgerEntry
from lib.db.repositories.base import BaseRepository


class InsufficientCreditsError(ValueError):
    """Raised when a debit would make the user's credit balance negative."""


def _ledger_to_dict(row: CreditLedgerEntry) -> dict[str, Any]:
    return {
        "id": row.id,
        "amount": row.amount,
        "kind": row.kind,
        "status": row.status,
        "reference_type": row.reference_type,
        "reference_id": row.reference_id,
        "description": row.description,
        "metadata": json.loads(row.metadata_json) if row.metadata_json else None,
        "idempotency_key": row.idempotency_key,
        "created_at": dt_to_iso(row.created_at),
    }


class CreditRepository(BaseRepository):
    def __init__(self, session, user_id: str = DEFAULT_USER_ID):
        super().__init__(session)
        self.user_id = user_id

    async def get_balance(self) -> int:
        stmt = select(func.coalesce(func.sum(CreditLedgerEntry.amount), 0)).where(
            CreditLedgerEntry.user_id == self.user_id,
            CreditLedgerEntry.status == "posted",
        )
        return int((await self.session.execute(stmt)).scalar_one())

    async def get_reserved_generation_credits(self) -> int:
        stmt = select(func.coalesce(func.sum(-CreditLedgerEntry.amount), 0)).where(
            CreditLedgerEntry.user_id == self.user_id,
            CreditLedgerEntry.status == "pending",
            CreditLedgerEntry.kind == "generation_reservation",
            CreditLedgerEntry.amount < 0,
        )
        return int((await self.session.execute(stmt)).scalar_one())

    async def get_available_balance(self) -> int:
        return await self.get_balance() - await self.get_reserved_generation_credits()

    async def get_pending_purchase_credits(self) -> int:
        stmt = select(func.coalesce(func.sum(CreditLedgerEntry.amount), 0)).where(
            CreditLedgerEntry.user_id == self.user_id,
            CreditLedgerEntry.status == "pending",
            CreditLedgerEntry.kind == "purchase",
            CreditLedgerEntry.amount > 0,
        )
        return int((await self.session.execute(stmt)).scalar_one())

    async def list_entries(self, *, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        stmt = (
            select(CreditLedgerEntry)
            .where(CreditLedgerEntry.user_id == self.user_id)
            .order_by(CreditLedgerEntry.created_at.desc(), CreditLedgerEntry.id.desc())
            .limit(max(1, min(limit, 200)))
            .offset(max(0, offset))
        )
        result = await self.session.execute(stmt)
        return [_ledger_to_dict(row) for row in result.scalars()]

    async def add_entry(
        self,
        *,
        amount: int,
        kind: str,
        status: str = "posted",
        reference_type: str | None = None,
        reference_id: str | None = None,
        description: str | None = None,
        metadata: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        allow_negative_balance: bool = False,
    ) -> dict[str, Any]:
        if amount == 0:
            raise ValueError("credit amount must not be zero")

        if idempotency_key:
            existing = await self.get_by_idempotency_key(idempotency_key)
            if existing is not None:
                return existing

        if amount < 0 and not allow_negative_balance:
            balance = await self.get_balance()
            if balance + amount < 0:
                raise InsufficientCreditsError("insufficient credits")

        row = CreditLedgerEntry(
            user_id=self.user_id,
            amount=amount,
            kind=kind,
            status=status,
            reference_type=reference_type,
            reference_id=reference_id,
            description=description,
            metadata_json=json.dumps(metadata, ensure_ascii=False) if metadata else None,
            idempotency_key=idempotency_key,
        )
        self.session.add(row)
        await self.session.flush()
        await self.session.refresh(row)
        return _ledger_to_dict(row)

    async def reserve_generation_credits(
        self,
        *,
        task_id: str,
        amount: int,
        description: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if amount <= 0:
            raise ValueError("reservation amount must be positive")

        idempotency_key = f"generation-reservation:{task_id}"
        existing = await self.get_by_idempotency_key(idempotency_key)
        if existing is not None:
            return existing

        if await self.get_available_balance() < amount:
            raise InsufficientCreditsError("insufficient credits")

        return await self.add_entry(
            amount=-amount,
            kind="generation_reservation",
            status="pending",
            reference_type="task",
            reference_id=task_id,
            description=description,
            metadata=metadata,
            idempotency_key=idempotency_key,
            allow_negative_balance=True,
        )

    async def release_generation_reservation(self, task_id: str) -> dict[str, Any] | None:
        return await self.update_status_by_reference(
            reference_type="task",
            reference_id=task_id,
            status="released",
        )

    async def get_by_reference(self, reference_type: str, reference_id: str) -> dict[str, Any] | None:
        stmt = select(CreditLedgerEntry).where(
            CreditLedgerEntry.user_id == self.user_id,
            CreditLedgerEntry.reference_type == reference_type,
            CreditLedgerEntry.reference_id == reference_id,
        )
        result = await self.session.execute(stmt)
        row = result.scalar_one_or_none()
        return _ledger_to_dict(row) if row else None

    async def update_status_by_reference(
        self,
        *,
        reference_type: str,
        reference_id: str,
        status: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        stmt = select(CreditLedgerEntry).where(
            CreditLedgerEntry.user_id == self.user_id,
            CreditLedgerEntry.reference_type == reference_type,
            CreditLedgerEntry.reference_id == reference_id,
        )
        result = await self.session.execute(stmt)
        row = result.scalar_one_or_none()
        if row is None:
            return None

        row.status = status
        if metadata:
            existing = json.loads(row.metadata_json) if row.metadata_json else {}
            existing.update(metadata)
            row.metadata_json = json.dumps(existing, ensure_ascii=False)
        await self.session.flush()
        await self.session.refresh(row)
        return _ledger_to_dict(row)

    async def get_by_idempotency_key(self, idempotency_key: str) -> dict[str, Any] | None:
        stmt = select(CreditLedgerEntry).where(
            CreditLedgerEntry.user_id == self.user_id,
            CreditLedgerEntry.idempotency_key == idempotency_key,
        )
        result = await self.session.execute(stmt)
        row = result.scalar_one_or_none()
        return _ledger_to_dict(row) if row else None
