"""
Manages ClaudeSDKClient instances with background execution and reconnection support.
"""

import asyncio
import contextlib
import logging
import os
import time
from collections.abc import AsyncIterable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from server.agent_runtime._session_hooks import (
    build_json_post_validation_hook as _build_json_post_validation_hook_impl,
)
from server.agent_runtime._session_hooks import (
    build_json_validation_hook as _build_json_validation_hook_impl,
)
from server.agent_runtime._session_hooks import (
    keep_stream_open_hook as _keep_stream_open_hook_impl,
)
from server.agent_runtime._session_messages import (
    IMAGE_ONLY_SENTINEL as _IMAGE_ONLY_SENTINEL_DEFAULT,
)
from server.agent_runtime._session_messages import (
    MESSAGE_TYPE_MAP as _MESSAGE_TYPE_MAP_DEFAULT,
)
from server.agent_runtime._session_messages import (
    TASK_MESSAGE_SUBTYPES as _TASK_MESSAGE_SUBTYPES_DEFAULT,
)
from server.agent_runtime._session_messages import (
    build_runtime_status_message as _build_runtime_status_message_impl,
)
from server.agent_runtime._session_messages import (
    build_user_echo_message as _build_user_echo_message_impl,
)
from server.agent_runtime._session_messages import (
    extract_sdk_session_id as _extract_sdk_session_id_impl,
)
from server.agent_runtime._session_messages import (
    infer_message_type as _infer_message_type_impl,
)
from server.agent_runtime._session_messages import (
    is_duplicate_user_echo as _is_duplicate_user_echo_impl,
)
from server.agent_runtime._session_messages import (
    message_to_dict as _message_to_dict_impl,
)
from server.agent_runtime._session_messages import (
    prune_transient_buffer as _prune_transient_buffer_impl,
)
from server.agent_runtime._session_messages import (
    serialize_value as _serialize_value_impl,
)
from server.agent_runtime._session_path_guard import (
    CLAUDE_PROJECTS_DIR as _CLAUDE_PROJECTS_DIR_DEFAULT,
)
from server.agent_runtime._session_path_guard import (
    PATH_TOOLS as _PATH_TOOLS_DEFAULT,
)
from server.agent_runtime._session_path_guard import (
    WRITABLE_EXTENSIONS as _WRITABLE_EXTENSIONS_DEFAULT,
)
from server.agent_runtime._session_path_guard import (
    WRITE_TOOLS as _WRITE_TOOLS_DEFAULT,
)
from server.agent_runtime._session_path_guard import (
    build_file_access_hook as _build_file_access_hook_impl,
)
from server.agent_runtime._session_path_guard import (
    encode_sdk_project_path as _encode_sdk_project_path_impl,
)
from server.agent_runtime._session_path_guard import (
    is_path_allowed as _is_path_allowed_impl,
)
from server.agent_runtime._session_permission import (
    build_can_use_tool_callback as _build_can_use_tool_callback_impl,
)
from server.agent_runtime._session_permission import (
    handle_ask_user_question as _handle_ask_user_question_impl,
)
from server.agent_runtime._session_prompts import (
    PERSONA_PROMPT as _PERSONA_PROMPT_DEFAULT,
)
from server.agent_runtime._session_prompts import (
    build_append_prompt as _build_append_prompt_impl,
)
from server.agent_runtime._session_prompts import (
    build_project_context as _build_project_context_impl,
)
from server.agent_runtime._session_prompts import (
    build_untrusted_project_metadata as _build_untrusted_project_metadata_impl,
)
from server.agent_runtime.message_utils import extract_plain_user_content
from server.agent_runtime.models import SessionMeta, SessionStatus
from server.agent_runtime.session_actor import SessionActor, SessionCommand
from server.agent_runtime.session_store import SessionMetaStore

logger = logging.getLogger(__name__)

try:
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
    from claude_agent_sdk.types import HookMatcher, PermissionResultAllow, SystemPromptPreset

    try:
        from claude_agent_sdk.types import PermissionResultDeny
    except ImportError:
        PermissionResultDeny = None
    try:
        from claude_agent_sdk import tag_session
    except ImportError:
        tag_session = None

    SDK_AVAILABLE = True
except ImportError:
    ClaudeSDKClient = None
    ClaudeAgentOptions = None
    HookMatcher = None
    PermissionResultAllow = None
    PermissionResultDeny = None
    tag_session = None
    SDK_AVAILABLE = False

try:
    from lib.config.service import ConfigService
    from lib.db import async_session_factory
except ImportError:
    async_session_factory = None  # type: ignore[assignment]
    ConfigService = None  # type: ignore[assignment]


# inbox 积压告警阈值：~1s 内 100 条 stream_event（典型流式频率上限）；
# 持续高于此值说明 _process_inbox 被阻塞或下游 I/O 超慢。
_INBOX_BACKLOG_WARN_THRESHOLD = 100
_INBOX_BACKLOG_RESET_THRESHOLD = 50  # 降至此水位以下才重置告警状态，避免抖动刷屏


class SessionCapacityError(Exception):
    """所有并发槽位已被 running 会话占满，无法创建新连接。"""

    pass


def _utc_now_iso() -> str:
    """Return current UTC timestamp in ISO-8601 format."""
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass
class PendingQuestion:
    """Tracks a pending AskUserQuestion request."""

    question_id: str
    payload: dict[str, Any]
    answer_future: asyncio.Future[dict[str, str]]


