"""Billing router tests."""

from __future__ import annotations

import hashlib
import hmac
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from lib.db import get_async_session
from lib.db.base import Base
from lib.db.repositories.credit_repository import CreditRepository
from lib.db.repositories.task_repo import TaskRepository
from lib.db.repositories.user_repository import UserRepository
from server.auth import CurrentUserInfo, get_current_user
from server.routers import billing


def _stripe_signature(payload: bytes, secret: str) -> str:
    timestamp = str(int(time.time()))
    signed_payload = f"{timestamp}.{payload.decode('utf-8')}".encode()
    digest = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


@pytest.fixture()
async def session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield factory
    await engine.dispose()


@pytest.fixture()
def app(session_factory) -> FastAPI:
    test_app = FastAPI()

    async def _override_session():
        async with session_factory() as session:
            yield session

    test_app.dependency_overrides[get_async_session] = _override_session
    test_app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="user-a", sub="user-a", role="admin")
    test_app.include_router(billing.router, prefix="/api/v1")
    return test_app


async def test_get_credits_returns_balance_and_entries(session_factory, app: FastAPI):
    async with session_factory() as session:
        repo = CreditRepository(session, user_id="user-a")
        await repo.add_entry(amount=300, kind="grant", description="welcome")
        await session.commit()

    with TestClient(app) as client:
        resp = client.get("/api/v1/billing/credits")

    assert resp.status_code == 200
    body = resp.json()
    assert body["balance"] == 300
    assert body["available_balance"] == 300
    assert body["reserved_generation_credits"] == 0
    assert body["minimum_generation_balance"] == 1
    assert body["pending_purchase_credits"] == 0
    assert body["entries"][0]["kind"] == "grant"


async def test_get_credits_reports_reserved_and_available(session_factory, app: FastAPI):
    async with session_factory() as session:
        repo = CreditRepository(session, user_id="user-a")
        await repo.add_entry(amount=300, kind="grant")
        await repo.reserve_generation_credits(task_id="task-1", amount=67)
        await session.commit()

    with TestClient(app) as client:
        resp = client.get("/api/v1/billing/credits")

    assert resp.status_code == 200
    body = resp.json()
    assert body["balance"] == 300
    assert body["reserved_generation_credits"] == 67
    assert body["available_balance"] == 233


async def test_credit_reconciliation_flags_stale_generation_reservation(session_factory, app: FastAPI):
    async with session_factory() as session:
        task_repo = TaskRepository(session)
        task = await task_repo.enqueue(
            project_name="demo",
            task_type="video",
            media_type="video",
            resource_id="E1S01",
            user_id="user-a",
        )
        credit_repo = CreditRepository(session, user_id="user-a")
        await credit_repo.add_entry(amount=300, kind="grant")
        await credit_repo.reserve_generation_credits(task_id=task["task_id"], amount=67)
        await task_repo.mark_succeeded(task["task_id"], result={"ok": True})
        await credit_repo.add_entry(
            amount=-33,
            kind="generation_reservation",
            status="pending",
            reference_type="task",
            reference_id=task["task_id"],
            allow_negative_balance=True,
        )
        await credit_repo.reserve_generation_credits(task_id="stale-task", amount=50)
        await session.commit()

    with TestClient(app) as client:
        resp = client.get("/api/v1/billing/credits/reconciliation")

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert any(issue["code"] == "stale_generation_reservation" for issue in body["issues"])
    assert any(issue["code"] == "reservation_task_missing" for issue in body["issues"])


