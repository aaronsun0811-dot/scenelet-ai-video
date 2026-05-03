"""Stripe Checkout helpers for credit purchases."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any
from urllib.parse import urlencode

import httpx


class StripeConfigurationError(RuntimeError):
    """Stripe is requested but required environment variables are missing."""


class StripeSignatureError(ValueError):
    """Webhook signature verification failed."""


def billing_sandbox_tools_enabled() -> bool:
    return os.getenv("BILLING_SANDBOX_TOOLS", "").strip().lower() in {"1", "true", "yes", "on"}


def stripe_secret_key() -> str:
    key = os.getenv("STRIPE_SECRET_KEY", "").strip()
    if not key:
        raise StripeConfigurationError("STRIPE_SECRET_KEY is not configured")
    return key


def stripe_webhook_secret() -> str:
    secret = os.getenv("STRIPE_WEBHOOK_SECRET", "").strip()
    if not secret:
        raise StripeConfigurationError("STRIPE_WEBHOOK_SECRET is not configured")
    return secret


def stripe_configuration_status() -> dict[str, Any]:
    missing = [
        name
        for name in ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET")
        if not os.getenv(name, "").strip()
    ]
    secret_key = os.getenv("STRIPE_SECRET_KEY", "").strip()
    if secret_key.startswith("sk_test_"):
        mode = "test"
    elif secret_key.startswith("sk_live_"):
        mode = "live"
    else:
        mode = "unknown"
    return {
        "configured": not missing,
        "missing": missing,
        "mode": mode,
        "sandbox_tools_enabled": billing_sandbox_tools_enabled(),
        "frontend_base_url": _frontend_base_url(),
        "webhook_path": "/api/v1/billing/stripe/webhook",
    }


def _frontend_base_url() -> str:
    return (
        os.getenv("STRIPE_FRONTEND_BASE_URL")
        or os.getenv("PUBLIC_APP_URL")
        or os.getenv("APP_BASE_URL")
        or "http://localhost:5173"
    ).rstrip("/")


def stripe_success_url(order_id: str) -> str:
    return os.getenv("STRIPE_SUCCESS_URL", f"{_frontend_base_url()}/app/projects?checkout=success&order_id={order_id}")


def stripe_cancel_url(order_id: str) -> str:
    return os.getenv("STRIPE_CANCEL_URL", f"{_frontend_base_url()}/app/projects?checkout=cancel&order_id={order_id}")


async def create_checkout_session(
    *,
    order_id: str,
    user_id: str,
    package: dict[str, Any],
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Create a Stripe-hosted Checkout Session for a credit package."""
    secret_key = stripe_secret_key()
    api_base = os.getenv("STRIPE_API_BASE", "https://api.stripe.com").rstrip("/")
    metadata = {
        "order_id": order_id,
        "user_id": user_id,
        "package_id": str(package["id"]),
        "credits": str(package["credits"]),
    }
    form_items: list[tuple[str, str]] = [
        ("mode", "payment"),
        ("success_url", stripe_success_url(order_id)),
        ("cancel_url", stripe_cancel_url(order_id)),
        ("client_reference_id", order_id),
        ("metadata[order_id]", order_id),
        ("metadata[user_id]", user_id),
        ("metadata[package_id]", str(package["id"])),
        ("metadata[credits]", str(package["credits"])),
        ("payment_intent_data[metadata][order_id]", order_id),
        ("payment_intent_data[metadata][user_id]", user_id),
        ("payment_intent_data[metadata][package_id]", str(package["id"])),
        ("line_items[0][quantity]", "1"),
        ("line_items[0][price_data][currency]", str(package["currency"]).lower()),
        ("line_items[0][price_data][unit_amount]", str(package["price_minor"])),
        ("line_items[0][price_data][product_data][name]", f"Scenelet {package['credits']} credits"),
    ]
    if package.get("description"):
        form_items.append(("line_items[0][price_data][product_data][description]", str(package["description"])))

    headers = {
        "Authorization": f"Bearer {secret_key}",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    headers["Idempotency-Key"] = idempotency_key or f"checkout:{order_id}"

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            f"{api_base}/v1/checkout/sessions",
            headers=headers,
            content=urlencode(form_items),
        )
    response.raise_for_status()
    data = response.json()
    return {
        "id": data.get("id"),
        "url": data.get("url"),
        "metadata": metadata,
    }


def parse_stripe_event(payload: bytes, signature_header: str | None, *, tolerance_seconds: int = 300) -> dict[str, Any]:
    """Verify and parse a Stripe webhook event payload."""
    if not signature_header:
        raise StripeSignatureError("missing Stripe-Signature header")

    timestamp: str | None = None
    signatures: list[str] = []
    for part in signature_header.split(","):
        key, _, value = part.partition("=")
        if key == "t":
            timestamp = value
        elif key == "v1":
            signatures.append(value)

    if not timestamp or not signatures:
        raise StripeSignatureError("invalid Stripe-Signature header")

    try:
        ts_int = int(timestamp)
    except ValueError as exc:
        raise StripeSignatureError("invalid Stripe-Signature timestamp") from exc

    if tolerance_seconds > 0 and abs(time.time() - ts_int) > tolerance_seconds:
        raise StripeSignatureError("Stripe-Signature timestamp outside tolerance")

    signed_payload = f"{timestamp}.{payload.decode('utf-8')}".encode()
    expected = hmac.new(
        stripe_webhook_secret().encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()
    if not any(hmac.compare_digest(expected, sig) for sig in signatures):
        raise StripeSignatureError("Stripe-Signature mismatch")

    return json.loads(payload.decode("utf-8"))