@dataclass
class ManagedSession:
    """A managed ClaudeSDKClient session."""

    session_id: str  # sdk_session_id（已有会话）或临时 UUID（新会话等待中）
    actor: "SessionActor"  # per-session actor owning the SDK client
    status: SessionStatus = "idle"
    project_name: str = ""  # 用于 _register_new_session
    sdk_id_event: asyncio.Event = field(default_factory=asyncio.Event)
    resolved_sdk_id: str | None = None  # consumer 设置，send_new_session 读取
    message_buffer: list[dict[str, Any]] = field(default_factory=list)
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    buffer_max_size: int = 100
    pending_questions: dict[str, PendingQuestion] = field(default_factory=dict)
    pending_user_echoes: list[str] = field(default_factory=list)
    interrupt_requested: bool = False
    last_activity: float | None = None  # updated on every send/receive
    _cleanup_task: asyncio.Task | None = None  # current cleanup timer (idle TTL or terminal delay)
    _inbox: asyncio.Queue = field(default_factory=asyncio.Queue)  # async post-processing queue
    _inbox_warned: bool = False  # edge-triggered backlog warning state
    _process_task: asyncio.Task | None = None  # per-session async inbox processor
    _interrupting: bool = False  # send_interrupt re-entry guard (distinct from interrupt_requested)

    # Message types that must never be silently dropped from subscriber queues.
    _CRITICAL_MESSAGE_TYPES = {"result", "runtime_status", "user", "assistant"}
    # Transient types that are evicted first when buffer is full.
    _TRANSIENT_BUFFER_TYPES = {"stream_event"}

    def add_message(self, message: dict[str, Any]) -> None:
        """Add message to buffer and notify subscribers."""
        self.message_buffer.append(message)
        if len(self.message_buffer) > self.buffer_max_size:
            self._evict_oldest_buffer_entry()
        self._broadcast_to_subscribers(message)

    def _on_actor_message(self, msg: dict[str, Any]) -> None:
        """SessionActor 的 on_message 回调。同步，内存操作，不 await。

        职责：add_message 进行 buffer + broadcast。

        **状态转换不在此处做**——managed.status 由 _finalize_turn 在异步路径中
        统一设置。若在此提前切换为 idle/completed，`send_message` 的并发保护
        （拦截 status=="running"）会在 _finalize_turn 跑完前失效，下一轮消息
        可能进入，随后上一轮 finalize 回写/清理会误伤新一轮。

        pending_questions 注册由 SessionManager._handle_special_message 处理。
        """
        self.add_message(msg)

    async def send_query(self, prompt: str | AsyncIterable[dict], sdk_session_id: str = "default") -> None:
        """将 prompt 送入 SDK 后立即返回；整轮 receive_response 由 actor 后台 drain。

        只等 `cmd.sent`（prompt 已进 SDK）而非 `cmd.done`（整轮结束），以保持
        `/sessions/send` 原有的 "立即 accepted + SSE 异步消费" 语义。
        """
        self.status = "running"
        cmd = SessionCommand(type="query", prompt=prompt, session_id=sdk_session_id)
        await self.actor.enqueue(cmd)
        await cmd.sent.wait()
        if cmd.error is not None:
            self.status = "error"
            raise cmd.error

    async def send_interrupt(self) -> None:
        if self._interrupting:
            return
        self._interrupting = True
        try:
            cmd = SessionCommand(type="interrupt")
            await self.actor.enqueue(cmd)
            await cmd.done.wait()
            if cmd.error is not None:
                raise cmd.error
        finally:
            self._interrupting = False

    async def send_disconnect(self) -> None:
        cmd = SessionCommand(type="disconnect")
        await self.actor.enqueue(cmd)
        await cmd.done.wait()
        await self.actor.wait()
        self.status = "closed"

    def _evict_oldest_buffer_entry(self) -> None:
        """Evict one entry from buffer, preferring transient stream_events."""
        for i, m in enumerate(self.message_buffer[:-1]):
            if m.get("type") in self._TRANSIENT_BUFFER_TYPES:
                self.message_buffer.pop(i)
                return
        self.message_buffer.pop(0)

    def _broadcast_to_subscribers(self, message: dict[str, Any]) -> None:
        """Push message to all subscriber queues, evicting non-critical on overflow."""
        is_critical = message.get("type") in self._CRITICAL_MESSAGE_TYPES
        stale_queues: list[asyncio.Queue] = []
        for queue in self.subscribers:
            if not self._try_enqueue(queue, message, is_critical):
                stale_queues.append(queue)
        for q in stale_queues:
            # Drain the hopelessly full queue and inject a reconnect signal so
            # the SSE consumer loop terminates instead of blocking forever.
            self._drain_and_signal_reconnect(q)
            self.subscribers.discard(q)

    def _drain_and_signal_reconnect(self, queue: asyncio.Queue) -> None:
        """Empty *queue* and push a reconnect signal so the SSE loop exits.

        Uses a connection-level ``_queue_overflow`` type rather than
        ``runtime_status`` so the SSE consumer can close the stream without
        misrepresenting the session's actual status to the client.
        """
        while not queue.empty():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        try:
            queue.put_nowait(
                {
                    "type": "_queue_overflow",
                    "session_id": self.session_id,
                }
            )
        except asyncio.QueueFull:
            pass  # should never happen after drain

    def _try_enqueue(self, queue: asyncio.Queue, message: dict[str, Any], is_critical: bool) -> bool:
        """Try to put *message* into *queue*. Returns False if the queue should be discarded."""
        try:
            queue.put_nowait(message)
            return True
        except asyncio.QueueFull:
            if not is_critical:
                return True  # non-critical drop is acceptable
        # Critical message on a full queue — evict one non-critical to make room.
        self._evict_non_critical(queue)
        try:
            queue.put_nowait(message)
            return True
        except asyncio.QueueFull:
            return False

    @staticmethod
    def _evict_non_critical(queue: asyncio.Queue) -> bool:
        """Try to remove one non-critical message from *queue* to make room."""
        temp: list[dict[str, Any]] = []
        evicted = False
        while not queue.empty():
            try:
                msg = queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if not evicted and msg.get("type") not in ManagedSession._CRITICAL_MESSAGE_TYPES:
                evicted = True  # drop this one
                continue
            temp.append(msg)
        for msg in temp:
            try:
                queue.put_nowait(msg)
            except asyncio.QueueFull:
                break
        return evicted

    def clear_buffer(self) -> None:
        """Clear message buffer after session completes."""
        self.message_buffer.clear()

    def add_pending_question(self, payload: dict[str, Any]) -> PendingQuestion:
        """Register a pending AskUserQuestion payload."""
        question_id = str(payload.get("question_id") or f"aq_{uuid4().hex}")
        payload["question_id"] = question_id
        future: asyncio.Future[dict[str, str]] = asyncio.get_running_loop().create_future()
        pending = PendingQuestion(
            question_id=question_id,
            payload=payload,
            answer_future=future,
        )
        self.pending_questions[question_id] = pending
        return pending

    def resolve_pending_question(self, question_id: str, answers: dict[str, str]) -> bool:
        """Resolve a pending AskUserQuestion with user answers."""
        pending = self.pending_questions.pop(question_id, None)
        if not pending:
            return False
        if not pending.answer_future.done():
            pending.answer_future.set_result(answers)
        return True

    def cancel_pending_questions(self, reason: str = "session closed") -> None:
        """Cancel all pending AskUserQuestion waiters."""
        for pending in list(self.pending_questions.values()):
            if not pending.answer_future.done():
                pending.answer_future.set_exception(RuntimeError(reason))
        self.pending_questions.clear()

    def get_pending_question_payloads(self) -> list[dict[str, Any]]:
        """Return unresolved AskUserQuestion payloads for reconnect snapshot."""
        return [pending.payload for pending in self.pending_questions.values()]


