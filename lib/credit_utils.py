"""Credit conversion helpers for platform billing."""

from __future__ import annotations

import math
import os


def _read_rate(env_name: str, default: int) -> int:
    raw = os.environ.get(env_name)
    if raw is None:
        return default
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return default


def credits_per_currency(currency: str | None) -> int:
    """Return credits charged per 1 currency unit.

    Defaults:
    - 1000 credits = 1 USD
    - 140 credits = 1 CNY (roughly 1000 / 7.1)
    """
    normalized = (currency or "USD").upper()
    if normalized == "CNY":
        return _read_rate("PLATFORM_CREDITS_PER_CNY", 140)
    return _read_rate("PLATFORM_CREDITS_PER_USD", 1000)


def cost_to_credits(amount: float, currency: str | None) -> int:
    """Convert a positive cost amount to an integer credit debit."""
    if amount <= 0:
        return 0
    return max(1, math.ceil(amount * credits_per_currency(currency)))


def minimum_generation_balance() -> int:
    """Minimum balance required to submit a platform-credit generation task."""
    return _read_rate("PLATFORM_MIN_GENERATION_CREDITS", 1)
