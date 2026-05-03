"""Credit package catalog for platform billing."""

from __future__ import annotations

import json
import os
from typing import Any

DEFAULT_CREDIT_PACKAGES: tuple[dict[str, Any], ...] = (
    {
        "id": "starter",
        "credits": 1000,
        "currency": "CNY",
        "price_minor": 990,
        "description": "Light testing and short drafts",
    },
    {
        "id": "creator",
        "credits": 3000,
        "currency": "CNY",
        "price_minor": 2900,
        "description": "Small batches of drama and skit generation",
    },
    {
        "id": "studio",
        "credits": 10000,
        "currency": "CNY",
        "price_minor": 8800,
        "description": "Ongoing production and team usage",
    },
)


def _normalize_package(raw: dict[str, Any]) -> dict[str, Any]:
    package_id = str(raw["id"]).strip()
    credits = int(raw["credits"])
    price_minor = int(raw["price_minor"])
    currency = str(raw.get("currency") or "CNY").upper()
    if not package_id:
        raise ValueError("credit package id is required")
    if credits <= 0:
        raise ValueError("credit package credits must be positive")
    if price_minor <= 0:
        raise ValueError("credit package price_minor must be positive")
    return {
        "id": package_id,
        "credits": credits,
        "currency": currency,
        "price_minor": price_minor,
        "description": str(raw["description"]) if raw.get("description") else None,
    }


def list_credit_packages() -> list[dict[str, Any]]:
    """Return configured public credit packages.

    Override with PLATFORM_CREDIT_PACKAGES_JSON:
    [{"id":"starter","credits":1000,"currency":"CNY","price_minor":990}]
    """
    raw = os.getenv("PLATFORM_CREDIT_PACKAGES_JSON")
    source: Any = DEFAULT_CREDIT_PACKAGES
    if raw:
        source = json.loads(raw)
        if not isinstance(source, list):
            raise ValueError("PLATFORM_CREDIT_PACKAGES_JSON must be a JSON array")
    return [_normalize_package(dict(item)) for item in source]


def get_credit_package(package_id: str) -> dict[str, Any] | None:
    for package in list_credit_packages():
        if package["id"] == package_id:
            return package
    return None
