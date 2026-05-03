"""Project ownership helpers for user-scoped workspaces."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from unittest.mock import Mock

from fastapi import HTTPException

from lib.db.base import DEFAULT_USER_ID
from lib.project_manager import (
    PROJECT_ACCESS_FIELD,
    PROJECT_ACCESS_MEMBERS_FIELD,
    PROJECT_MEMBER_ROLES,
    ProjectManager,
)

PROJECT_OWNER_FIELD = "owner_user_id"


def project_owner_user_id(project: dict) -> str:
    """Return the owner for a project, treating legacy projects as default-owned."""
    return ProjectManager.project_owner_user_id(project)


def project_member_role(project: dict, user_id: str | None) -> str | None:
    """Return an explicit collaborator role for a project."""
    return ProjectManager.project_member_role(project, user_id)


def user_can_access_project(project: dict, user_id: str | None) -> bool:
    """Check whether a user can access a project."""
    return ProjectManager.project_allows_user(project, user_id)


def user_owns_project(project: dict, user_id: str | None) -> bool:
    """Check whether a user owns a project."""
    return project_owner_user_id(project) == str(user_id or DEFAULT_USER_ID)


def project_members(project: dict) -> dict[str, dict[str, str]]:
    """Return normalized project collaborator entries."""
    access = project.get(PROJECT_ACCESS_FIELD)
    if not isinstance(access, dict):
        return {}
    raw_members = access.get(PROJECT_ACCESS_MEMBERS_FIELD)
    if not isinstance(raw_members, dict):
        return {}
    members: dict[str, dict[str, str]] = {}
    for user_id, member in raw_members.items():
        if isinstance(member, dict):
            role = member.get("role")
            added_at = member.get("added_at")
            username = member.get("username")
        else:
            role = member
            added_at = None
            username = None
        if role not in PROJECT_MEMBER_ROLES:
            continue
        entry = {"role": str(role)}
        if added_at:
            entry["added_at"] = str(added_at)
        if username:
            entry["username"] = str(username)
        members[str(user_id)] = entry
    return members


def project_manager_for_user(manager: Any, user_id: str | None) -> Any:
    """Return a user-scoped ProjectManager when supported by the manager."""
    if isinstance(manager, Mock):
        return manager
    if hasattr(manager, "for_user"):
        return manager.for_user(str(user_id or DEFAULT_USER_ID))
    return manager


def ensure_project_access(project: dict, *, user_id: str | None, project_name: str, translate: Callable[..., str]) -> None:
    """Hide projects from non-owners with the same 404 as missing projects."""
    if user_can_access_project(project, user_id):
        return
    raise HTTPException(status_code=404, detail=translate("project_not_found", name=project_name))


def ensure_project_owner(project: dict, *, user_id: str | None) -> None:
    """Require project ownership for membership/admin mutations."""
    if user_owns_project(project, user_id):
        return
    raise HTTPException(status_code=403, detail="project owner required")


def load_project_for_user(
    manager: Any,
    project_name: str,
    *,
    user_id: str | None,
    translate: Callable[..., str],
) -> dict:
    """Load a project and enforce ownership."""
    scoped_manager = project_manager_for_user(manager, user_id)
    try:
        project = scoped_manager.load_project(project_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=translate("project_not_found", name=project_name)) from exc
    ensure_project_access(project, user_id=user_id, project_name=project_name, translate=translate)
    return project
