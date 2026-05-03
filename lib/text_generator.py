"""TextGenerator — 文本生成 + 用量追踪包装层。

类似 MediaGenerator，组合 TextBackend + UsageTracker，
调用方无需关心 usage tracking 细节。
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import TYPE_CHECKING

from lib.db.base import DEFAULT_USER_ID
from lib.model_rules import append_model_rule_for_model
from lib.text_backends.base import (
    TextGenerationRequest,
    TextGenerationResult,
    TextTaskType,
)
from lib.text_backends.factory import create_text_backend_for_task
from lib.usage_tracker import UsageTracker

if TYPE_CHECKING:
    from lib.text_backends.base import TextBackend

logger = logging.getLogger(__name__)


class TextGenerator:
    """组合 TextBackend + UsageTracker，统一封装文本生成 + 用量追踪。"""

    def __init__(self, backend: TextBackend, usage_tracker: UsageTracker, *, user_id: str = DEFAULT_USER_ID):
        self.backend = backend
        self.usage_tracker = usage_tracker
        self.user_id = user_id

    @property
    def model(self) -> str:
        """当前 backend 的模型名称。"""
        return self.backend.model

    @classmethod
    async def create(
        cls,
        task_type: TextTaskType,
        project_name: str | None = None,
        *,
        user_id: str = DEFAULT_USER_ID,
    ) -> TextGenerator:
        """工厂方法：根据任务类型创建对应的 backend + usage_tracker。"""
        backend = await create_text_backend_for_task(task_type, project_name, user_id=user_id)
        usage_tracker = UsageTracker()
        return cls(backend, usage_tracker, user_id=user_id)

    async def generate(
        self,
        request: TextGenerationRequest,
        project_name: str | None = None,
    ) -> TextGenerationResult:
        """生成文本并自动记录用量。"""
        effective_prompt = await append_model_rule_for_model(
            request.prompt,
            provider_id=self.backend.name,
            model_id=self.backend.model,
            backend_name=self.backend.name,
            media_type="text",
            user_id=self.user_id,
        )
        effective_request = replace(request, prompt=effective_prompt)
        call_id = await self.usage_tracker.start_call(
            project_name=project_name or "",
            call_type="text",
            model=self.backend.model,
            prompt=effective_prompt[:500],
            provider=self.backend.name,
            user_id=self.user_id,
        )
        try:
            result = await self.backend.generate(effective_request)
            await self.usage_tracker.finish_call(
                call_id,
                status="success",
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
            )
            return result
        except Exception as e:
            await self.usage_tracker.finish_call(
                call_id,
                status="failed",
                error_message=str(e)[:500],
            )
            raise
