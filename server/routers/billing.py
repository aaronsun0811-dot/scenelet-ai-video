"""Billing and credit balance APIs."""

from __future__ import annotations

import json
from typing import Any, Literal
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lib.billing_packages import get_credit_package, list_credit_packages
from lib.credit_utils import minimum_generation_balance
from lib.db import get_async_session
from lib.db.base import dt_to_iso
from lib.db.models.api_call import ApiCall
from lib.db.models.credit import CreditLedgerEntry, CreditReconciliationAudit
from lib.db.models.task import Task
from lib.db.repositories.credit_repository import CreditRepository
from lib.db.repositories.user_repository import UserRepository
from server.auth import CurrentUser
from server.services.stripe_checkout import (
    StripeConfigurationError,
    StripeSignatureError,
    billing_sandbox_tools_enabled,
    create_checkout_session,
    parse_stripe_event,
    stripe_configuration_status,
)

router = APIRouter(prefix="/billing", tags=["Billing"])
CreditReconciliationAction = Literal["release_stale_reservations"]
ACTIVE_TASK_STATUSES = {"queued", "running"}


class CreditEntryResponse(BaseModel):
    id: int
    amount: int
    kind: str
    status: str
    reference_type: str | None = None
    reference_id: str | None = None
    description: str | None = None
    metadata: dict[str, Any] | None = None
    created_at: str | None = None


class CreditBalanceResponse(BaseModel):
    balance: int
    available_balance: int
    reserved_generation_credits: int
    minimum_generation_balance: int
    pending_purchase_credits: int
    entries: list[CreditEntryResponse]


class CreditReconciliationIssue(BaseModel):
    severity: Literal["info", "warning", "error"]
    code: str
    title: str
    detail: str
    suggestion: str | None = None
    action: CreditReconciliationAction | None = None
    action_label: str | None = None
    acknowledged: bool = False
    acknowledged_at: str | None = None
    acknowledged_by: str | None = None
    acknowledgement_note: str | None = None
    reference_type: str | None = None
    reference_id: str | None = None
    project_name: str | None = None
    task_id: str | None = None
    task_status: str | None = None
    resource_id: str | None = None
    ledger_entry_id: int | None = None
    api_call_id: int | None = None
    amount: int | None = None
    created_at: str | None = None


class CreditReconciliationResponse(BaseModel):
    ok: bool
    checked_entries: int
    checked_tasks: int
    checked_api_calls: int
    issues: list[CreditReconciliationIssue]


class CreditReconciliationActionRequest(BaseModel):
    action: CreditReconciliationAction = "release_stale_reservations"
    note: str | None = Field(default=None, max_length=1000)


class CreditReconciliationAuditResponse(BaseModel):
    id: int
    action: str
    status: str
    actor_user_id: str | None = None
    fixed_count: int
    skipped_count: int
    note: str | None = None
    summary: str | None = None
    snapshot: dict[str, Any] | None = None
    created_at: str | None = None


class CreditReconciliationAuditsResponse(BaseModel):
    audits: list[CreditReconciliationAuditResponse]


class CreditReconciliationNoteRequest(BaseModel):
    note: str = Field(min_length=1, max_length=1000)
    issue_code: str | None = Field(default=None, max_length=64)
    reference_type: str | None = Field(default=None, max_length=64)
    reference_id: str | None = Field(default=None, max_length=128)
    project_name: str | None = Field(default=None, max_length=255)
    task_id: str | None = Field(default=None, max_length=128)


class CreditReconciliationAcknowledgeRequest(BaseModel):
    note: str = Field(min_length=1, max_length=1000)
    issue_code: str = Field(max_length=64)
    reference_type: str | None = Field(default=None, max_length=64)
    reference_id: str | None = Field(default=None, max_length=128)
    project_name: str | None = Field(default=None, max_length=255)
    task_id: str | None = Field(default=None, max_length=128)


class CreditReconciliationReopenRequest(BaseModel):
    note: str = Field(min_length=1, max_length=1000)
    issue_code: str = Field(max_length=64)
    reference_type: str | None = Field(default=None, max_length=64)
    reference_id: str | None = Field(default=None, max_length=128)
    project_name: str | None = Field(default=None, max_length=255)
    task_id: str | None = Field(default=None, max_length=128)


class CreditReconciliationActionResult(BaseModel):
    action: CreditReconciliationAction
    fixed_count: int
    skipped_count: int
    released: list[CreditEntryResponse]
    audit: CreditReconciliationAuditResponse
    message: str


class CreditPackageResponse(BaseModel):
    id: str
    credits: int
    currency: str
    price_minor: int
    description: str | None = None


class CreditPackagesResponse(BaseModel):
    packages: list[CreditPackageResponse]


