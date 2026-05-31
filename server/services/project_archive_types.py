"""Data classes and exceptions for the project archive service.

Extracted from ``project_archive.py`` so the main module stops being a god file.
Re-exported from there for backwards compatibility — external code (routers,
tests) can import from either location.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass, field
from typing import Any

from lib.data_validator import ValidationResult


@dataclass(frozen=True)
class ArchiveMember:
    info: zipfile.ZipInfo
    parts: tuple[str, ...]
    is_dir: bool


@dataclass(frozen=True)
class ArchiveDiagnostic:
    code: str
    message: str
    location: str | None = None

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "code": self.code,
            "message": self.message,
        }
        if self.location:
            payload["location"] = self.location
        return payload


@dataclass
class ArchiveDiagnostics:
    blocking: list[ArchiveDiagnostic] = field(default_factory=list)
    auto_fixed: list[ArchiveDiagnostic] = field(default_factory=list)
    warnings: list[ArchiveDiagnostic] = field(default_factory=list)
    _seen: set[tuple[str, str, str, str | None]] = field(
        default_factory=set,
        init=False,
        repr=False,
    )

    def add(
        self,
        bucket: str,
        code: str,
        message: str,
        *,
        location: str | None = None,
    ) -> None:
        key = (bucket, code, message, location)
        if key in self._seen:
            return
        self._seen.add(key)
        getattr(self, bucket).append(
            ArchiveDiagnostic(
                code=code,
                message=message,
                location=location,
            )
        )

    def extend_validation(self, validation: ValidationResult) -> None:
        for error in validation.errors:
            self.add("blocking", "validation_error", error)
        for warning in validation.warnings:
            self.add("warnings", "validation_warning", warning)

    def to_export_payload(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "blocking": [item.to_payload() for item in self.blocking],
            "auto_fixed": [item.to_payload() for item in self.auto_fixed],
            "warnings": [item.to_payload() for item in self.warnings],
        }

    def to_import_success_payload(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "auto_fixed": [item.to_payload() for item in self.auto_fixed],
            "warnings": [item.to_payload() for item in self.warnings],
        }

    def to_import_error_payload(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "blocking": [item.to_payload() for item in self.blocking],
            "auto_fixable": [item.to_payload() for item in self.auto_fixed],
            "warnings": [item.to_payload() for item in self.warnings],
        }

    def blocking_messages(self) -> list[str]:
        return [item.message for item in self.blocking]

    def warning_messages(self) -> list[str]:
        return [item.message for item in self.warnings]


@dataclass(frozen=True)
class ProjectImportResult:
    project_name: str
    project: dict[str, Any]
    warnings: list[str]
    conflict_resolution: str
    diagnostics: dict[str, list[dict[str, Any]]]


class ProjectArchiveValidationError(ValueError):
    def __init__(
        self,
        detail: str,
        *,
        status_code: int = 400,
        errors: list[str] | None = None,
        warnings: list[str] | None = None,
        diagnostics: dict[str, Any] | None = None,
        extra: dict[str, Any] | None = None,
    ):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code
        self.errors = errors or []
        self.warnings = warnings or []
        merged_extra = dict(extra or {})
        if diagnostics is not None:
            merged_extra["diagnostics"] = diagnostics
        self.extra = merged_extra


__all__ = [
    "ArchiveDiagnostic",
    "ArchiveDiagnostics",
    "ArchiveMember",
    "ProjectArchiveValidationError",
    "ProjectImportResult",
]