class SessionManager:
    """Manages all active ClaudeSDKClient instances."""

    DEFAULT_ALLOWED_TOOLS = [
        "Skill",
        "Task",
        "Read",
        "Write",
        "Edit",
        "Grep",
        "Glob",
        "AskUserQuestion",
    ]
    DEFAULT_SETTING_SOURCES = ["project"]
    _SDK_ID_TIMEOUT = 60.0

    # Bash is NOT in DEFAULT_ALLOWED_TOOLS — it is controlled by declarative
    # allow rules in settings.json (whitelist approach, default deny).
    # File access control for Read/Write/Edit/Glob/Grep uses PreToolUse hooks.
    # Constants/helpers live in ``_session_path_guard`` — aliased here for
    # backwards compatibility (tests monkeypatch via the class attribute).
    _PATH_TOOLS = _PATH_TOOLS_DEFAULT
    _WRITE_TOOLS = _WRITE_TOOLS_DEFAULT
    _WRITABLE_EXTENSIONS = _WRITABLE_EXTENSIONS_DEFAULT

    # Constants/helpers live in ``_session_messages`` — aliased here so
    # external callers (and tests) keep accessing them as class attributes.
    _IMAGE_ONLY_SENTINEL = _IMAGE_ONLY_SENTINEL_DEFAULT
    _MESSAGE_TYPE_MAP = _MESSAGE_TYPE_MAP_DEFAULT
    _TASK_MESSAGE_SUBTYPES = _TASK_MESSAGE_SUBTYPES_DEFAULT

    def __init__(
        self,
        project_root: Path,
        data_dir: Path,
        meta_store: SessionMetaStore,
    ):
        self.project_root = Path(project_root)
        self.data_dir = Path(data_dir)
        self.meta_store = meta_store
        self.sessions: dict[str, ManagedSession] = {}
        self._disconnecting: set[str] = set()
        self._session_actor_shutdown_timeout: float = 15.0  # total budget for send_disconnect + cancel fallback
        self._connect_locks: dict[str, asyncio.Lock] = {}
        self._load_config()

    def _load_config(self) -> None:
        """Load configuration from environment (sync fallback)."""
        max_turns_env = os.environ.get("ASSISTANT_MAX_TURNS", "").strip()
        self.max_turns = int(max_turns_env) if max_turns_env else None

    @staticmethod
    def _agent_model_from_env() -> str | None:
        model = os.environ.get("ANTHROPIC_MODEL", "").strip()
        return model or None

    async def refresh_config(self) -> None:
        """Reload configuration from ConfigService (DB), falling back to env."""
        try:
            from lib.config.service import ConfigService
            from lib.db import async_session_factory

            async with async_session_factory() as session:
                svc = ConfigService(session)
                raw = await svc.get_setting("assistant_max_turns", "")
                raw = raw.strip()
                if raw:
                    self.max_turns = int(raw)
                    return
        except Exception:
            logger.warning("从 DB 加载 assistant 配置失败，回退到环境变量", exc_info=True)
        # Fallback to env var
        self._load_config()

    _PERSONA_PROMPT = _PERSONA_PROMPT_DEFAULT
    _build_untrusted_project_metadata = staticmethod(_build_untrusted_project_metadata_impl)

    def _build_append_prompt(self, project_name: str, locale: str = "zh") -> str:
        """Thin wrapper around :func:`_session_prompts.build_append_prompt`."""
        return _build_append_prompt_impl(project_name, self._safe_resolve_project_cwd(project_name), locale=locale)

    def _build_project_context(self, project_name: str) -> str:
        """Thin wrapper around :func:`_session_prompts.build_project_context`."""
        return _build_project_context_impl(project_name, self._safe_resolve_project_cwd(project_name))

    def _safe_resolve_project_cwd(self, project_name: str) -> Path | None:
        """Resolve project_cwd, swallowing ``ValueError`` / ``FileNotFoundError``.

        Returns ``None`` when resolution fails so the prompt builders can
        emit an empty context block instead of raising.
        """
        try:
            return self._resolve_project_cwd(project_name)
        except (ValueError, FileNotFoundError):
            return None

    def _build_options(
        self,
        project_name: str,
        resume_id: str | None = None,
        can_use_tool: Callable[[str, dict[str, Any], Any], Any] | None = None,
        locale: str = "zh",
    ) -> Any:
        """Build ClaudeAgentOptions for a session."""
        if not SDK_AVAILABLE or ClaudeAgentOptions is None:
            raise RuntimeError("claude_agent_sdk is not installed")

        transcripts_dir = self.data_dir / "transcripts"
        transcripts_dir.mkdir(parents=True, exist_ok=True)
        project_cwd = self._resolve_project_cwd(project_name)

        # Build PreToolUse hooks — file access control MUST use hooks because
        # Read/Glob/Grep are matched by allow rules (step 4 in the SDK
        # permission chain) before reaching can_use_tool (step 5).  Hooks
        # (step 1) fire for ALL tool calls and can override allow rules.
        hooks = None
        if HookMatcher is not None:
            hook_callbacks: list[Any] = [
                self._build_file_access_hook(project_cwd),
            ]
            if can_use_tool is not None:
                # Official Python SDK guidance: keep stream open when using
                # can_use_tool.
                hook_callbacks.insert(0, self._keep_stream_open_hook)

            # Shared dict: PreToolUse saves file backup, PostToolUse restores
            # on corruption.  Keyed by tool_use_id.
            json_backups: dict[str, tuple[Path, str]] = {}

            hooks = {
                "PreToolUse": [
                    HookMatcher(matcher=None, hooks=hook_callbacks),
                    HookMatcher(
                        matcher="Write|Edit",
                        hooks=[
                            self._build_json_validation_hook(project_cwd, json_backups),
                        ],
                    ),
                ],
                "PostToolUse": [
                    HookMatcher(
                        matcher="Write|Edit",
                        hooks=[
                            self._build_json_post_validation_hook(project_cwd, json_backups),
                        ],
                    ),
                ],
            }

        return ClaudeAgentOptions(
            cwd=str(project_cwd),
            setting_sources=self.DEFAULT_SETTING_SOURCES,
            allowed_tools=self.DEFAULT_ALLOWED_TOOLS,
            model=self._agent_model_from_env(),
            max_turns=self.max_turns,
            system_prompt=SystemPromptPreset(
                type="preset",
                preset="claude_code",
                append=self._build_append_prompt(project_name, locale=locale),
            ),
            include_partial_messages=True,
            resume=resume_id,
            can_use_tool=can_use_tool,
            hooks=hooks,
        )

    _keep_stream_open_hook = staticmethod(_keep_stream_open_hook_impl)

    def _build_file_access_hook(
        self,
        project_cwd: Path,
    ) -> Callable[..., Any]:
        """Build a PreToolUse hook that enforces file access control.

        Delegates to :func:`_session_path_guard.build_file_access_hook`,
        passing ``self._is_path_allowed`` so tests can monkeypatch
        ``SessionManager._CLAUDE_PROJECTS_DIR`` and still affect the
        hook's behavior.
        """
        return _build_file_access_hook_impl(project_cwd, self._is_path_allowed)

    _build_json_validation_hook = staticmethod(_build_json_validation_hook_impl)

    _build_json_post_validation_hook = staticmethod(
        _build_json_post_validation_hook_impl
    )

    def _resolve_project_cwd(self, project_name: str) -> Path:
        """Resolve and validate per-session project working directory."""
        projects_root = (self.project_root / "projects").resolve()
        project_cwd = (projects_root / project_name).resolve()
        try:
            project_cwd.relative_to(projects_root)
        except ValueError as exc:
            raise ValueError("invalid project name") from exc
        if not project_cwd.exists() or not project_cwd.is_dir():
            raise FileNotFoundError(f"project not found: {project_name}")
        return project_cwd

    def _make_actor_message_callback(
        self,
        managed_ref: list["ManagedSession | None"],
    ) -> Callable[[Any], None]:
        """Sync on_message callback shared by send_new_session and get_or_connect.

        Runs inside the actor task. Order is load-bearing:
        duplicate-echo detection skips buffer-add but still queues the message
        for async sdk_session_id capture; _handle_special_message must mutate
        result messages with `session_status` before subscribers see them via
        add_message; _inbox hand-off last so async post-processing never
        observes a message that hasn't been broadcast yet.
        """

        def _on_message(raw_msg: Any) -> None:
            managed = managed_ref[0]
            if managed is None:
                return
            msg_dict = self._message_to_dict(raw_msg)
            if not isinstance(msg_dict, dict):
                return
            if self._is_duplicate_user_echo(managed, msg_dict):
                managed._inbox.put_nowait(msg_dict)
                return
            self._handle_special_message(managed, msg_dict)
            managed._on_actor_message(msg_dict)
            managed._inbox.put_nowait(msg_dict)

        return _on_message

    def _make_actor_done_callback(
        self,
        managed: "ManagedSession",
    ) -> Callable[[asyncio.Task], None]:
        """Actor task done_callback: push inbox sentinel + persist error state.

        On actor task exit the inbox processor is signalled via None sentinel
        so it can drain cleanly. If the actor died with an exception, we flip
        the session to `error` in memory and schedule a meta_store persist so
        the DB doesn't stay stuck on `running` after a crash.
        """

        def _on_done(task: asyncio.Task) -> None:
            try:
                managed._inbox.put_nowait(None)
            except Exception:
                logger.debug("inbox sentinel push failed", exc_info=True)
            if task.cancelled():
                return
            exc = task.exception()
            if exc is None:
                return
            logger.warning(
                "session actor 异常退出 session_id=%s: %s",
                managed.session_id,
                exc,
            )
            managed.status = "error"
            try:
                managed.add_message(self._build_runtime_status_message("error", managed.session_id))
            except Exception:
                logger.debug("broadcast runtime_status after actor failure failed", exc_info=True)
            # Persist error state so DB doesn't stay at "running" after a crash.
            asyncio.create_task(self._persist_actor_error_status(managed.session_id))

        return _on_done

    async def _persist_actor_error_status(self, session_id: str) -> None:
        try:
            await self.meta_store.update_status(session_id, "error")
        except Exception:
            logger.exception("持久化 actor error 状态失败 session_id=%s", session_id)

    async def send_new_session(
        self,
        project_name: str,
        prompt: str | AsyncIterable[dict],
        *,
        echo_text: str | None = None,
        echo_content: list[dict[str, Any]] | None = None,
        locale: str = "zh",
    ) -> str:
        """Create a new session via send-first: start actor, send query, wait for sdk_session_id."""
        if not SDK_AVAILABLE or ClaudeSDKClient is None:
            raise RuntimeError("claude_agent_sdk is not installed")

        await self._ensure_capacity()
        temp_id = uuid4().hex
        managed_ref: list[ManagedSession | None] = [None]

        options = self._build_options(
            project_name,
            resume_id=None,
            can_use_tool=await self._build_can_use_tool_callback(temp_id, managed_ref),
            locale=locale,
        )

        actor = SessionActor(
            client_factory=lambda: ClaudeSDKClient(options=options),
            on_message=self._make_actor_message_callback(managed_ref),
        )

        managed = ManagedSession(
            session_id=temp_id,
            actor=actor,
            status="running",
            project_name=project_name,
        )
        managed_ref[0] = managed
        managed.last_activity = time.monotonic()
        self.sessions[temp_id] = managed

        try:
            await actor.start()
        except Exception:
            logger.exception("新会话 actor 启动失败 temp_id=%s", temp_id)
            self.sessions.pop(temp_id, None)
            raise

        # Register done callback BEFORE spawning processor to avoid a race
        # where the actor task completes before add_done_callback is attached,
        # leaving the None sentinel un-pushed and _process_inbox hanging.
        actor.add_done_callback(self._make_actor_done_callback(managed))

        # Spawn inbox processor BEFORE sending query so we don't miss messages.
        managed._process_task = asyncio.create_task(
            self._process_inbox(managed),
            name=f"inbox-{temp_id}",
        )

        async def _cleanup_on_error() -> None:
            """Unified cleanup for failure paths after _process_task spawn.

            Runs send_disconnect first (which causes actor to exit and
            _on_actor_done to push the None sentinel, letting _process_inbox
            finish naturally), then belt-and-suspenders cancels the processor
            in case it is stuck elsewhere.
            """
            self.sessions.pop(temp_id, None)
            try:
                await managed.send_disconnect()
            except Exception:
                logger.exception(
                    "send_disconnect on error path failed session_id=%s",
                    temp_id,
                )
            if managed._process_task is not None and not managed._process_task.done():
                managed._process_task.cancel()
                await asyncio.gather(managed._process_task, return_exceptions=True)

        # Echo user message
        display_text = echo_text or (prompt if isinstance(prompt, str) else "")
        dedup_key = display_text or (self._IMAGE_ONLY_SENTINEL if echo_content else "")
        if dedup_key:
            managed.pending_user_echoes.append(dedup_key)
        managed.add_message(self._build_user_echo_message(display_text, echo_content))

        try:
            await managed.send_query(prompt)
        except Exception:
            logger.exception("新会话消息发送失败")
            await _cleanup_on_error()
            raise

        # Wait for sdk_session_id with timeout; also monitor actor task so we
        # fail fast if the background task crashes before the event fires.
        event_task = asyncio.create_task(managed.sdk_id_event.wait())
        watch_tasks: set[asyncio.Task] = {event_task}
        actor_task = actor.task
        if actor_task is not None:
            watch_tasks.add(actor_task)
        try:
            await asyncio.wait(
                watch_tasks,
                timeout=self._SDK_ID_TIMEOUT,
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            if not event_task.done():
                event_task.cancel()

        if not managed.sdk_id_event.is_set():
            if actor_task is not None and actor_task.done():
                logger.error("session actor 提前退出，未获得 sdk_session_id temp_id=%s", temp_id)
            else:
                logger.error("等待 sdk_session_id 超时 temp_id=%s", temp_id)
            managed.cancel_pending_questions("session creation timed out")
            await _cleanup_on_error()
            raise TimeoutError("SDK 会话创建超时")

        sdk_id = managed.resolved_sdk_id
        assert sdk_id is not None
        # Key swap already done in _on_sdk_session_id_received
        assert managed.session_id == sdk_id

        return sdk_id

    async def _process_inbox(self, managed: ManagedSession) -> None:
        """Drain ManagedSession._inbox and run async post-processing.

        Replaces the async tail of _consume_messages. The synchronous bits
        (state machine, buffer add, broadcast, _handle_special_message,
        duplicate-echo dedup) already ran inside the actor's on_message
        callback, so this coroutine only handles:
        - sdk_session_id capture (DB create, tag, key swap, event set)
        - _finalize_turn on result messages
        - terminal status on cancel/error
        """
        try:
            while True:
                msg_dict = await managed._inbox.get()
                if msg_dict is None:
                    return
                depth = managed._inbox.qsize()
                if not managed._inbox_warned and depth >= _INBOX_BACKLOG_WARN_THRESHOLD:
                    managed._inbox_warned = True
                    logger.warning(
                        "inbox backlog 过深 session_id=%s depth=%d (async post-processing 跟不上)",
                        managed.session_id,
                        depth,
                    )
                elif managed._inbox_warned and depth <= _INBOX_BACKLOG_RESET_THRESHOLD:
                    managed._inbox_warned = False
                # Short-circuit once sdk_session_id is captured: stream_event
                # messages can be very high-frequency and _extract_sdk_session_id
                # only yields on the init system message.
                if managed.resolved_sdk_id is None:
                    try:
                        await self._on_sdk_session_id_received(managed, None, msg_dict)
                    except Exception:
                        logger.exception(
                            "sdk_session_id 处理失败 session_id=%s",
                            managed.session_id,
                        )
                if msg_dict.get("type") == "result":
                    try:
                        await self._finalize_turn(managed, msg_dict)
                    except Exception:
                        # finalize 失败意味着 status/interrupt_requested/cleanup 可能部分未完成；
                        # 走终态兜底而非继续循环——继续会让下一轮看到不一致的残留状态。
                        logger.exception(
                            "_finalize_turn 失败，走 error 终态兜底 session_id=%s",
                            managed.session_id,
                        )
                        with contextlib.suppress(Exception):
                            await self._mark_session_terminal(managed, "error", "finalize failed")
                        return
        except asyncio.CancelledError:
            # Only mark interrupted if session was actually running. Cancel can
            # also happen during failed send_new_session cleanup or normal
            # shutdown, where the status is already terminal / error.
            if managed.status == "running":
                try:
                    await self._mark_session_terminal(managed, "interrupted", "session interrupted")
                except Exception:
                    logger.exception(
                        "_mark_session_terminal 在 cancel 路径失败 session_id=%s",
                        managed.session_id,
                    )
            raise
        except Exception:
            logger.exception("_process_inbox 异常 session_id=%s", managed.session_id)
            try:
                await self._mark_session_terminal(managed, "error", "session error")
            except Exception:
                logger.debug("_mark_session_terminal cleanup failed", exc_info=True)
            raise

    async def get_or_connect(self, session_id: str, *, meta: Optional["SessionMeta"] = None) -> ManagedSession:
        """Get existing managed session or spin up an actor for resumed session."""
        if session_id in self.sessions and session_id not in self._disconnecting:
            return self.sessions[session_id]

        # Per-session lock prevents concurrent connect() for the same session_id.
        if session_id not in self._connect_locks:
            self._connect_locks[session_id] = asyncio.Lock()
        lock = self._connect_locks[session_id]

        async with lock:
            # Re-check after acquiring lock
            if session_id in self.sessions and session_id not in self._disconnecting:
                return self.sessions[session_id]

            if meta is None:
                meta = await self.meta_store.get(session_id)
                if meta is None:
                    raise FileNotFoundError(f"session not found: {session_id}")

            if not SDK_AVAILABLE or ClaudeSDKClient is None:
                raise RuntimeError("claude_agent_sdk is not installed")

            await self._ensure_capacity()
            managed_ref: list[ManagedSession | None] = [None]
            options = self._build_options(
                meta.project_name,
                meta.id,  # SessionMeta.id 就是 sdk_session_id
                can_use_tool=await self._build_can_use_tool_callback(session_id, managed_ref),
            )

            actor = SessionActor(
                client_factory=lambda: ClaudeSDKClient(options=options),
                on_message=self._make_actor_message_callback(managed_ref),
            )

            resumed_status: SessionStatus = (
                meta.status if meta.status in ("idle", "running", "interrupted", "error", "closed") else "idle"
            )
            managed = ManagedSession(
                session_id=meta.id,  # 现在就是 sdk_session_id
                actor=actor,
                status=resumed_status,
                project_name=meta.project_name,
                resolved_sdk_id=meta.id,  # 标记为已注册，防止重复创建 DB 记录
            )
            managed.sdk_id_event.set()  # 已有会话不需要等待 sdk_id
            managed_ref[0] = managed
            managed.last_activity = time.monotonic()
            self.sessions[session_id] = managed

            try:
                await actor.start()
            except Exception:
                logger.exception("恢复会话 actor 启动失败 session_id=%s", session_id)
                self.sessions.pop(session_id, None)
                raise

            # done_callback BEFORE processor spawn (avoids race where actor
            # completes before the callback attaches and the None sentinel
            # is never pushed).
            actor.add_done_callback(self._make_actor_done_callback(managed))

            managed._process_task = asyncio.create_task(
                self._process_inbox(managed),
                name=f"inbox-{session_id}",
            )
            return managed

    async def send_message(
        self,
        session_id: str,
        prompt: str | AsyncIterable[dict],
        *,
        echo_text: str | None = None,
        echo_content: list[dict[str, Any]] | None = None,
        meta: Optional["SessionMeta"] = None,
    ) -> None:
        """Send a message via the session actor."""
        managed = await self.get_or_connect(session_id, meta=meta)
        managed.last_activity = time.monotonic()
        # 取消待执行的 cleanup（会话恢复活跃）
        if managed._cleanup_task and not managed._cleanup_task.done():
            managed._cleanup_task.cancel()
            managed._cleanup_task = None

        if managed.status == "running":
            raise ValueError("会话正在处理中，请等待当前回复完成后再发送新消息")

        self._prune_transient_buffer(managed)

        # Determine the display text for echo dedup (pending_user_echoes).
        # For image-only messages display_text is empty; use a sentinel so the
        # SDK-replayed empty-content user message can still be deduplicated.
        display_text = echo_text or (prompt if isinstance(prompt, str) else "")
        dedup_key = display_text or (self._IMAGE_ONLY_SENTINEL if echo_content else "")

        # Echo user input immediately so live SSE shows it even when the SDK
        # stream doesn't replay user messages in real time. Don't set status to
        # "running" manually — send_query does it inside the actor.
        if dedup_key:
            managed.pending_user_echoes.append(dedup_key)
            if len(managed.pending_user_echoes) > 20:
                managed.pending_user_echoes.pop(0)
        managed.add_message(self._build_user_echo_message(display_text, echo_content))

        # Persist status asynchronously — don't block the echo broadcast
        await self.meta_store.update_status(session_id, "running")

        # Send the query via the actor. send_query flips status to error on
        # cmd.error and re-raises; we ensure meta store reflects that too.
        try:
            await managed.send_query(prompt, sdk_session_id=session_id)
        except Exception:
            logger.exception("会话消息处理失败")
            managed.pending_user_echoes.clear()
            try:
                await self.meta_store.update_status(session_id, "error")
            except Exception:
                logger.exception("持久化 error 状态失败 session_id=%s", session_id)
            raise

    async def interrupt_session(self, session_id: str) -> SessionStatus:
        """Interrupt a running session via the actor."""
        meta = await self.meta_store.get(session_id)
        if meta is None:
            raise FileNotFoundError(f"session not found: {session_id}")

        managed = self.sessions.get(session_id)
        if managed is None:
            if meta.status == "running":
                await self.meta_store.update_status(session_id, "interrupted")
                return "interrupted"
            return meta.status

        if managed.status != "running":
            return managed.status

        managed.pending_user_echoes.clear()
        managed.interrupt_requested = True
        managed.cancel_pending_questions("session interrupted by user")

        try:
            await managed.send_interrupt()
        except Exception:
            logger.exception("发送 interrupt 命令失败 session_id=%s", session_id)
            managed.status = "error"
            return managed.status

        managed.last_activity = time.monotonic()
        # status 由 _on_actor_message 在收到 ResultMessage(error_during_execution) 时推导为 "interrupted"
        return managed.status

    def _handle_special_message(self, managed: ManagedSession, msg_dict: dict[str, Any]) -> None:
        """Handle compact_boundary and result messages before broadcast."""
        if msg_dict.get("type") == "system" and msg_dict.get("subtype") == "compact_boundary":
            self._prune_transient_buffer(managed)

        if msg_dict.get("type") == "result":
            msg_dict["session_status"] = self._resolve_result_status(
                msg_dict,
                interrupt_requested=managed.interrupt_requested,
            )

    async def _finalize_turn(self, managed: ManagedSession, result_msg: dict[str, Any]) -> None:
        """Settle session state after a result message completes a turn."""
        managed.pending_user_echoes.clear()
        managed.cancel_pending_questions("session completed")
        explicit = str(result_msg.get("session_status") or "").strip()
        final_status: SessionStatus = (
            explicit  # type: ignore[assignment]
            if explicit in {"idle", "running", "completed", "error", "interrupted"}
            else self._resolve_result_status(
                result_msg,
                interrupt_requested=managed.interrupt_requested,
            )
        )
        managed.status = final_status
        managed.last_activity = time.monotonic()
        await self.meta_store.update_status(managed.session_id, final_status)
        managed.interrupt_requested = False
        self._prune_transient_buffer(managed)
        if final_status != "running":
            self._schedule_cleanup(managed.session_id)

    async def _mark_session_terminal(self, managed: ManagedSession, status: SessionStatus, reason: str) -> None:
        """Set terminal status on abnormal consumer exit."""
        managed.pending_user_echoes.clear()
        managed.cancel_pending_questions(reason)
        managed.status = status
        managed.last_activity = time.monotonic()
        await self.meta_store.update_status(managed.session_id, status)
        managed.interrupt_requested = False
        self._prune_transient_buffer(managed)

        # For interrupted sessions, broadcast a synthetic interrupt echo so the
        # SSE projector generates an interrupt_notice turn.  This keeps the live
        # path consistent with the historical path where the SDK transcript
        # contains the CLI-injected interrupt echo that the turn_grouper converts.
        # The consumer task is already cancelled at this point so the SDK's own
        # echo will never arrive through the normal message pipeline.
        if status == "interrupted":
            managed._broadcast_to_subscribers(
                {
                    "type": "user",
                    "content": "[Request interrupted by user]",
                    "uuid": f"interrupt-echo-{uuid4().hex}",
                    "timestamp": _utc_now_iso(),
                }
            )

        # Broadcast terminal status so SSE subscribers unblock immediately
        # instead of waiting for the heartbeat timeout.
        managed._broadcast_to_subscribers(
            {
                "type": "runtime_status",
                "status": status,
                "reason": reason,
            }
        )
        self._schedule_cleanup(managed.session_id)

    def _schedule_cleanup(self, session_id: str) -> None:
        """Schedule delayed cleanup for a non-running session."""
        managed = self.sessions.get(session_id)
        if managed is None:
            return
        if managed._cleanup_task is not None and not managed._cleanup_task.done():
            managed._cleanup_task.cancel()
        managed._cleanup_task = asyncio.create_task(self._cleanup_idle(session_id))

    async def _cleanup_idle(self, session_id: str) -> None:
        try:
            delay = await self._get_cleanup_delay()
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        managed = self.sessions.get(session_id)
        if managed is None:
            return
        if managed.status in ("idle", "interrupted", "error", "completed"):
            # Clear our own reference first so _evict_one's cleanup-task cancel doesn't self-cancel
            managed._cleanup_task = None
            await self._evict_one(managed)

    async def close_session(self, session_id: str, *, reason: str = "session closed") -> None:
        """Public close entry — gracefully tears down the actor and removes the session."""
        managed = self.sessions.get(session_id)
        if managed is None:
            return
        managed.cancel_pending_questions(reason)
        await self._evict_one(managed)

    async def _evict_one(self, managed: ManagedSession) -> None:
        """Gracefully disconnect an actor, cancel as fallback, and remove from registry."""
        session_id = managed.session_id
        if session_id in self._disconnecting:
            return
        self._disconnecting.add(session_id)
        try:
            # Cancel any pending cleanup timer first
            if managed._cleanup_task is not None and not managed._cleanup_task.done():
                managed._cleanup_task.cancel()
                with contextlib.suppress(BaseException):
                    await managed._cleanup_task

            try:
                await asyncio.wait_for(
                    managed.send_disconnect(),
                    timeout=self._session_actor_shutdown_timeout,
                )
            except TimeoutError:
                logger.warning(
                    "actor disconnect 超时，走 cancel 兜底 session_id=%s",
                    session_id,
                )
                if managed.actor is not None:
                    await managed.actor.cancel_and_wait()
                managed.status = "interrupted"
            except Exception:
                logger.exception("actor 关停异常 session_id=%s", session_id)
                managed.status = "error"

            # Drain the inbox processor
            try:
                managed._inbox.put_nowait(None)
            except Exception:
                pass
            if managed._process_task is not None and not managed._process_task.done():
                try:
                    await asyncio.wait_for(managed._process_task, timeout=5.0)
                except TimeoutError:
                    managed._process_task.cancel()
                    with contextlib.suppress(BaseException):
                        await managed._process_task
                except BaseException:
                    logger.exception(
                        "_process_inbox 退出异常 session_id=%s",
                        session_id,
                    )

            # 若会话关闭时仍被标记为 running，持久化为终态以防进程重启后卡死：
            # send_message 已把 DB 写成 running；缺少此步 get_or_connect 恢复
            # 后会拒绝新消息（SessionStatus == "running"）。
            if managed.resolved_sdk_id is not None:
                if managed.status == "running":
                    managed.status = "interrupted"
                if managed.status in ("interrupted", "error"):
                    with contextlib.suppress(BaseException):
                        await self.meta_store.update_status(managed.resolved_sdk_id, managed.status)
        finally:
            self.sessions.pop(session_id, None)
            self._connect_locks.pop(session_id, None)
            self._disconnecting.discard(session_id)

    async def _get_cleanup_delay(self) -> int:
        """返回会话清理延迟秒数，默认 300（5 分钟）。"""
        try:
            async with async_session_factory() as session:
                svc = ConfigService(session)
                val = await svc.get_setting("agent_session_cleanup_delay_seconds", "300")
            return max(int(val), 10)
        except Exception:
            logger.warning("读取 cleanup delay 配置失败，使用默认值", exc_info=True)
            return 300

    async def _get_max_concurrent(self) -> int:
        """返回最大并发会话数，默认 5。"""
        try:
            async with async_session_factory() as session:
                svc = ConfigService(session)
                val = await svc.get_setting("agent_max_concurrent_sessions", "5")
            return max(int(val), 1)
        except Exception:
            logger.warning("读取 max_concurrent 配置失败，使用默认值", exc_info=True)
            return 5

    async def _ensure_capacity(self) -> None:
        """确保有空余并发槽位，必要时淘汰最久未活跃的非 running 会话。"""
        max_concurrent = await self._get_max_concurrent()
        active = [s for s in self.sessions.values() if s.actor is not None and s.session_id not in self._disconnecting]

        if len(active) < max_concurrent:
            return

        # 可淘汰的会话：非 running 状态（idle / completed / error / interrupted）
        evictable = sorted(
            [s for s in active if s.status != "running"],
            key=lambda s: s.last_activity or 0,
        )

        if evictable:
            victim = evictable[0]
            logger.info(
                "并发上限，淘汰 session_id=%s (status=%s)",
                victim.session_id,
                victim.status,
            )
            try:
                await self._evict_one(victim)
            except Exception as exc:
                logger.error(
                    "淘汰会话失败，无法释放并发槽位 session_id=%s",
                    victim.session_id,
                    exc_info=True,
                )
                raise SessionCapacityError("存在未能关闭的空闲会话，当前无法释放并发槽位，请稍后重试") from exc
            return

        # 所有会话都在 running → 拒绝
        raise SessionCapacityError(f"当前有{len(active)}个正在进行的会话，已达到最大上限，请稍后重试")

    _PATROL_INTERVAL = 300  # 5 分钟

    async def _patrol_once(self) -> None:
        """单次巡检：清理所有超时的非 running 会话。"""
        cleanup_delay = await self._get_cleanup_delay()
        now = time.monotonic()
        for sid, managed in list(self.sessions.items()):
            if managed.status == "running" or sid in self._disconnecting:
                continue
            activity_age = now - (managed.last_activity or 0)
            if activity_age > cleanup_delay * 2:
                logger.info("巡检兜底清理会话 session_id=%s status=%s", sid, managed.status)
                try:
                    m = self.sessions.get(sid)
                    if m is not None:
                        await self._evict_one(m)
                except Exception:
                    logger.warning(
                        "巡检兜底清理失败 session_id=%s",
                        sid,
                        exc_info=True,
                    )

    async def _patrol_loop(self) -> None:
        """后台定期巡检循环。"""
        while True:
            await asyncio.sleep(self._PATROL_INTERVAL)
            try:
                await self._patrol_once()
            except Exception:
                logger.warning("巡检循环异常", exc_info=True)

    def start_patrol(self) -> None:
        """启动巡检后台任务（应在应用 startup 时调用）。"""
        self._patrol_task = asyncio.create_task(self._patrol_loop())

    @staticmethod
    def _resolve_result_status(
        result_message: dict[str, Any],
        interrupt_requested: bool = False,
    ) -> SessionStatus:
        """Map SDK result subtype/is_error to runtime session status."""
        subtype = str(result_message.get("subtype") or "").strip().lower()
        is_error = bool(result_message.get("is_error"))
        if interrupt_requested:
            if subtype in {"interrupted", "interrupt"}:
                return "interrupted"
            if is_error or subtype.startswith("error"):
                return "interrupted"
        if is_error or subtype.startswith("error"):
            return "error"
        return "completed"

    # Base directory where the SDK stores per-project session data.
    # Kept as a class attribute so tests can monkeypatch it.
    _CLAUDE_PROJECTS_DIR: Path = _CLAUDE_PROJECTS_DIR_DEFAULT

    _encode_sdk_project_path = staticmethod(_encode_sdk_project_path_impl)

    def _is_path_allowed(
        self,
        file_path: str,
        tool_name: str,
        project_cwd: Path,
    ) -> tuple[bool, str | None]:
        """Thin wrapper around :func:`_session_path_guard.is_path_allowed`.

        Reads ``self._CLAUDE_PROJECTS_DIR`` on every call so tests that
        monkeypatch the class attribute take effect.
        """
        return _is_path_allowed_impl(
            file_path,
            tool_name,
            project_cwd,
            self.project_root,
            self._CLAUDE_PROJECTS_DIR,
        )

    async def _handle_ask_user_question(
        self,
        managed: Optional["ManagedSession"],
        tool_name: str,
        input_data: dict[str, Any],
    ) -> Any:
        """Thin wrapper around :func:`_session_permission.handle_ask_user_question`.

        Reads the module-level ``PermissionResultAllow`` / ``PermissionResultDeny``
        each call so tests that monkeypatch those names take effect.
        """
        return await _handle_ask_user_question_impl(
            managed,
            tool_name,
            input_data,
            permission_result_allow=PermissionResultAllow,
            permission_result_deny=PermissionResultDeny,
        )

    async def _build_can_use_tool_callback(
        self,
        session_id: str,
        managed_ref: list[Optional["ManagedSession"]] | None = None,
    ):
        """Thin wrapper around :func:`_session_permission.build_can_use_tool_callback`.

        See that function for details on the SDK permission chain (this is
        step 5: the default-deny fallback that also handles
        ``AskUserQuestion``).
        """
        return _build_can_use_tool_callback_impl(
            session_id,
            self.sessions,
            self._handle_ask_user_question,
            permission_result_allow=PermissionResultAllow,
            permission_result_deny=PermissionResultDeny,
            managed_ref=managed_ref,
        )

    _message_to_dict = staticmethod(_message_to_dict_impl)
    _build_user_echo_message = staticmethod(_build_user_echo_message_impl)
    _prune_transient_buffer = staticmethod(_prune_transient_buffer_impl)
    _build_runtime_status_message = staticmethod(_build_runtime_status_message_impl)
    _extract_plain_user_content = staticmethod(extract_plain_user_content)
    _is_duplicate_user_echo = staticmethod(_is_duplicate_user_echo_impl)

    async def _on_sdk_session_id_received(
        self,
        managed: ManagedSession,
        message: Any,
        msg_dict: dict[str, Any],
    ) -> None:
        """Handle sdk_session_id from stream. For new sessions: create DB record + signal event."""
        sdk_id = self._extract_sdk_session_id(message, msg_dict)
        if not sdk_id:
            return
        if managed.resolved_sdk_id is not None:
            return  # Already registered

        managed.resolved_sdk_id = sdk_id

        # Only create DB record for new sessions (no existing meta)
        if not managed.sdk_id_event.is_set():
            # Run DB create and SDK tag in parallel (tag is independent file I/O)
            tag_coro = None
            if tag_session is not None:

                async def _tag() -> None:
                    try:
                        await asyncio.to_thread(tag_session, sdk_id, f"project:{managed.project_name}")
                    except Exception:
                        logger.warning("tag_session failed for %s", sdk_id, exc_info=True)

                tag_coro = _tag()
            await asyncio.gather(
                self.meta_store.create(managed.project_name, sdk_id),
                *([] if tag_coro is None else [tag_coro]),
            )
            await self.meta_store.update_status(sdk_id, "running")
            # Key swap: replace temp_id with real sdk_id in sessions dict
            # BEFORE signaling the event. This prevents _finalize_turn from
            # using the stale temp_id if it runs before send_new_session
            # completes its own key swap.
            old_id = managed.session_id
            if old_id != sdk_id and old_id in self.sessions:
                del self.sessions[old_id]
                managed.session_id = sdk_id
                self.sessions[sdk_id] = managed
            managed.sdk_id_event.set()

    _extract_sdk_session_id = staticmethod(_extract_sdk_session_id_impl)
    _infer_message_type = staticmethod(_infer_message_type_impl)
    _serialize_value = staticmethod(_serialize_value_impl)

    async def get_message_buffer_snapshot(self, session_id: str) -> list[dict[str, Any]]:
        """Get current message buffer without creating a new SDK connection."""
        managed = self.sessions.get(session_id)
        if not managed:
            return []
        return list(managed.message_buffer)

    def get_buffered_messages(self, session_id: str) -> list[dict[str, Any]]:
        """Sync helper for consumers that only need in-memory buffer state."""
        managed = self.sessions.get(session_id)
        if not managed:
            return []
        return list(managed.message_buffer)

    async def get_pending_questions_snapshot(self, session_id: str) -> list[dict[str, Any]]:
        """Get unresolved AskUserQuestion payloads for reconnect."""
        managed = self.sessions.get(session_id)
        if not managed:
            return []
        return managed.get_pending_question_payloads()

    async def answer_user_question(
        self,
        session_id: str,
        question_id: str,
        answers: dict[str, str],
    ) -> None:
        """Resolve AskUserQuestion answers for a running session."""
        managed = self.sessions.get(session_id)
        if managed is None:
            raise ValueError("会话未运行或无待回答问题")
        if managed.status != "running":
            raise ValueError("会话未运行或无待回答问题")
        if not managed.resolve_pending_question(question_id, answers):
            raise ValueError("未找到待回答的问题")

    async def subscribe(self, session_id: str, replay_buffer: bool = True) -> asyncio.Queue:
        """Subscribe to session messages. Returns queue for SSE."""
        managed = await self.get_or_connect(session_id)
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)

        if replay_buffer:
            # Replay buffered messages
            for msg in managed.message_buffer:
                try:
                    queue.put_nowait(msg)
                except asyncio.QueueFull:
                    break

        managed.subscribers.add(queue)
        return queue

    async def unsubscribe(self, session_id: str, queue: asyncio.Queue) -> None:
        """Unsubscribe from session messages."""
        if session_id in self.sessions:
            self.sessions[session_id].subscribers.discard(queue)

    async def get_status(self, session_id: str) -> SessionStatus | None:
        """Get session status."""
        if session_id in self.sessions:
            return self.sessions[session_id].status
        meta = await self.meta_store.get(session_id)
        return meta.status if meta else None

    async def shutdown_gracefully(self, timeout: float = 30.0) -> None:
        """Gracefully shutdown all sessions using the actor teardown path."""
        patrol = getattr(self, "_patrol_task", None)
        if patrol is not None and not patrol.done():
            patrol.cancel()
            with contextlib.suppress(BaseException):
                await patrol

        sessions = list(self.sessions.values())
        if not sessions:
            return
        await asyncio.gather(
            *[self._evict_one(s) for s in sessions],
            return_exceptions=True,
        )
