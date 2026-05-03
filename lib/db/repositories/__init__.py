"""Repository exports."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from lib.db.repositories.api_key_repository import ApiKeyRepository
    from lib.db.repositories.credit_repository import CreditRepository
    from lib.db.repositories.session_repo import SessionRepository
    from lib.db.repositories.task_repo import TaskRepository
    from lib.db.repositories.usage_repo import UsageRepository
    from lib.db.repositories.user_repository import UserRepository

__all__ = [
    "SessionRepository",
    "TaskRepository",
    "UsageRepository",
    "ApiKeyRepository",
    "CreditRepository",
    "UserRepository",
]

_EXPORTS = {
    "SessionRepository": ("lib.db.repositories.session_repo", "SessionRepository"),
    "TaskRepository": ("lib.db.repositories.task_repo", "TaskRepository"),
    "UsageRepository": ("lib.db.repositories.usage_repo", "UsageRepository"),
    "ApiKeyRepository": ("lib.db.repositories.api_key_repository", "ApiKeyRepository"),
    "CreditRepository": ("lib.db.repositories.credit_repository", "CreditRepository"),
    "UserRepository": ("lib.db.repositories.user_repository", "UserRepository"),
}


def __getattr__(name: str):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    from importlib import import_module

    module_name, attr_name = _EXPORTS[name]
    attr = getattr(import_module(module_name), attr_name)
    globals()[name] = attr
    return attr
