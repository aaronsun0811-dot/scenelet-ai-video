"""Helpers for project-level default video duration."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def normalize_project_default_duration(project: Mapping[str, Any] | None) -> int | None:
    """Return the user-explicit project duration, treating legacy implicit values as auto."""
    if not project:
        return None

    raw = project.get("default_duration")
    if raw is None or isinstance(raw, bool):
        return None

    if isinstance(raw, int):
        duration = raw
    elif isinstance(raw, str) and raw.strip().isdigit():
        duration = int(raw.strip())
    else:
        return None

    if project.get("default_duration_explicit") is True:
        return duration

    implicit_default = {
        "narration": 4,
        "drama": 8,
    }.get(project.get("content_mode"))
    if implicit_default is not None and duration == implicit_default:
        return None
    return duration
