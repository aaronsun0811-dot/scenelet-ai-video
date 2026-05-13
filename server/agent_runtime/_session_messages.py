"""Pure helpers for SDK message handling.

Extracted from ``session_manager.py``. Covers:

- :data:`MESSAGE_TYPE_MAP` / :data:`TASK_MESSAGE_SUBTYPES` — SDK class
  name → runtime type/subtype mappings.
- :data:`IMAGE_ONLY_SENTINEL` — placeholder used in the local echo queue
  for image-only user messages (the SDK parser strips image blocks).
- :func:`serialize_value` — recursive JSON-safe serializer (dicts,
  lists, Pydantic models, dataclasses, fallback ``str``).
- :func:`infer_message_type` / :func:`extract_sdk_session_id` /
  :func:`message_to_dict` — SDK message normalization.
- :func:`build_user_echo_message` / :func:`build_runtime_status_message`
  — synthetic UI messages for SSE.
- :func:`prune_transient_buffer` — drops streaming-only or already-persisted
  entries so they don't leak into next-round snapshots.
- :func:`is_duplicate_user_echo` — dedupes SDK-replayed user messages
  against pending local echoes.

The main :class:`SessionManager` re-exports the constants as class
attributes and binds each function via ``staticmethod`` so existing
``manager._xxx`` / ``SessionManager._xxx`` call sites keep working.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from server.agent_runtime.message_utils import extract_plain_user_content

# Sentinel used in pending_user_echoes for image-only messages (no text).
# The SDK parser drops image blocks, so the replayed UserMessage arrives
# with empty content; this sentinel lets is_duplicate_user_echo match it.
IMAGE_ONLY_SENTINEL = "__image_only__"

# SDK message class name → runtime "type" field.
MESSAGE_TYPE_MAP: dict[str, str] = {
    "UserMessage": "user",
    "AssistantMessage": "assistant",
    "ResultMessage": "result",
    "SystemMessage": "system",
    "StreamEvent": "stream_event",
    "TaskStartedMessage": "system",
    "TaskProgressMessage": "system",
    "TaskNotificationMessage": "system",
}

# Typed task message subtypes for precise classification.
TASK_MESSAGE_SUBTYPES: dict[str, str] = {
    "TaskStartedMessage": "task_started",
    "TaskProgressMessage": "task_progress",
    "TaskNotificationMessage": "task_notification",
}


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def serialize_value(value: Any) -> Any:
    """Recursively serialize *value* to JSON-safe types.

    Handles: primitives, dicts, lists/tuples, Pydantic models
    (``model_dump(mode="json")``), and dataclass-like objects with
    ``__dict__``. Falls back to ``str(value)``.
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return value

    if isinstance(value, dict):
        return {k: serialize_value(v) for k, v in value.items()}

    if isinstance(value, (list, tuple)):
        return [serialize_value(item) for item in value]

    # Pydantic models — mode="json" 一次产出 JSON 安全结构，避免再次递归
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")

    # Dataclasses or objects with __dict__
    if hasattr(value, "__dict__"):
        return {k: serialize_value(v) for k, v in value.__dict__.items() if not k.startswith("_")}

    # Fallback: convert to string
    return str(value)


def infer_message_type(
    message: Any,
    message_type_map: dict[str, str] = MESSAGE_TYPE_MAP,
) -> str | None:
    """Infer the runtime ``type`` field from an SDK message's class name."""
    class_name = type(message).__name__
    return message_type_map.get(class_name)


def extract_sdk_session_id(message: Any, msg_dict: dict[str, Any]) -> str | None:
    """Extract SDK session id from either the serialized payload or raw object."""
    sdk_id = None
    if isinstance(msg_dict, dict):
        sdk_id = msg_dict.get("session_id") or msg_dict.get("sessionId")
    if sdk_id:
        return str(sdk_id)
    raw_sdk_id = getattr(message, "session_id", None) or getattr(message, "sessionId", None)
    if raw_sdk_id:
        return str(raw_sdk_id)
    return None


