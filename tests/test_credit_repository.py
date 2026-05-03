"""CreditRepository tests."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from lib.credit_utils import cost_to_credits
from lib.db.base import Base
from lib.db.repositories.credit_repository import CreditRepository, InsufficientCreditsError


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


async def test_credit_balance_starts_at_zero(session: AsyncSession):
    repo = CreditRepository(session, user_id="user-a")
    assert await repo.get_balance() == 0


async def test_credit_and_debit_update_balance(session: AsyncSession):
    repo = CreditRepository(session, user_id="user-a")

    await repo.add_entry(amount=1000, kind="grant", description="welcome")
    await repo.add_entry(amount=-250, kind="usage", reference_type="task", reference_id="task-1")
    await session.flush()

    assert await repo.get_balance() == 750
    entries = await repo.list_entries()
    assert {entry["amount"] for entry in entries} == {1000, -250}


async def test_debit_cannot_make_balance_negative(session: AsyncSession):
    repo = CreditRepository(session, user_id="user-a")

    with pytest.raises(InsufficientCreditsError):
        await repo.add_entry(amount=-1, kind="usage")


async def test_idempotency_key_prevents_double_credit(session: AsyncSession):
    repo = CreditRepository(session, user_id="user-a")

    first = await repo.add_entry(amount=100, kind="purchase", idempotency_key="order-1")
    second = await repo.add_entry(amount=100, kind="purchase", idempotency_key="order-1")

    assert first["id"] == second["id"]
    assert await repo.get_balance() == 100


async def test_pending_credit_order_does_not_change_balance_until_posted(session: AsyncSession):
    repo = CreditRepository(session, user_id="user-a")

    pending = await repo.add_entry(
        amount=1000,
        kind="purchase",
        status="pending",
        reference_type="credit_order",
        reference_id="co_demo",
    )
    assert pending["status"] == "pending"
    assert await repo.get_balance() == 0
    assert await repo.get_pending_purchase_credits() == 1000

    posted = await repo.update_status_by_reference(
        reference_type="credit_order",
        reference_id="co_demo",
        status="posted",
        metadata={"payment_reference": "pay_demo"},
    )
    assert posted is not None
    assert posted["status"] == "posted"
    assert posted["metadata"]["payment_reference"] == "pay_demo"
    assert await repo.get_balance() == 1000
    assert await repo.get_pending_purchase_credits() == 0


async def test_balance_is_scoped_by_user(session: AsyncSession):
    repo_a = CreditRepository(session, user_id="user-a")
    repo_b = CreditRepository(session, user_id="user-b")

    await repo_a.add_entry(amount=500, kind="grant")
    await repo_b.add_entry(amount=200, kind="grant")

    assert await repo_a.get_balance() == 500
    assert await repo_b.get_balance() == 200


async def test_generation_usage_can_overdraw_after_provider_call(session: AsyncSession):
    repo = CreditRepository(session, user_id="user-a")

    await repo.add_entry(
        amount=-67,
        kind="generation_usage",
        allow_negative_balance=True,
    )

    assert await repo.get_balance() == -67


async def test_generation_reservation_reduces_available_balance_until_released(session: AsyncSession):
    repo = CreditRepository(session, user_id="user-a")

    await repo.add_entry(amount=100, kind="grant")
    reservation = await repo.reserve_generation_credits(task_id="task-1", amount=67)

    assert reservation["status"] == "pending"
    assert reservation["amount"] == -67
    assert await repo.get_balance() == 100
    assert await repo.get_reserved_generation_credits() == 67
    assert await repo.get_available_balance() == 33

    released = await repo.release_generation_reservation("task-1")

    assert released is not None
    assert released["status"] == "released"
    assert await repo.get_reserved_generation_credits() == 0
    assert await repo.get_available_balance() == 100


def test_cost_to_credits_uses_currency_rates():
    assert cost_to_credits(0.067, "USD") == 67
    assert cost_to_credits(3.9494, "CNY") == 553
    assert cost_to_credits(0, "USD") == 0