class StripeStatusResponse(BaseModel):
    configured: bool
    missing: list[str]
    mode: Literal["test", "live", "unknown"]
    sandbox_tools_enabled: bool
    frontend_base_url: str
    webhook_path: str


class CreateCreditOrderRequest(BaseModel):
    package_id: str
    payment_method: Literal["manual", "wechat", "alipay", "stripe"] = "manual"
    idempotency_key: str | None = None


class CreditOrderResponse(BaseModel):
    order_id: str
    status: str
    package: CreditPackageResponse
    payment_method: str
    payment_url: str | None = None
    ledger_entry: CreditEntryResponse


class ConfirmCreditOrderRequest(BaseModel):
    user_id: str | None = None
    payment_reference: str | None = None


class GrantCreditsRequest(BaseModel):
    amount: int = Field(gt=0)
    user_id: str | None = None
    description: str | None = None
    idempotency_key: str | None = None


def _credit_metadata(row: CreditLedgerEntry) -> dict[str, Any]:
    if not row.metadata_json:
        return {}
    try:
        data = json.loads(row.metadata_json)
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _credit_entry_response(row: CreditLedgerEntry) -> CreditEntryResponse:
    metadata = _credit_metadata(row)
    return CreditEntryResponse(
        id=row.id,
        amount=row.amount,
        kind=row.kind,
        status=row.status,
        reference_type=row.reference_type,
        reference_id=row.reference_id,
        description=row.description,
        metadata=metadata or None,
        created_at=dt_to_iso(row.created_at),
    )


def _audit_snapshot(row: CreditReconciliationAudit) -> dict[str, Any] | None:
    if not row.snapshot_json:
        return None
    try:
        data = json.loads(row.snapshot_json)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _audit_response(row: CreditReconciliationAudit) -> CreditReconciliationAuditResponse:
    return CreditReconciliationAuditResponse(
        id=row.id,
        action=row.action,
        status=row.status,
        actor_user_id=row.actor_user_id,
        fixed_count=row.fixed_count,
        skipped_count=row.skipped_count,
        note=row.note,
        summary=row.summary,
        snapshot=_audit_snapshot(row),
        created_at=dt_to_iso(row.created_at),
    )


def _reconciliation_issue_key(
    *,
    issue_code: str | None,
    reference_type: str | None = None,
    reference_id: str | None = None,
    project_name: str | None = None,
    task_id: str | None = None,
) -> str:
    return "|".join(
        [
            issue_code or "",
            reference_type or "",
            reference_id or "",
            project_name or "",
            task_id or "",
        ]
    )


def _issue_key(issue: CreditReconciliationIssue) -> str:
    return _reconciliation_issue_key(
        issue_code=issue.code,
        reference_type=issue.reference_type,
        reference_id=issue.reference_id,
        project_name=issue.project_name,
        task_id=issue.task_id,
    )


def _metadata_resource_id(metadata: dict[str, Any]) -> str | None:
    resource_id = metadata.get("resource_id") or metadata.get("segment_id") or metadata.get("task_id")
    return resource_id if isinstance(resource_id, str) and resource_id else None


def _ledger_api_call_id(row: CreditLedgerEntry) -> int | None:
    if row.reference_type != "api_call" or not row.reference_id or not str(row.reference_id).isdigit():
        return None
    return int(row.reference_id)


async def _create_reconciliation_audit(
    *,
    session: AsyncSession,
    user_id: str,
    actor_user_id: str,
    action: str,
    fixed_count: int = 0,
    skipped_count: int = 0,
    note: str | None = None,
    summary: str | None = None,
    snapshot: dict[str, Any] | None = None,
) -> CreditReconciliationAudit:
    row = CreditReconciliationAudit(
        user_id=user_id,
        action=action,
        status="completed",
        actor_user_id=actor_user_id,
        fixed_count=fixed_count,
        skipped_count=skipped_count,
        note=note,
        summary=summary,
        snapshot_json=json.dumps(snapshot, ensure_ascii=False) if snapshot else None,
    )
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return row


def _task_media_for_call_type(call_type: str | None) -> str | None:
    if call_type == "image":
        return "image"
    if call_type == "video":
        return "video"
    return None


def _task_matches_usage(task: Task, row: CreditLedgerEntry) -> bool:
    metadata = _credit_metadata(row)
    project_name = metadata.get("project_name")
    resource_id = metadata.get("resource_id") or metadata.get("segment_id") or metadata.get("task_id")
    if not isinstance(resource_id, str) or not resource_id:
        return False
    if isinstance(project_name, str) and project_name and task.project_name != project_name:
        return False
    if task.resource_id != resource_id:
        return False
    media_type = _task_media_for_call_type(metadata.get("call_type") if isinstance(metadata.get("call_type"), str) else None)
    return media_type is None or task.media_type == media_type


