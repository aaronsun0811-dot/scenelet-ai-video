"""SDK PreToolUse / PostToolUse hooks for agent sessions.

Extracted from ``session_manager.py``. These hooks have no dependency on
:class:`SessionManager` state — they're factories that close over the
session's working directory and a shared backup dict.

The main ``SessionManager`` class re-binds them as ``staticmethod`` attributes
so existing access patterns (``manager._keep_stream_open_hook``,
``manager._build_json_validation_hook(cwd, backups)``) keep working unchanged.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


async def keep_stream_open_hook(
    _input_data: dict[str, Any], _tool_use_id: str | None, _context: Any
) -> dict[str, bool]:
    """Required keep-alive hook for Python ``can_use_tool`` callback."""
    return {"continue_": True}


def build_json_validation_hook(
    project_cwd: Path,
    json_backups: dict[str, tuple[Path, str]] | None = None,
) -> Callable[..., Any]:
    """Build a PreToolUse hook that blocks Write/Edit when the result would
    produce invalid JSON.

    For Edit: reads the current file, simulates the string replacement, and
    validates the result with ``json.loads()``.
    For Write: validates the ``content`` parameter directly.

    When *json_backups* is provided, the hook saves the current file
    content before the edit so the PostToolUse hook can restore it if
    the actual result turns out to be invalid.

    Returns ``permissionDecision: "deny"`` to block the operation before it
    executes, giving the agent a chance to fix its input and retry.
    """

    async def _json_validation_hook(
        input_data: dict[str, Any],
        _tool_use_id: str | None,
        _context: Any,
    ) -> dict[str, Any]:
        tool_name = input_data.get("tool_name", "")
        tool_input = input_data.get("tool_input", {})

        file_path = tool_input.get("file_path", "")
        if not file_path or not file_path.endswith(".json"):
            return {}

        # --- Reject curly/smart quotes that would corrupt JSON ---
        _CURLY_QUOTES = "“”„‟"  # ""„‟

        def _has_curly_quotes(text: str) -> bool:
            """Return True if *text* contains Unicode curly/smart quotes."""
            return any(ch in _CURLY_QUOTES for ch in text)

        # --- Simulate the result without touching the file ---
        simulated: str | None = None

        if tool_name == "Write":
            simulated = tool_input.get("content")
            logger.info(
                "JSON 校验 hook: tool=Write file=%s content_len=%s",
                file_path,
                len(simulated) if simulated else 0,
            )
        elif tool_name == "Edit":
            old_string = tool_input.get("old_string", "")
            new_string = tool_input.get("new_string", "")
            if not old_string:
                logger.info(
                    "JSON 校验 hook: tool=Edit file=%s skip=old_string为空",
                    file_path,
                )
                return {}

            # Detect curly quotes early — Claude Code may normalise
            # old_string internally (allowing the edit to succeed) while
            # the hook's exact-match ``old_string not in current`` check
            # below would skip validation, letting curly quotes slip into
            # the file and corrupt JSON.
            if _has_curly_quotes(new_string):
                curly_found = [f"U+{ord(ch):04X}" for ch in new_string if ch in _CURLY_QUOTES]
                logger.warning(
                    "PreToolUse JSON 校验拦截(弯引号): file=%s curly=%s",
                    file_path,
                    curly_found[:5],
                )
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": (
                            "操作被阻止：new_string 包含弯引号"
                            "（“ 或 ”），"
                            "这会破坏 JSON 格式。"
                            "请将所有弯引号替换为标准 ASCII "
                            "双引号 (U+0022) 后重试。"
                        ),
                    },
                }

            p = Path(file_path)
            resolved = (project_cwd / p).resolve() if not p.is_absolute() else p.resolve()
            try:
                current = resolved.read_text(encoding="utf-8")
            except OSError as read_err:
                logger.info(
                    "JSON 校验 hook: tool=Edit file=%s skip=读取失败 error=%s",
                    file_path,
                    read_err,
                )
                return {}

            # Save backup for PostToolUse restore on corruption
            if json_backups is not None and _tool_use_id:
                json_backups[_tool_use_id] = (resolved, current)

            if old_string not in current:
                # Edit tool will fail on its own; no need to intervene.
                logger.info(
                    "JSON 校验 hook: tool=Edit file=%s skip=old_string未匹配 old_len=%d new_len=%d file_len=%d",
                    file_path,
                    len(old_string),
                    len(new_string),
                    len(current),
                )
                return {}

            replace_all = tool_input.get("replace_all", False)
            if replace_all:
                simulated = current.replace(old_string, new_string)
            else:
                simulated = current.replace(old_string, new_string, 1)

            logger.info(
                "JSON 校验 hook: tool=Edit file=%s matched=True "
                "old_len=%d new_len=%d simulated_len=%d replace_all=%s",
                file_path,
                len(old_string),
                len(new_string),
                len(simulated),
                replace_all,
            )

        if simulated is None:
            return {}

        try:
            json.loads(simulated)
            logger.info(
                "JSON 校验 hook: tool=%s file=%s result=valid",
                tool_name,
                file_path,
            )
            return {}
        except json.JSONDecodeError as exc:
            logger.warning(
                "PreToolUse JSON 校验拦截: file=%s tool=%s error=%s",
                file_path,
                tool_name,
                exc,
            )
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        f"操作被阻止：此次 {tool_name} 会导致 {file_path} "
                        f"变成无效 JSON。错误：{exc}。"
                        "请检查你的输入内容中是否包含未转义的双引号或其他"
                        "JSON 语法问题，修正后重试。"
                    ),
                },
            }

    return _json_validation_hook


def build_json_post_validation_hook(
    project_cwd: Path,
    json_backups: dict[str, tuple[Path, str]],
) -> Callable[..., Any]:
    """Build a PostToolUse hook that validates JSON files after Write/Edit.

    This is a safety net for cases where the PreToolUse simulation fails
    to catch invalid edits (e.g. due to old_string mismatch or escaping
    differences between the hook simulation and the actual Edit tool).

    If the file is invalid JSON after the edit, the hook:
    1. Restores the file from the backup saved by the PreToolUse hook
    2. Returns ``additionalContext`` telling the agent what went wrong
    """

    async def _json_post_validation_hook(
        input_data: dict[str, Any],
        tool_use_id: str | None,
        _context: Any,
    ) -> dict[str, Any]:
        # Top-level guard: unhandled exceptions in hooks interrupt the
        # agent (per SDK docs), so we catch everything and log.
        try:
            return await _json_post_validation_impl(
                input_data,
                tool_use_id,
            )
        except Exception:
            logger.exception("PostToolUse JSON 校验 hook 异常")
            return {}

    async def _json_post_validation_impl(
        input_data: dict[str, Any],
        tool_use_id: str | None,
    ) -> dict[str, Any]:
        tool_name = input_data.get("tool_name", "")
        tool_input = input_data.get("tool_input", {})

        file_path = tool_input.get("file_path", "")
        if not file_path or not file_path.endswith(".json"):
            return {}

        # Pop the backup regardless of outcome to avoid memory leaks
        backup = json_backups.pop(tool_use_id, None) if tool_use_id else None

        p = Path(file_path)
        resolved = (project_cwd / p).resolve() if not p.is_absolute() else p.resolve()

        try:
            actual = resolved.read_text(encoding="utf-8")
        except OSError:
            return {}

        try:
            json.loads(actual)
            logger.info(
                "PostToolUse JSON 校验: tool=%s file=%s result=valid",
                tool_name,
                file_path,
            )
            return {}
        except json.JSONDecodeError as exc:
            # File is corrupt — restore from backup if available
            restored = False
            if backup:
                backup_path, backup_content = backup
                try:
                    backup_path.write_text(backup_content, encoding="utf-8")
                    restored = True
                    logger.warning(
                        "PostToolUse JSON 校验拦截并恢复: file=%s tool=%s error=%s backup_restored=True",
                        file_path,
                        tool_name,
                        exc,
                    )
                except OSError as write_err:
                    logger.error(
                        "PostToolUse JSON 备份恢复失败: file=%s error=%s",
                        file_path,
                        write_err,
                    )
            else:
                logger.warning(
                    "PostToolUse JSON 校验拦截(无备份): file=%s tool=%s error=%s",
                    file_path,
                    tool_name,
                    exc,
                )

            if restored:
                ctx = (
                    f"⚠ JSON 损坏已检测并回滚：{tool_name} 导致 "
                    f"{file_path} 变成无效 JSON（{exc}）。"
                    "文件已恢复到编辑前状态，请修正后重试。"
                )
            else:
                ctx = (
                    f"⚠ JSON 损坏已检测但无法恢复：{tool_name} 导致 "
                    f"{file_path} 变成无效 JSON（{exc}）。"
                    "文件当前仍为损坏状态（无可用备份或恢复写入失败），"
                    "请先读取文件确认内容，再手动修正为合法 JSON。"
                )

            return {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": ctx,
                },
            }

    return _json_post_validation_hook


__all__ = [
    "build_json_post_validation_hook",
    "build_json_validation_hook",
    "keep_stream_open_hook",
]