async def test_credit_reconciliation_action_releases_stale_reservations(session_factory, app: FastAPI):
    async with session_factory() as session:
        task_repo = TaskRepository(session)
        stale_task = await task_repo.enqueue(
            project_name="demo",
            task_type="video",
            media_type="video",
            resource_id="E1S01",
            user_id="user-a",
        )
        active_task = await task_repo.enqueue(
            project_name="demo",
            task_type="video",
            media_type="video",
            resource_id="E1S02",
            user_id="user-a",
        )
        credit_repo = CreditRepository(session, user_id="user-a")
        await credit_repo.add_entry(amount=300, kind="grant")
        await credit_repo.reserve_generation_credits(task_id=stale_task["task_id"], amount=67)
        await credit_repo.reserve_generation_credits(task_id=active_task["task_id"], amount=20)
        await credit_repo.reserve_generation_credits(task_id="missing-task", amount=50)
        await task_repo.mark_succeeded(stale_task["task_id"], result={"ok": True})
        await credit_repo.add_entry(
            amount=-67,
            kind="generation_reservation",
            status="pending",
            reference_type="task",
            reference_id=stale_task["task_id"],
            allow_negative_balance=True,
        )
        await session.commit()

    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/billing/credits/reconciliation/actions",
            json={"action": "release_stale_reservations"},
        )
        balance = client.get("/api/v1/billing/credits")
        reconciliation = client.get("/api/v1/billing/credits/reconciliation")

    assert resp.status_code == 200
    body = resp.json()
    assert body["fixed_count"] == 2
    assert body["skipped_count"] == 1
    assert body["audit"]["action"] == "release_stale_reservations"
    assert body["audit"]["fixed_count"] == 2
    assert body["audit"]["snapshot"]["released"]
    assert {entry["status"] for entry in body["released"]} == {"released"}
    assert all(entry["metadata"]["reconciliation_action"] == "release_stale_reservations" for entry in body["released"])
    assert balance.json()["reserved_generation_credits"] == 20
    codes = {issue["code"] for issue in reconciliation.json()["issues"]}
    assert "stale_generation_reservation" not in codes
    assert "reservation_task_missing" not in codes


async def test_credit_reconciliation_audit_notes_can_be_added_and_listed(app: FastAPI):
    with TestClient(app) as client:
        create_resp = client.post(
            "/api/v1/billing/credits/reconciliation/notes",
            json={
                "note": "人工确认旧版本扣费可保留",
                "issue_code": "usage_without_resource_link",
                "reference_type": "api_call",
                "reference_id": "99",
            },
        )
        list_resp = client.get("/api/v1/billing/credits/reconciliation/audits")

    assert create_resp.status_code == 201
    created = create_resp.json()
    assert created["action"] == "manual_note"
    assert created["note"] == "人工确认旧版本扣费可保留"
    assert created["snapshot"]["issue_code"] == "usage_without_resource_link"
    assert list_resp.status_code == 200
    assert list_resp.json()["audits"][0]["note"] == "人工确认旧版本扣费可保留"


async def test_credit_reconciliation_acknowledgement_marks_issue_non_blocking(session_factory, app: FastAPI):
    async with session_factory() as session:
        repo = CreditRepository(session, user_id="user-a")
        await repo.add_entry(
            amount=-42,
            kind="generation_usage",
            reference_type="task",
            reference_id="task-1",
            metadata={
                "project_name": "demo",
                "resource_id": "E1S01",
                "call_type": "video",
            },
            allow_negative_balance=True,
        )
        await session.commit()

    with TestClient(app) as client:
        before = client.get("/api/v1/billing/credits/reconciliation")
        ack = client.post(
            "/api/v1/billing/credits/reconciliation/acknowledgements",
            json={
                "note": "人工确认历史扣费可保留",
                "issue_code": "usage_task_unmatched",
                "reference_type": "task",
                "reference_id": "task-1",
                "project_name": "demo",
            },
        )
        after = client.get("/api/v1/billing/credits/reconciliation")
        reopen = client.post(
            "/api/v1/billing/credits/reconciliation/reopenings",
            json={
                "note": "撤销确认，重新处理",
                "issue_code": "usage_task_unmatched",
                "reference_type": "task",
                "reference_id": "task-1",
                "project_name": "demo",
            },
        )
        reopened = client.get("/api/v1/billing/credits/reconciliation")

    assert before.status_code == 200
    assert before.json()["ok"] is False
    assert ack.status_code == 201
    assert ack.json()["action"] == "acknowledge_issue"
    assert after.status_code == 200
    body = after.json()
    assert body["ok"] is True
    issue = next(issue for issue in body["issues"] if issue["code"] == "usage_task_unmatched")
    assert issue["acknowledged"] is True
    assert issue["acknowledgement_note"] == "人工确认历史扣费可保留"
    assert reopen.status_code == 201
    assert reopen.json()["action"] == "reopen_issue"
    reopened_body = reopened.json()
    assert reopened_body["ok"] is False
    reopened_issue = next(issue for issue in reopened_body["issues"] if issue["code"] == "usage_task_unmatched")
    assert reopened_issue["acknowledged"] is False