async def _post_pending_credit_order(
    *,
    order_id: str,
    user_id: str,
    session: AsyncSession,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    repo = CreditRepository(session, user_id=user_id)
    existing = await repo.get_by_reference("credit_order", order_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="credit order not found")
    if existing["kind"] != "purchase":
        raise HTTPException(status_code=400, detail="not a purchase order")
    if existing["status"] == "posted":
        return existing
    if existing["status"] != "pending":
        raise HTTPException(status_code=400, detail="credit order is not pending")

    entry = await repo.update_status_by_reference(
        reference_type="credit_order",
        reference_id=order_id,
        status="posted",
        metadata=metadata,
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="credit order not found")
    return entry


@router.get("/credits", response_model=CreditBalanceResponse)
async def get_credits(
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> CreditBalanceResponse:
    repo = CreditRepository(session, user_id=_user.id)
    balance = await repo.get_balance()
    reserved_generation_credits = await repo.get_reserved_generation_credits()
    available_balance = balance - reserved_generation_credits
    pending_purchase_credits = await repo.get_pending_purchase_credits()
    entries = await repo.list_entries(limit=limit, offset=offset)
    return CreditBalanceResponse(
        balance=balance,
        available_balance=available_balance,
        reserved_generation_credits=reserved_generation_credits,
        minimum_generation_balance=minimum_generation_balance(),
        pending_purchase_credits=pending_purchase_credits,
        entries=[CreditEntryResponse(**entry) for entry in entries],
    )


@router.get("/credits/reconciliation", response_model=CreditReconciliationResponse)
async def reconcile_credits(
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
    limit: int = Query(1000, ge=1, le=5000),
) -> CreditReconciliationResponse:
    """Check credit ledger consistency against tasks and API-call usage."""
    ledger_rows = list(
        (
            await session.execute(
                select(CreditLedgerEntry)
                .where(CreditLedgerEntry.user_id == _user.id)
                .order_by(CreditLedgerEntry.created_at.desc(), CreditLedgerEntry.id.desc())
                .limit(limit)
            )
        ).scalars()
    )
    tasks = list(
        (
            await session.execute(
                select(Task)
                .where(Task.user_id == _user.id)
                .order_by(Task.updated_at.desc())
            )
        ).scalars()
    )
    api_call_ids = [
        int(row.reference_id)
        for row in ledger_rows
        if row.kind == "generation_usage"
        and row.reference_type == "api_call"
        and row.reference_id
        and str(row.reference_id).isdigit()
    ]
    api_calls = list(
        (
            await session.execute(
                select(ApiCall).where(
                    ApiCall.user_id == _user.id,
                    ApiCall.id.in_(api_call_ids or [-1]),
                )
            )
        ).scalars()
    )

    task_by_id = {task.task_id: task for task in tasks}
    api_call_by_id = {str(call.id): call for call in api_calls}
    usage_rows = [row for row in ledger_rows if row.kind == "generation_usage" and row.status == "posted"]
    issues: list[CreditReconciliationIssue] = []

    for row in ledger_rows:
        if row.kind != "generation_reservation":
            continue
        task_id = row.reference_id or ""
        task = task_by_id.get(task_id)
        if row.status == "pending" and task is None:
            issues.append(
                CreditReconciliationIssue(
                    severity="warning",
                    code="reservation_task_missing",
                    title="冻结积分找不到任务",
                    detail="这笔生成冻结仍在 pending，但对应任务记录不存在，可能需要人工释放或核查。",
                    suggestion="可一键释放这笔无效冻结；如果这是刚删除或迁移过的任务，释放后建议刷新积分明细确认。",
                    action="release_stale_reservations",
                    action_label="一键释放无效冻结",
                    reference_type=row.reference_type,
                    reference_id=row.reference_id,
                    ledger_entry_id=row.id,
                    amount=abs(row.amount),
                    created_at=dt_to_iso(row.created_at),
                )
            )
            continue

        if row.status == "pending" and task and task.status not in ACTIVE_TASK_STATUSES:
            issues.append(
                CreditReconciliationIssue(
                    severity="error",
                    code="stale_generation_reservation",
                    title="非进行中任务仍冻结积分",
                    detail=f"任务状态为 {task.status}，但预计积分仍处于冻结中。",
                    suggestion="可一键释放这笔无效冻结；该动作只改冻结状态，不会改动生成产物或实际扣费流水。",
                    action="release_stale_reservations",
                    action_label="一键释放无效冻结",
                    reference_type=row.reference_type,
                    reference_id=row.reference_id,
                    project_name=task.project_name,
                    task_id=task.task_id,
                    task_status=task.status,
                    resource_id=task.resource_id,
                    ledger_entry_id=row.id,
                    amount=abs(row.amount),
                    created_at=dt_to_iso(row.created_at),
                )
            )

        if row.status == "released" and task and task.status in ACTIVE_TASK_STATUSES:
            issues.append(
                CreditReconciliationIssue(
                    severity="warning",
                    code="active_task_released_reservation",
                    title="进行中任务的冻结已释放",
                    detail="任务仍在排队或生成中，但冻结记录已释放，后续可能无法准确阻止超额提交。",
                    suggestion="建议等待任务完成后复查；若任务长期卡住，先取消或重试任务，再重新提交生成。",
                    reference_type=row.reference_type,
                    reference_id=row.reference_id,
                    project_name=task.project_name,
                    task_id=task.task_id,
                    task_status=task.status,
                    resource_id=task.resource_id,
                    ledger_entry_id=row.id,
                    amount=abs(row.amount),
                    created_at=dt_to_iso(row.created_at),
                )
            )

    for row in usage_rows:
        metadata = _credit_metadata(row)
        resource_id = _metadata_resource_id(metadata)
        if row.reference_type == "api_call" and row.reference_id and row.reference_id not in api_call_by_id:
            issues.append(
                CreditReconciliationIssue(
                    severity="warning",
                    code="usage_api_call_missing",
                    title="扣费流水找不到 API 调用",
                    detail="这笔实际扣费指向的 API 调用记录不存在，无法追溯供应商调用细节。",
                    suggestion="建议核查 api_calls 是否被清理或迁移；这类已扣费流水不自动退款，避免误退真实成本。",
                    reference_type=row.reference_type,
                    reference_id=row.reference_id,
                    project_name=metadata.get("project_name") if isinstance(metadata.get("project_name"), str) else None,
                    resource_id=resource_id,
                    ledger_entry_id=row.id,
                    api_call_id=_ledger_api_call_id(row),
                    amount=abs(row.amount),
                    created_at=dt_to_iso(row.created_at),
                )
            )

        if resource_id and not any(_task_matches_usage(task, row) for task in tasks):
            issues.append(
                CreditReconciliationIssue(
                    severity="warning",
                    code="usage_task_unmatched",
                    title="扣费流水找不到匹配任务",
                    detail="这笔实际扣费带有资源 ID，但当前任务表中找不到同项目、同资源、同媒体类型的任务。",
                    suggestion="建议检查任务清理、项目改名或资源 ID 迁移记录；确认无误后可保留为历史扣费凭证。",
                    reference_type=row.reference_type,
                    reference_id=row.reference_id,
                    project_name=metadata.get("project_name") if isinstance(metadata.get("project_name"), str) else None,
                    resource_id=resource_id,
                    ledger_entry_id=row.id,
                    api_call_id=_ledger_api_call_id(row),
                    amount=abs(row.amount),
                    created_at=dt_to_iso(row.created_at),
                )
            )
        elif not resource_id:
            issues.append(
                CreditReconciliationIssue(
                    severity="info",
                    code="usage_without_resource_link",
                    title="扣费流水缺少资源 ID",
                    detail="这笔扣费可能来自项目级素材生成或旧版本记录，无法直接关联到任务行。",
                    suggestion="旧版本或项目级扣费通常无需自动处理；后续新生成会写入资源 ID 便于追踪。",
                    reference_type=row.reference_type,
                    reference_id=row.reference_id,
                    project_name=metadata.get("project_name") if isinstance(metadata.get("project_name"), str) else None,
                    ledger_entry_id=row.id,
                    api_call_id=_ledger_api_call_id(row),
                    amount=abs(row.amount),
                    created_at=dt_to_iso(row.created_at),
                )
            )

    for task in tasks:
        if task.status != "succeeded":
            continue
        had_reservation = any(
            row.kind == "generation_reservation" and row.reference_type == "task" and row.reference_id == task.task_id
            for row in ledger_rows
        )
        has_usage = any(_task_matches_usage(row=usage_row, task=task) for usage_row in usage_rows)
        if had_reservation and not has_usage:
            issues.append(
                CreditReconciliationIssue(
                    severity="warning",
                    code="succeeded_reserved_task_without_usage",
                    title="成功任务缺少实际扣费",
                    detail="任务曾冻结平台积分且已成功，但未找到可匹配的实际扣费流水。",
                    suggestion="建议查看供应商调用是否免费、失败后产物复用，或扣费 metadata 是否缺少资源 ID。",
                    project_name=task.project_name,
                    task_id=task.task_id,
                    task_status=task.status,
                    resource_id=task.resource_id,
                )
            )

    acknowledgement_rows = list(
        (
            await session.execute(
                select(CreditReconciliationAudit)
                .where(
                    CreditReconciliationAudit.user_id == _user.id,
                    CreditReconciliationAudit.action.in_(("acknowledge_issue", "reopen_issue")),
                )
                .order_by(CreditReconciliationAudit.created_at.desc(), CreditReconciliationAudit.id.desc())
            )
        ).scalars()
    )
    latest_acknowledgement_state_by_key: dict[str, CreditReconciliationAudit] = {}
    for audit in acknowledgement_rows:
        snapshot = _audit_snapshot(audit) or {}
        key = _reconciliation_issue_key(
            issue_code=snapshot.get("issue_code") if isinstance(snapshot.get("issue_code"), str) else None,
            reference_type=snapshot.get("reference_type") if isinstance(snapshot.get("reference_type"), str) else None,
            reference_id=snapshot.get("reference_id") if isinstance(snapshot.get("reference_id"), str) else None,
            project_name=snapshot.get("project_name") if isinstance(snapshot.get("project_name"), str) else None,
            task_id=snapshot.get("task_id") if isinstance(snapshot.get("task_id"), str) else None,
        )
        latest_acknowledgement_state_by_key.setdefault(key, audit)

    for issue in issues:
        acknowledgement = latest_acknowledgement_state_by_key.get(_issue_key(issue))
        if acknowledgement is None or acknowledgement.action != "acknowledge_issue":
            continue
        issue.acknowledged = True
        issue.acknowledged_at = dt_to_iso(acknowledgement.created_at)
        issue.acknowledged_by = acknowledgement.actor_user_id
        issue.acknowledgement_note = acknowledgement.note

    blocking = [
        issue
        for issue in issues
        if issue.severity in {"warning", "error"} and not issue.acknowledged
    ]
    return CreditReconciliationResponse(
        ok=len(blocking) == 0,
        checked_entries=len(ledger_rows),
        checked_tasks=len(tasks),
        checked_api_calls=len(api_calls),
        issues=issues,
    )


@router.get("/credits/reconciliation/audits", response_model=CreditReconciliationAuditsResponse)
async def list_credit_reconciliation_audits(
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
    limit: int = Query(20, ge=1, le=100),
) -> CreditReconciliationAuditsResponse:
    rows = list(
        (
            await session.execute(
                select(CreditReconciliationAudit)
                .where(CreditReconciliationAudit.user_id == _user.id)
                .order_by(CreditReconciliationAudit.created_at.desc(), CreditReconciliationAudit.id.desc())
                .limit(limit)
            )
        ).scalars()
    )
    return CreditReconciliationAuditsResponse(audits=[_audit_response(row) for row in rows])


@router.post("/credits/reconciliation/actions", response_model=CreditReconciliationActionResult)
async def run_credit_reconciliation_action(
    payload: CreditReconciliationActionRequest,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
) -> CreditReconciliationActionResult:
    """Run safe, narrowly scoped credit-reconciliation repair actions."""
    if payload.action != "release_stale_reservations":
        raise HTTPException(status_code=400, detail="unsupported reconciliation action")

    reservation_rows = list(
        (
            await session.execute(
                select(CreditLedgerEntry)
                .where(
                    CreditLedgerEntry.user_id == _user.id,
                    CreditLedgerEntry.kind == "generation_reservation",
                    CreditLedgerEntry.status == "pending",
                    CreditLedgerEntry.amount < 0,
                )
                .order_by(CreditLedgerEntry.created_at.desc(), CreditLedgerEntry.id.desc())
            )
        ).scalars()
    )
    task_ids = list(dict.fromkeys(row.reference_id for row in reservation_rows if row.reference_id))
    task_by_id: dict[str, Task] = {}
    if task_ids:
        task_rows = list(
            (
                await session.execute(
                    select(Task).where(
                        Task.user_id == _user.id,
                        Task.task_id.in_(task_ids),
                    )
                )
            ).scalars()
        )
        task_by_id = {task.task_id: task for task in task_rows}

    released_rows: list[CreditLedgerEntry] = []
    skipped_rows: list[CreditLedgerEntry] = []
    skipped_count = 0
    for row in reservation_rows:
        task = task_by_id.get(row.reference_id or "")
        if task is not None and task.status in ACTIVE_TASK_STATUSES:
            skipped_rows.append(row)
            skipped_count += 1
            continue

        metadata = _credit_metadata(row)
        metadata.update(
            {
                "reconciliation_action": payload.action,
                "reconciled_by": _user.id,
            }
        )
        row.status = "released"
        row.metadata_json = json.dumps(metadata, ensure_ascii=False)
        released_rows.append(row)

    if released_rows:
        await session.flush()
        for row in released_rows:
            await session.refresh(row)

    fixed_count = len(released_rows)
    released_snapshot = [
        {
            "ledger_id": row.id,
            "reference_type": row.reference_type,
            "reference_id": row.reference_id,
            "amount": abs(row.amount),
            "status": row.status,
        }
        for row in released_rows
    ]
    skipped_snapshot = [
        {
            "ledger_id": row.id,
            "reference_type": row.reference_type,
            "reference_id": row.reference_id,
            "amount": abs(row.amount),
            "task_status": task_by_id.get(row.reference_id or "").status if row.reference_id in task_by_id else None,
        }
        for row in skipped_rows
    ]
    note = payload.note.strip() if payload.note else None
    audit = await _create_reconciliation_audit(
        session=session,
        user_id=_user.id,
        actor_user_id=_user.id,
        action=payload.action,
        fixed_count=fixed_count,
        skipped_count=skipped_count,
        note=note,
        summary=f"已释放 {fixed_count} 条无效生成冻结，跳过 {skipped_count} 条仍在进行中的冻结。",
        snapshot={
            "released": released_snapshot,
            "skipped": skipped_snapshot,
        },
    )
    await session.commit()
    return CreditReconciliationActionResult(
        action=payload.action,
        fixed_count=fixed_count,
        skipped_count=skipped_count,
        released=[_credit_entry_response(row) for row in released_rows],
        audit=_audit_response(audit),
        message=f"已释放 {fixed_count} 条无效生成冻结，跳过 {skipped_count} 条仍在进行中的冻结。",
    )


@router.post("/credits/reconciliation/notes", status_code=201, response_model=CreditReconciliationAuditResponse)
async def add_credit_reconciliation_note(
    payload: CreditReconciliationNoteRequest,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
) -> CreditReconciliationAuditResponse:
    note = payload.note.strip()
    if not note:
        raise HTTPException(status_code=400, detail="note must not be empty")

    snapshot = {
        key: value
        for key, value in {
            "issue_code": payload.issue_code,
            "reference_type": payload.reference_type,
            "reference_id": payload.reference_id,
            "project_name": payload.project_name,
            "task_id": payload.task_id,
        }.items()
        if value
    }
    audit = await _create_reconciliation_audit(
        session=session,
        user_id=_user.id,
        actor_user_id=_user.id,
        action="manual_note",
        note=note,
        summary="已添加对账处理备注。",
        snapshot=snapshot or None,
    )
    await session.commit()
    return _audit_response(audit)


@router.post(
    "/credits/reconciliation/acknowledgements",
    status_code=201,
    response_model=CreditReconciliationAuditResponse,
)
async def acknowledge_credit_reconciliation_issue(
    payload: CreditReconciliationAcknowledgeRequest,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
) -> CreditReconciliationAuditResponse:
    note = payload.note.strip()
    if not note:
        raise HTTPException(status_code=400, detail="note must not be empty")

    snapshot = {
        key: value
        for key, value in {
            "issue_code": payload.issue_code,
            "reference_type": payload.reference_type,
            "reference_id": payload.reference_id,
            "project_name": payload.project_name,
            "task_id": payload.task_id,
        }.items()
        if value
    }
    audit = await _create_reconciliation_audit(
        session=session,
        user_id=_user.id,
        actor_user_id=_user.id,
        action="acknowledge_issue",
        note=note,
        summary=f"已确认对账异常：{payload.issue_code}",
        snapshot=snapshot,
    )
    await session.commit()
    return _audit_response(audit)


@router.post(
    "/credits/reconciliation/reopenings",
    status_code=201,
    response_model=CreditReconciliationAuditResponse,
)
async def reopen_credit_reconciliation_issue(
    payload: CreditReconciliationReopenRequest,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
) -> CreditReconciliationAuditResponse:
    note = payload.note.strip()
    if not note:
        raise HTTPException(status_code=400, detail="note must not be empty")

    snapshot = {
        key: value
        for key, value in {
            "issue_code": payload.issue_code,
            "reference_type": payload.reference_type,
            "reference_id": payload.reference_id,
            "project_name": payload.project_name,
            "task_id": payload.task_id,
        }.items()
        if value
    }
    audit = await _create_reconciliation_audit(
        session=session,
        user_id=_user.id,
        actor_user_id=_user.id,
        action="reopen_issue",
        note=note,
        summary=f"已撤销对账异常确认：{payload.issue_code}",
        snapshot=snapshot,
    )
    await session.commit()
    return _audit_response(audit)


@router.get("/admin/users/{user_id}/credits", response_model=CreditBalanceResponse)
async def get_user_credits(
    user_id: str,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> CreditBalanceResponse:
    if _user.role != "admin":
        raise HTTPException(status_code=403, detail="admin required")
    target = await UserRepository(session).get_by_id(user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="user not found")

    repo = CreditRepository(session, user_id=user_id)
    balance = await repo.get_balance()
    reserved_generation_credits = await repo.get_reserved_generation_credits()
    available_balance = balance - reserved_generation_credits
    pending_purchase_credits = await repo.get_pending_purchase_credits()
    entries = await repo.list_entries(limit=limit, offset=offset)
    return CreditBalanceResponse(
        balance=balance,
        available_balance=available_balance,
        reserved_generation_credits=reserved_generation_credits,
        minimum_generation_balance=minimum_generation_balance(),
        pending_purchase_credits=pending_purchase_credits,
        entries=[CreditEntryResponse(**entry) for entry in entries],
    )


@router.get("/credits/packages", response_model=CreditPackagesResponse)
async def list_packages(_user: CurrentUser) -> CreditPackagesResponse:
    return CreditPackagesResponse(
        packages=[CreditPackageResponse(**package) for package in list_credit_packages()]
    )


@router.get("/stripe/status", response_model=StripeStatusResponse)
async def stripe_status(_user: CurrentUser) -> StripeStatusResponse:
    return StripeStatusResponse(**stripe_configuration_status())


@router.get("/credits/orders/{order_id}", response_model=CreditEntryResponse)
async def get_credit_order(
    order_id: str,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
) -> CreditEntryResponse:
    repo = CreditRepository(session, user_id=_user.id)
    entry = await repo.get_by_reference("credit_order", order_id)
    if entry is None or entry["kind"] != "purchase":
        raise HTTPException(status_code=404, detail="credit order not found")
    return CreditEntryResponse(**entry)


@router.post("/credits/orders/{order_id}/cancel", response_model=CreditEntryResponse)
async def cancel_credit_order(
    order_id: str,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
) -> CreditEntryResponse:
    repo = CreditRepository(session, user_id=_user.id)
    entry = await repo.get_by_reference("credit_order", order_id)
    if entry is None or entry["kind"] != "purchase":
        raise HTTPException(status_code=404, detail="credit order not found")
    if entry["status"] == "cancelled":
        return CreditEntryResponse(**entry)
    if entry["status"] != "pending":
        raise HTTPException(status_code=400, detail="credit order is not pending")

    metadata = entry.get("metadata") or {}
    if metadata.get("payment_method") == "stripe":
        raise HTTPException(status_code=400, detail="stripe checkout order cannot be cancelled locally")

    cancelled = await repo.update_status_by_reference(
        reference_type="credit_order",
        reference_id=order_id,
        status="cancelled",
        metadata={"cancelled_by": _user.id},
    )
    if cancelled is None:
        raise HTTPException(status_code=404, detail="credit order not found")
    await session.commit()
    return CreditEntryResponse(**cancelled)


@router.post("/credits/orders", status_code=201, response_model=CreditOrderResponse)
async def create_credit_order(
    body: CreateCreditOrderRequest,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
) -> CreditOrderResponse:
    package = get_credit_package(body.package_id)
    if package is None:
        raise HTTPException(status_code=404, detail="credit package not found")

    order_id = f"co_{uuid4().hex}"
    repo = CreditRepository(session, user_id=_user.id)
    entry = await repo.add_entry(
        amount=package["credits"],
        kind="purchase",
        status="pending",
        reference_type="credit_order",
        reference_id=order_id,
        description=f"Credit package {package['id']}",
        metadata={
            "package_id": package["id"],
            "credits": package["credits"],
            "currency": package["currency"],
            "price_minor": package["price_minor"],
            "payment_method": body.payment_method,
        },
        idempotency_key=body.idempotency_key,
    )
    payment_url = entry.get("metadata", {}).get("stripe_checkout_url") if entry.get("metadata") else None
    order_id = str(entry["reference_id"] or order_id)

    if body.payment_method == "stripe" and entry["status"] == "pending" and not payment_url:
        try:
            checkout_session = await create_checkout_session(
                order_id=order_id,
                user_id=_user.id,
                package=package,
                idempotency_key=f"checkout:{body.idempotency_key}" if body.idempotency_key else None,
            )
        except StripeConfigurationError as exc:
            await session.rollback()
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except httpx.HTTPStatusError as exc:
            await session.rollback()
            raise HTTPException(status_code=502, detail=f"Stripe Checkout failed: {exc.response.text}") from exc
        except httpx.HTTPError as exc:
            await session.rollback()
            raise HTTPException(status_code=502, detail=f"Stripe Checkout failed: {exc}") from exc

        payment_url = checkout_session.get("url")
        updated = await repo.update_status_by_reference(
            reference_type="credit_order",
            reference_id=order_id,
            status="pending",
            metadata={
                "stripe_checkout_session_id": checkout_session.get("id"),
                "stripe_checkout_url": payment_url,
            },
        )
        if updated is not None:
            entry = updated

    await session.commit()

    return CreditOrderResponse(
        order_id=order_id,
        status=str(entry["status"]),
        package=CreditPackageResponse(**package),
        payment_method=body.payment_method,
        payment_url=payment_url,
        ledger_entry=CreditEntryResponse(**entry),
    )


@router.post("/credits/orders/{order_id}/confirm", response_model=CreditEntryResponse)
async def confirm_credit_order(
    order_id: str,
    body: ConfirmCreditOrderRequest,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
) -> CreditEntryResponse:
    """Confirm a pending credit order. Payment webhooks should call this path internally."""
    if _user.role != "admin":
        raise HTTPException(status_code=403, detail="admin required")

    entry = await _post_pending_credit_order(
        order_id=order_id,
        user_id=body.user_id or _user.id,
        session=session,
        metadata={
            "confirmed_by": _user.id,
            **({"payment_reference": body.payment_reference} if body.payment_reference else {}),
        },
    )
    await session.commit()
    return CreditEntryResponse(**entry)


@router.post("/credits/orders/{order_id}/sandbox-confirm", response_model=CreditEntryResponse)
async def sandbox_confirm_credit_order(
    order_id: str,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
) -> CreditEntryResponse:
    """Post a pending credit order for local sandbox testing only."""
    if _user.role != "admin":
        raise HTTPException(status_code=403, detail="admin required")
    if not billing_sandbox_tools_enabled():
        raise HTTPException(status_code=403, detail="billing sandbox tools are disabled")

    entry = await _post_pending_credit_order(
        order_id=order_id,
        user_id=_user.id,
        session=session,
        metadata={
            "confirmed_by": "billing_sandbox_tools",
            "payment_reference": f"sandbox:{order_id}",
        },
    )
    await session.commit()
    return CreditEntryResponse(**entry)


@router.post("/stripe/webhook")
async def stripe_webhook(
    request: Request,
    session: AsyncSession = Depends(get_async_session),
    stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
) -> dict[str, Any]:
    payload = await request.body()
    try:
        event = parse_stripe_event(payload, stripe_signature)
    except StripeConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (StripeSignatureError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    event_type = event.get("type")
    if event_type not in {"checkout.session.completed", "checkout.session.async_payment_succeeded"}:
        return {"received": True, "ignored": True}

    checkout_session = (event.get("data") or {}).get("object") or {}
    if checkout_session.get("payment_status") != "paid":
        return {"received": True, "status": "not_paid"}

    metadata = checkout_session.get("metadata") or {}
    order_id = metadata.get("order_id") or checkout_session.get("client_reference_id")
    user_id = metadata.get("user_id")
    if not order_id or not user_id:
        raise HTTPException(status_code=400, detail="Stripe session missing order metadata")

    repo = CreditRepository(session, user_id=user_id)
    existing = await repo.get_by_reference("credit_order", str(order_id))
    if existing is None:
        raise HTTPException(status_code=404, detail="credit order not found")
    if (existing.get("metadata") or {}).get("payment_method") != "stripe":
        raise HTTPException(status_code=400, detail="credit order is not a Stripe order")

    entry = await _post_pending_credit_order(
        order_id=str(order_id),
        user_id=user_id,
        session=session,
        metadata={
            "confirmed_by": "stripe_webhook",
            "stripe_event_id": event.get("id"),
            "stripe_checkout_session_id": checkout_session.get("id"),
            "stripe_payment_intent": checkout_session.get("payment_intent"),
        },
    )
    await session.commit()
    return {"received": True, "status": entry["status"] if entry else "missing"}


@router.post("/credits/grant", status_code=201, response_model=CreditEntryResponse)
async def grant_credits(
    body: GrantCreditsRequest,
    _user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
) -> CreditEntryResponse:
    """Manually grant credits. This is the internal hook payment webhooks will reuse."""
    if _user.role != "admin":
        raise HTTPException(status_code=403, detail="admin required")

    target_user_id = body.user_id or _user.id
    if body.user_id and await UserRepository(session).get_by_id(body.user_id) is None:
        raise HTTPException(status_code=404, detail="user not found")

    repo = CreditRepository(session, user_id=target_user_id)
    entry = await repo.add_entry(
        amount=body.amount,
        kind="manual_grant",
        description=body.description,
        metadata={"granted_by": _user.id},
        idempotency_key=body.idempotency_key,
    )
    await session.commit()
    return CreditEntryResponse(**entry)