def message_to_dict(
    message: Any,
    message_type_map: dict[str, str] = MESSAGE_TYPE_MAP,
    task_message_subtypes: dict[str, str] = TASK_MESSAGE_SUBTYPES,
) -> dict[str, Any]:
    """Convert an SDK message to a JSON-safe dict.

    Adds an inferred ``type`` field when missing, and a precise
    ``subtype`` for typed task messages.
    """
    msg_dict = serialize_value(message)

    if isinstance(msg_dict, dict) and "type" not in msg_dict:
        msg_type = infer_message_type(message, message_type_map)
        if msg_type:
            msg_dict["type"] = msg_type

    if isinstance(msg_dict, dict):
        class_name = type(message).__name__
        subtype = task_message_subtypes.get(class_name)
        if subtype:
            msg_dict["subtype"] = subtype

    return msg_dict


def build_user_echo_message(
    text: str,
    content_blocks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a synthetic user message for real-time UI echo.

    When *content_blocks* is provided (e.g. image + text blocks), the echo
    content is the block list so the UI can render image thumbnails in
    the bubble. Otherwise *text* is used as plain string content.
    """
    content: Any = content_blocks if content_blocks is not None else text
    return {
        "type": "user",
        "content": content,
        "uuid": f"local-user-{uuid4().hex}",
        "timestamp": _utc_now_iso(),
        "local_echo": True,
    }


def build_runtime_status_message(status: str, session_id: str) -> dict[str, Any]:
    """Build a runtime-only status message for SSE wake-up."""
    return {
        "type": "runtime_status",
        "status": status,
        "subtype": status,
        "stop_reason": None,
        "is_error": status == "error",
        "session_id": session_id,
        "uuid": f"runtime-status-{uuid4().hex}",
        "timestamp": _utc_now_iso(),
    }


def prune_transient_buffer(managed: Any) -> None:
    """Drop stale messages that should not leak into next-round snapshots.

    Removes:

    - ``stream_event`` / ``runtime_status`` — transient streaming artifacts.
    - ``user`` / ``assistant`` / ``result`` — already persisted in the SDK
      transcript; keeping them causes duplicate turns because buffer
      messages lack the uuid that transcript messages carry, so
      ``_merge_raw_messages`` cannot deduplicate them.
    """
    if not managed.message_buffer:
        return
    managed.message_buffer = [
        message
        for message in managed.message_buffer
        if message.get("type")
        not in {
            "stream_event",
            "runtime_status",
            "user",
            "assistant",
            "result",
        }
    ]


def is_duplicate_user_echo(
    managed: Any,
    message: dict[str, Any],
    image_only_sentinel: str = IMAGE_ONLY_SENTINEL,
) -> bool:
    """Skip an SDK-replayed user message if it matches the local echo queue.

    Pops the matched entry from ``managed.pending_user_echoes`` on a hit.
    Returns ``False`` (no match) when the queue is empty or contents
    differ.
    """
    if not managed.pending_user_echoes:
        return False
    incoming = extract_plain_user_content(message)
    expected = managed.pending_user_echoes[0].strip()

    # Image-only sentinel: the SDK parser drops image blocks, so the
    # replayed UserMessage arrives with empty content (incoming is None).
    if not incoming:
        if message.get("type") != "user" or expected != image_only_sentinel:
            return False
        managed.pending_user_echoes.pop(0)
        return True

    if incoming != expected:
        return False
    managed.pending_user_echoes.pop(0)
    return True


__all__ = [
    "IMAGE_ONLY_SENTINEL",
    "MESSAGE_TYPE_MAP",
    "TASK_MESSAGE_SUBTYPES",
    "build_runtime_status_message",
    "build_user_echo_message",
    "extract_sdk_session_id",
    "infer_message_type",
    "is_duplicate_user_echo",
    "message_to_dict",
    "prune_transient_buffer",
    "serialize_value",
]