async def test_credit_reconciliation_flags_unmatched_usage(session_factory, app: FastAPI):
    async with session_factory() as session:
        repo = CreditRepository(session, user_id="user-a")
        await repo.add_entry(
            amount=-42,
            kind="generation_usage",
            reference_type="api_call",
            reference_id="999",
            metadata={
                "project_name": "demo",
                "resource_id": "E1S01",
                "call_type": "video",
            },
            allow_negative_balance=True,
        )
        await session.commit()

    with TestClient(app) as client:
        resp = client.get("/api/v1/billing/credits/reconciliation")

    assert resp.status_code == 200
    issues = resp.json()["issues"]
    codes = {issue["code"] for issue in issues}
    assert "usage_api_call_missing" in codes
    assert "usage_task_unmatched" in codes
    unmatched = next(issue for issue in issues if issue["code"] == "usage_task_unmatched")
    assert unmatched["resource_id"] == "E1S01"
    assert unmatched["api_call_id"] == 999
    assert isinstance(unmatched["ledger_entry_id"], int)


async def test_grant_credits_adds_balance(app: FastAPI):
    with TestClient(app) as client:
        grant = client.post(
            "/api/v1/billing/credits/grant",
            json={"amount": 250, "description": "manual top-up"},
        )
        balance = client.get("/api/v1/billing/credits")

    assert grant.status_code == 201
    assert grant.json()["amount"] == 250
    assert balance.json()["balance"] == 250


async def test_admin_can_get_and_grant_target_user_credits(session_factory, app: FastAPI):
    async with session_factory() as session:
        user = await UserRepository(session).create_user(
            username="bob",
            password_hash="hash",
        )
        await CreditRepository(session, user_id=user["id"]).add_entry(amount=400, kind="grant")
        await session.commit()

    with TestClient(app) as client:
        before = client.get(f"/api/v1/billing/admin/users/{user['id']}/credits")
        grant = client.post(
            "/api/v1/billing/credits/grant",
            json={"amount": 250, "user_id": user["id"], "description": "manual top-up"},
        )
        after = client.get(f"/api/v1/billing/admin/users/{user['id']}/credits")

    assert before.status_code == 200
    assert before.json()["balance"] == 400
    assert grant.status_code == 201
    assert grant.json()["metadata"]["granted_by"] == "user-a"
    assert after.json()["balance"] == 650


async def test_non_admin_cannot_get_target_user_credits(app: FastAPI):
    app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="user-a", sub="user-a", role="user")

    with TestClient(app) as client:
        resp = client.get("/api/v1/billing/admin/users/user-b/credits")

    assert resp.status_code == 403


async def test_list_credit_packages(app: FastAPI):
    with TestClient(app) as client:
        resp = client.get("/api/v1/billing/credits/packages")

    assert resp.status_code == 200
    body = resp.json()
    assert body["packages"][0]["id"] == "starter"
    assert body["packages"][0]["credits"] > 0
    assert body["packages"][0]["price_minor"] > 0


async def test_stripe_status_reports_missing_env(app: FastAPI, monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)

    with TestClient(app) as client:
        resp = client.get("/api/v1/billing/stripe/status")

    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is False
    assert body["missing"] == ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]
    assert body["mode"] == "unknown"
    assert body["sandbox_tools_enabled"] is False
    assert body["webhook_path"] == "/api/v1/billing/stripe/webhook"


async def test_stripe_status_reports_configured(app: FastAPI, monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_demo")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")

    with TestClient(app) as client:
        resp = client.get("/api/v1/billing/stripe/status")

    assert resp.status_code == 200
    assert resp.json()["configured"] is True
    assert resp.json()["mode"] == "test"
    assert resp.json()["missing"] == []


