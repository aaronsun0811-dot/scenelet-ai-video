"""File-access guard rails for agent sessions.

Extracted from ``session_manager.py``. Three layers:

1. **Constants** — which tools touch paths, which can write, which file
   extensions Write/Edit accept.
2. **Pure check** — :func:`is_path_allowed` decides if a path is legal for
   a given tool, against a project cwd and shared project root.
3. **Hook factory** — :func:`build_file_access_hook` returns the SDK
   PreToolUse callback that wraps the check.

The main :class:`SessionManager` re-exposes the constants and helpers as
class attributes so existing call sites (and tests that monkeypatch
``SessionManager._CLAUDE_PROJECTS_DIR``) keep working unchanged.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

# Tools that take a path argument, mapped to the input key holding that
# path. PreToolUse hook only intercepts these — everything else is
# resolved by allowed_tools / settings.json.
PATH_TOOLS: dict[str, str] = {
    "Read": "file_path",
    "Write": "file_path",
    "Edit": "file_path",
    "Glob": "path",
    "Grep": "path",
}
WRITE_TOOLS: frozenset[str] = frozenset({"Write", "Edit"})
WRITABLE_EXTENSIONS: frozenset[str] = frozenset({".json", ".md", ".txt"})

# Base directory where the SDK stores per-project session data.
CLAUDE_PROJECTS_DIR: Path = Path.home() / ".claude" / "projects"


def encode_sdk_project_path(project_cwd: Path) -> str:
    """Encode a project cwd the same way the SDK does for session storage.

    Replaces ``/`` and ``.`` with ``-`` — matches transcript_reader.py
    and the SDK's own encoding.
    """
    return project_cwd.as_posix().replace("/", "-").replace(".", "-")


def is_path_allowed(
    file_path: str,
    tool_name: str,
    project_cwd: Path,
    project_root: Path,
    claude_projects_dir: Path = CLAUDE_PROJECTS_DIR,
) -> tuple[bool, str | None]:
    """Decide whether *file_path* is reachable for *tool_name*.

    Write tools: only ``project_cwd``, restricted to
    :data:`WRITABLE_EXTENSIONS`.
    Read tools: ``project_cwd`` + ``project_root`` + SDK session
    tool-results dir for this project + SDK task output files.
    Sensitive files protected by settings.json deny rules.

    Returns ``(allowed, deny_reason)`` — ``deny_reason`` is a
    human-readable message when ``allowed`` is ``False``.
    """
    try:
        p = Path(file_path)
        resolved = (project_cwd / p).resolve() if not p.is_absolute() else p.resolve()
    except (ValueError, OSError):
        return False, "访问被拒绝：无效的文件路径"

    # 1. Within project directory
    if resolved.is_relative_to(project_cwd):
        if tool_name in WRITE_TOOLS:
            ext = resolved.suffix.lower()
            if ext not in WRITABLE_EXTENSIONS:
                return False, (
                    f"不允许创建/编辑 {ext} 类型的文件。"
                    "Write/Edit 仅限 .json、.md、.txt 文件。"
                    "如果你需要执行数据处理，请使用现有的 skill 脚本。"
                )
        return True, None

    # 2. Write tools: only project directory allowed
    if tool_name in WRITE_TOOLS:
        return False, "访问被拒绝：不允许访问当前项目目录之外的路径"

    # 3. Read tools: allow entire project_root for shared resources
    #    Sensitive files protected by settings.json deny rules
    if resolved.is_relative_to(project_root):
        return True, None

    # 4. Read tools: allow SDK tool-results for THIS project only.
    #    When tool output exceeds the inline limit, the SDK saves the
    #    full result to ~/.claude/projects/{encoded-cwd}/{session}/
    #    tool-results/{id}.txt and instructs the agent to Read it.
    #    Only tool-results/ subdirectories are allowed — other SDK
    #    session data (transcripts, etc.) remains inaccessible.
    encoded = encode_sdk_project_path(project_cwd)
    sdk_project_dir = claude_projects_dir / encoded
    if resolved.is_relative_to(sdk_project_dir) and "tool-results" in resolved.parts:
        return True, None

    # 5. Read tools: allow SDK task output files.
    #    Background tasks (Agent/Bash run_in_background) write their
    #    output to /tmp/claude-{N}/{encoded-cwd}/tasks/{id}.output.
    #    The SDK instructs the agent to Read the file after the task
    #    completes.  Only the tasks/ subdirectory is allowed.
    #    macOS: /tmp → /private/tmp symlink, so check both prefixes.
    _SDK_TMP_PREFIXES = ("/tmp/claude-", "/private/tmp/claude-")
    resolved_str = str(resolved)
    if resolved_str.startswith(_SDK_TMP_PREFIXES) and "tasks" in resolved.parts:
        return True, None

    return False, "访问被拒绝：不允许访问当前项目和公共目录之外的路径"


def build_file_access_hook(
    project_cwd: Path,
    is_path_allowed_fn: Callable[[str, str, Path], tuple[bool, str | None]],
) -> Callable[..., Any]:
    """Build a PreToolUse hook that enforces file access control.

    PreToolUse hooks are step 1 in the SDK permission chain and fire for
    **every** tool call, including Read/Glob/Grep which would otherwise
    be auto-approved by allow rules at step 4.

    *is_path_allowed_fn* is a late-bound callback (not the bare module
    function) so tests can monkeypatch class-level configuration like
    ``SessionManager._CLAUDE_PROJECTS_DIR`` and still see the change
    reflected inside the hook closure.
    """

    async def _file_access_hook(
        input_data: dict[str, Any],
        _tool_use_id: str | None,
        _context: Any,
    ) -> dict[str, Any]:
        tool_name = input_data.get("tool_name", "")
        if tool_name not in PATH_TOOLS:
            return {"continue_": True}

        tool_input = input_data.get("tool_input", {})
        path_key = PATH_TOOLS[tool_name]
        file_path = tool_input.get(path_key)

        if file_path:
            allowed, deny_reason = is_path_allowed_fn(
                file_path,
                tool_name,
                project_cwd,
            )
            if not allowed:
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": deny_reason,
                    },
                }

        return {"continue_": True}

    return _file_access_hook


__all__ = [
    "CLAUDE_PROJECTS_DIR",
    "PATH_TOOLS",
    "WRITABLE_EXTENSIONS",
    "WRITE_TOOLS",
    "build_file_access_hook",
    "encode_sdk_project_path",
    "is_path_allowed",
]
