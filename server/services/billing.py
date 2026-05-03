"""Billing helpers used by generation routes and usage settlement."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

from lib.credit_utils import cost_to_credits, minimum_generation_balance
from lib.db import async_session_factory
from lib.db.base import DEFAULT_USER_ID, PLATFORM_USER_ID
from lib.db.repositories.credit_repository import CreditRepository, InsufficientCreditsError

logger = logging.getLogger(__name__)


def is_platform_credits_project(project: dict[str, Any] | None) -> bool:
    return bool(project and project.get("billing_mode") == "platform_credits")


async def ensure_platform_credits_balance(
    project: dict[str, Any],
    user_id: str,
    *,
    required_credits: int | None = None,
) -> None:
    """Reject platform-credit generation if the user has insufficient spendable balance."""
    if not is_platform_credits_project(project):
        return

    required = max(minimum_generation_balance(), int(required_credits or 0))
    async with async_session_factory() as session:
        repo = CreditRepository(session, user_id=user_id)
        balance = await repo.get_available_balance()

    if balance < required:
        raise HTTPException(
            status_code=402,
            detail=f"积分余额不足，本次预计至少需要 {required} 积分才能使用平台生成。",
        )


async def reserve_platform_credits_for_task(
    project: dict[str, Any],
    user_id: str,
    *,
    task_id: str,
    required_credits: int,
    task_type: str,
    project_name: str,
) -> None:
    """Reserve estimated credits for an accepted queued task."""
    if not is_platform_credits_project(project):
        return
    required = max(minimum_generation_balance(), int(required_credits or 0))
    async with async_session_factory() as session:
        repo = CreditRepository(session, user_id=user_id)
        try:
            await repo.reserve_generation_credits(
                task_id=task_id,
                amount=required,
                description=f"{project_name} {task_type} reservation",
                metadata={
                    "project_name": project_name,
                    "task_type": task_type,
                    "estimated_credits": required,
                },
            )
        except InsufficientCreditsError as exc:
            raise HTTPException(
                status_code=402,
                detail=f"积分余额不足，本次预计至少需要 {required} 积分才能使用平台生成。",
            ) from exc
        await session.commit()


async def reserve_platform_credits_for_task_or_cancel(
    project: dict[str, Any],
    user_id: str,
    *,
    task_id: str,
    required_credits: int,
    task_type: str,
    project_name: str,
    queue: Any,
) -> None:
    """Reserve credits for an enqueued task, cancelling it if reservation loses a race."""
    try:
        await reserve_platform_credits_for_task(
            project,
            user_id,
            task_id=task_id,
            required_credits=required_credits,
            task_type=task_type,
            project_name=project_name,
        )
    except HTTPException:
        try:
            await queue.cancel_task(task_id, user_id=user_id)
        except Exception:
            logger.exception("积分冻结失败后取消任务失败 task_id=%s", task_id)
        raise


def _parse_backend(raw: Any) -> tuple[str | None, str | None]:
    if not isinstance(raw, str) or not raw.strip():
        return None, None
    if "/" in raw:
        provider, model = raw.split("/", 1)
        return provider or None, model or None
    return raw, None


def _credential_user_id(project: dict[str, Any], user_id: str) -> str:
    return PLATFORM_USER_ID if project.get("billing_mode") == "platform_credits" else user_id


async def _resolve_image_backend(
    project: dict[str, Any],
    payload: dict[str, Any],
    *,
    user_id: str,
) -> tuple[str, str | None]:
    provider = payload.get("image_provider")
    model = payload.get("image_model")
    if isinstance(provider, str) and provider:
        return provider, str(model) if model else None

    project_provider, project_model = _parse_backend(project.get("image_backend"))
    if project_provider and project_model:
        return project_provider, project_model

    from lib.config.resolver import ConfigResolver

    resolver = ConfigResolver(async_session_factory, user_id=_credential_user_id(project, user_id))
    try:
        async with resolver.session() as r:
            default_provider, default_model = await r.default_image_backend()
    except Exception:
        default_provider, default_model = "gemini-aistudio", None

    if project_provider:
        return project_provider, project_model or (default_model if project_provider == default_provider else None)
    return default_provider, default_model


async def _resolve_video_backend(
    project: dict[str, Any],
    payload: dict[str, Any],
    *,
    user_id: str,
    project_name: str | None,
) -> tuple[str, str | None, bool]:
    provider = payload.get("video_provider")
    model = payload.get("video_model") or payload.get("model")
    if isinstance(provider, str) and provider:
        return provider, str(model) if model else None, True

    project_provider, project_model = _parse_backend(project.get("video_backend"))
    if project_provider and project_model:
        generate_audio = project.get("video_generate_audio")
        return project_provider, project_model, generate_audio if isinstance(generate_audio, bool) else True

    from lib.config.resolver import ConfigResolver

    resolver = ConfigResolver(async_session_factory, user_id=_credential_user_id(project, user_id))
    try:
        async with resolver.session() as r:
            default_provider, default_model = await r.default_video_backend()
            generate_audio = await r.video_generate_audio_from_project(project)
    except Exception:
        default_provider, default_model, generate_audio = "gemini-aistudio", "veo-3.1-lite-generate-preview", True

    if project_provider:
        return project_provider, project_model or (default_model if project_provider == default_provider else None), generate_audio
    return default_provider, default_model, generate_audio


async def _custom_price_kwargs(provider: str, model: str | None, *, user_id: str) -> dict[str, Any]:
    from lib.custom_provider import is_custom_provider, parse_provider_id

    if not is_custom_provider(provider) or not model:
        return {}

    from lib.db.repositories.custom_provider_repo import CustomProviderRepository

    async with async_session_factory() as session:
        repo = CustomProviderRepository(session, user_id=user_id)
        price_model = await repo.get_model_by_ids(parse_provider_id(provider), model)
        if not price_model:
            return {}
        return {
            "custom_price_input": price_model.price_input,
            "custom_price_output": price_model.price_output,
            "custom_currency": price_model.currency,
        }


def _default_video_duration(provider: str, model: str | None) -> int:
    from lib.config.registry import PROVIDER_REGISTRY

    provider_meta = PROVIDER_REGISTRY.get(provider)
    if provider_meta and model:
        model_info = provider_meta.models.get(model)
        if model_info and model_info.supported_durations:
            return int(model_info.supported_durations[0])
    return 4


async def estimate_generation_task_credits(
    project: dict[str, Any],
    task_type: str,
    payload: dict[str, Any] | None = None,
    *,
    user_id: str = DEFAULT_USER_ID,
    project_name: str | None = None,
) -> int:
    """Estimate the minimum credits needed before accepting a generation task."""
    if not is_platform_credits_project(project):
        return 0

    payload = payload or {}
    try:
        from lib.cost_calculator import cost_calculator
        from lib.default_duration import normalize_project_default_duration
        from server.services.resolution_resolver import get_provider_fallback, resolve_resolution

        if task_type in {"storyboard", "character", "scene", "prop", "grid"}:
            provider, model = await _resolve_image_backend(project, payload, user_id=user_id)
            resolution = await resolve_resolution(project, provider, model or "")
            if not resolution:
                resolution = "2K" if task_type == "grid" else "1K"
            amount, currency = cost_calculator.calculate_cost(
                provider=provider,
                call_type="image",
                model=model,
                resolution=resolution,
                **await _custom_price_kwargs(provider, model, user_id=_credential_user_id(project, user_id)),
            )
            return max(minimum_generation_balance(), cost_to_credits(amount, currency))

        if task_type in {"video", "reference_video"}:
            provider, model, generate_audio = await _resolve_video_backend(
                project,
                payload,
                user_id=user_id,
                project_name=project_name,
            )
            resolution = await resolve_resolution(project, provider, model or "") or get_provider_fallback(provider)
            raw_duration = payload.get("duration_seconds")
            duration = int(raw_duration) if isinstance(raw_duration, (int, float, str)) and str(raw_duration).strip() else 0
            duration = duration or normalize_project_default_duration(project) or _default_video_duration(provider, model)
            amount, currency = cost_calculator.estimate_reference_video_cost(
                unit_durations_seconds=[duration],
                provider=provider,
                model=model,
                resolution=resolution,
                generate_audio=generate_audio,
            )
            return max(minimum_generation_balance(), cost_to_credits(amount, currency))
    except Exception:
        logger.exception("平台积分预估失败，回退到最低余额检查 task_type=%s", task_type)

    return minimum_generation_balance()


async def debit_platform_credits_for_api_call(
    *,
    user_id: str,
    api_call_id: int,
    project_name: str,
    provider: str | None,
    call_type: str | None,
    model: str | None,
    cost_amount: float,
    currency: str | None,
    session,
) -> int:
    """Debit credits for one successful API call. Returns debited credits."""
    credits = cost_to_credits(cost_amount, currency)
    if credits <= 0:
        return 0

    repo = CreditRepository(session, user_id=user_id)
    await repo.add_entry(
        amount=-credits,
        kind="generation_usage",
        reference_type="api_call",
        reference_id=str(api_call_id),
        description=f"{project_name} {call_type or 'generation'}",
        metadata={
            "project_name": project_name,
            "provider": provider,
            "call_type": call_type,
            "model": model,
            "cost_amount": cost_amount,
            "currency": currency,
        },
        idempotency_key=f"api-call:{api_call_id}",
        allow_negative_balance=True,
    )
    return credits