async def test_stripe_status_reports_sandbox_tools(app: FastAPI, monkeypatch):
    monkeypatch.setenv("BILLING_SANDBOX_TOOLS", "1")

    with TestClient(app) as client:
        resp = client.get("/api/v1/billing/stripe/status")

    assert resp.status_code == 200
    assert resp.json()["sandbox_tools_enabled"] is True


async def test_create_credit_order_is_pending_and_does_not_increase_balance(app: FastAPI):
    with TestClient(app) as client:
        order = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "starter", "payment_method": "manual"},
        )
        balance = client.get("/api/v1/billing/credits")

    assert order.status_code == 201
    body = order.json()
    assert body["status"] == "pending"
    assert body["package"]["id"] == "starter"
    assert body["ledger_entry"]["kind"] == "purchase"
    assert body["ledger_entry"]["status"] == "pending"
    assert balance.json()["balance"] == 0
    assert balance.json()["pending_purchase_credits"] == body["package"]["credits"]


async def test_get_credit_order_returns_current_status(app: FastAPI):
    with TestClient(app) as client:
        order = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "starter", "payment_method": "manual"},
        ).json()
        lookup = client.get(f"/api/v1/billing/credits/orders/{order['order_id']}")

    assert lookup.status_code == 200
    body = lookup.json()
    assert body["reference_id"] == order["order_id"]
    assert body["kind"] == "purchase"
    assert body["status"] == "pending"


async def test_get_credit_order_404s_unknown_order(app: FastAPI):
    with TestClient(app) as client:
        lookup = client.get("/api/v1/billing/credits/orders/co_missing")

    assert lookup.status_code == 404


async def test_cancel_pending_manual_credit_order(app: FastAPI):
    with TestClient(app) as client:
        order = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "starter", "payment_method": "manual"},
        ).json()
        cancel = client.post(f"/api/v1/billing/credits/orders/{order['order_id']}/cancel")
        balance = client.get("/api/v1/billing/credits")

    assert cancel.status_code == 200
    assert cancel.json()["status"] == "cancelled"
    assert cancel.json()["metadata"]["cancelled_by"] == "user-a"
    assert balance.json()["balance"] == 0
    assert balance.json()["pending_purchase_credits"] == 0


async def test_cancel_posted_credit_order_rejected(app: FastAPI):
    with TestClient(app) as client:
        order = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "starter", "payment_method": "manual"},
        ).json()
        client.post(
            f"/api/v1/billing/credits/orders/{order['order_id']}/confirm",
            json={"payment_reference": "pay_123"},
        )
        cancel = client.post(f"/api/v1/billing/credits/orders/{order['order_id']}/cancel")

    assert cancel.status_code == 400
    assert cancel.json()["detail"] == "credit order is not pending"


async def test_create_stripe_credit_order_returns_checkout_url(app: FastAPI, monkeypatch):
    async def _fake_checkout_session(**kwargs):
        return {
            "id": "cs_test_123",
            "url": "https://checkout.stripe.com/c/pay/cs_test_123",
        }

    monkeypatch.setattr(billing, "create_checkout_session", _fake_checkout_session)

    with TestClient(app) as client:
        order = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "starter", "payment_method": "stripe"},
        )
        balance = client.get("/api/v1/billing/credits")

    assert order.status_code == 201
    body = order.json()
    assert body["status"] == "pending"
    assert body["payment_url"] == "https://checkout.stripe.com/c/pay/cs_test_123"
    assert body["ledger_entry"]["metadata"]["payment_method"] == "stripe"
    assert body["ledger_entry"]["metadata"]["stripe_checkout_session_id"] == "cs_test_123"
    assert balance.json()["balance"] == 0


async def test_cancel_stripe_credit_order_rejected(app: FastAPI, monkeypatch):
    async def _fake_checkout_session(**kwargs):
        return {
            "id": "cs_test_123",
            "url": "https://checkout.stripe.com/c/pay/cs_test_123",
        }

    monkeypatch.setattr(billing, "create_checkout_session", _fake_checkout_session)

    with TestClient(app) as client:
        order = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "starter", "payment_method": "stripe"},
        ).json()
        cancel = client.post(f"/api/v1/billing/credits/orders/{order['order_id']}/cancel")

    assert cancel.status_code == 400
    assert cancel.json()["detail"] == "stripe checkout order cannot be cancelled locally"


