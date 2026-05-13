"""SDK ``can_use_tool`` permission callback (step 5 of the SDK permission chain).

Extracted from ``session_manager.py``. The callback is the final fallback
after Hooks → Deny rules → Permission mode → Allow rules. It handles
``AskUserQuestion`` (async user interaction) and denies everything else
as a whitelist fallback.

SDK ``PermissionResultAllow`` / ``PermissionResultDeny`` types are passed
in by the caller rather than imported here, so tests that monkeypatch
``session_manager.PermissionResultAllow`` still see their fakes inside
the callback closure.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

# ManagedSession is only referenced for typing; avoid an import cycle.
ManagedSessionT = Any


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def handle_ask_user_question(
    managed: ManagedSessionT | None,
    tool_name: str,
    input_data: dict[str, Any],
    *,
    permission_result_allow: Any,
    permission_result_deny: Any,
) -> Any:
    """Handle ``AskUserQuestion`` tool invocation.

    If no session is bound, fall back to allowing the call so the SDK
    can decide. Otherwise, register the question on the session, wait
    for the user's answers, and return them merged into ``input_data``.

    Cancelling the answer future (e.g. ``managed.cancel_pending_questions``)
    raises an exception which becomes a ``PermissionResultDeny`` with
    ``interrupt=True``.
    """
    if managed is None:
        return permission_result_allow(updated_input=input_data)

    raw_questions = input_data.get("questions")
    questions = raw_questions if isinstance(raw_questions, list) else []
    payload = {
        "type": "ask_user_question",
        "question_id": f"aq_{uuid4().hex}",
        "tool_name": tool_name,
        "questions": questions,
        "timestamp": _utc_now_iso(),
    }
    pending = managed.add_pending_question(payload)
    managed.add_message(payload)

    try:
        answers = await pending.answer_future
    except Exception as exc:
        if permission_result_deny is not None:
            return permission_result_deny(
                message=str(exc) or "session interrupted by user",
                interrupt=True,
            )
        raise
    merged_input = dict(input_data or {})
    merged_input["answers"] = answers
    return permission_result_allow(updated_input=merged_input)


def build_can_use_tool_callback(
    session_id: str,
    sessions: dict[str, ManagedSessionT],
    handle_ask_user_question_fn: Callable[..., Any],
    *,
    permission_result_allow: Any,
    permission_result_deny: Any,
    managed_ref: list[ManagedSessionT | None] | None = None,
) -> Callable[..., Any]:
    """Build the SDK ``can_use_tool`` callback for a session.

    Whitelist fallback: deny any tool that was not pre-approved by
    ``allowed_tools`` or ``settings.json`` allow rules, except
    ``AskUserQuestion`` which is dispatched to *handle_ask_user_question_fn*.

    Args:
        session_id: Initial session ID (may be a temp_id for new sessions).
        sessions: Live session registry — only used as the lookup fallback
            when *managed_ref* is not provided.
        handle_ask_user_question_fn: Coroutine that handles the
            ``AskUserQuestion`` case. Must accept ``(managed, tool_name,
            input_data)``.
        permission_result_allow / permission_result_deny: SDK permission
            result types. Passed in so the caller controls patching.
        managed_ref: Mutable single-element list holding the active
            ``ManagedSession``. When provided, the callback resolves the
            session via this reference instead of looking up *session_id*
            in *sessions*, surviving the temp_id → sdk_id key swap.
    """
    if permission_result_allow is None:
        raise RuntimeError("claude_agent_sdk is not installed")

    async def _can_use_tool(
        tool_name: str,
        input_data: dict[str, Any],
        _context: Any,
    ) -> Any:
        normalized_tool = str(tool_name or "").strip().lower()

        if normalized_tool == "askuserquestion":
            managed = managed_ref[0] if managed_ref else sessions.get(session_id)
            return await handle_ask_user_question_fn(
                managed,
                tool_name,
                input_data,
            )

        if permission_result_deny is not None:
            hint = (
                f"未授权的工具调用: {tool_name}"
                f"({json.dumps(input_data, ensure_ascii=False)[:200]})\n"
                "当前 Bash 白名单仅允许以下命令:\n"
                "  - python .claude/skills/<skill>/scripts/<script>.py <args>（必须用相对路径）\n"
                "  - ffmpeg / ffprobe\n"
                "其他 Bash 命令均不可用。"
                "请检查命令格式是否匹配白名单规则。"
            )
            return permission_result_deny(message=hint)
        return permission_result_allow(updated_input=input_data)

    return _can_use_tool


__all__ = [
    "build_can_use_tool_callback",
    "handle_ask_user_question",
]