async def test_create_stripe_credit_order_requires_configuration(app: FastAPI, monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)

    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "starter", "payment_method": "stripe"},
        )

    assert resp.status_code == 503
    assert "STRIPE_SECRET_KEY" in resp.json()["detail"]


async def test_confirm_credit_order_posts_balance(app: FastAPI):
    with TestClient(app) as client:
        order = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "starter", "payment_method": "manual"},
        ).json()
        confirm = client.post(
            f"/api/v1/billing/credits/orders/{order['order_id']}/confirm",
            json={"payment_reference": "pay_123"},
        )
        balance = client.get("/api/v1/billing/credits")

    assert confirm.status_code == 200
    assert confirm.json()["status"] == "posted"
    assert confirm.json()["metadata"]["payment_reference"] == "pay_123"
    assert balance.json()["balance"] == order["package"]["credits"]


async def test_sandbox_confirm_credit_order_requires_flag(app: FastAPI, monkeypatch):
    monkeypatch.delenv("BILLING_SANDBOX_TOOLS", raising=False)
    with TestClient(app) as client:
        order = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "starter", "payment_method": "manual"},
        ).json()
        confirm = client.post(f"/api/v1/billing/credits/orders/{order['order_id']}/sandbox-confirm")

    assert confirm.status_code == 403
    assert confirm.json()["detail"] == "billing sandbox tools are disabled"


async def test_sandbox_confirm_credit_order_posts_balance(app: FastAPI, monkeypatch):
    monkeypatch.setenv("BILLING_SANDBOX_TOOLS", "1")
    with TestClient(app) as client:
        order = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "starter", "payment_method": "manual"},
        ).json()
        confirm = client.post(f"/api/v1/billing/credits/orders/{order['order_id']}/sandbox-confirm")
        balance = client.get("/api/v1/billing/credits")

    assert confirm.status_code == 200
    assert confirm.json()["status"] == "posted"
    assert confirm.json()["metadata"]["confirmed_by"] == "billing_sandbox_tools"
    assert balance.json()["balance"] == order["package"]["credits"]


async def test_stripe_webhook_posts_pending_order(session_factory, app: FastAPI, monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    async with session_factory() as session:
        repo = CreditRepository(session, user_id="user-a")
        await repo.add_entry(
            amount=1000,
            kind="purchase",
            status="pending",
            reference_type="credit_order",
            reference_id="co_test",
            metadata={"payment_method": "stripe"},
        )
        await session.commit()

    event = {
        "id": "evt_test",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_test_123",
                "client_reference_id": "co_test",
                "payment_status": "paid",
                "payment_intent": "pi_test_123",
                "metadata": {
                    "order_id": "co_test",
                    "user_id": "user-a",
                    "package_id": "starter",
                },
            }
        },
    }
    payload = json.dumps(event, separators=(",", ":")).encode("utf-8")

    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/billing/stripe/webhook",
            content=payload,
            headers={
                "Content-Type": "application/json",
                "Stripe-Signature": _stripe_signature(payload, "whsec_test"),
            },
        )
        balance = client.get("/api/v1/billing/credits")

    assert resp.status_code == 200
    assert resp.json()["status"] == "posted"
    assert balance.json()["balance"] == 1000
    posted = balance.json()["entries"][0]
    assert posted["metadata"]["confirmed_by"] == "stripe_webhook"
    assert posted["metadata"]["stripe_payment_intent"] == "pi_test_123"


async def test_stripe_webhook_rejects_bad_signature(app: FastAPI, monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    payload = b'{"id":"evt_bad","type":"checkout.session.completed"}'

    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/billing/stripe/webhook",
            content=payload,
            headers={"Stripe-Signature": "t=1,v1=bad"},
        )

    assert resp.status_code == 400


async def test_create_credit_order_rejects_unknown_package(app: FastAPI):
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/billing/credits/orders",
            json={"package_id": "missing", "payment_method": "manual"},
        )

    assert resp.status_code == 404
