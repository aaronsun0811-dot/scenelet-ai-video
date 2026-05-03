from __future__ import annotations

import json

import pytest

from lib.project_manager import ProjectOverview
from lib.script_models import ReferenceVideoScript
from lib.text_backends.base import TextGenerationRequest
from lib.text_backends.qa_fake import QAFakeTextBackend


@pytest.mark.asyncio
async def test_qa_fake_overview_respects_travel_workflow() -> None:
    backend = QAFakeTextBackend()

    result = await backend.generate(
        TextGenerationRequest(
            prompt="""
<workflow>
旅游视频路线配置：
- 出发地: 大阪难波站
- 目的地: 黑门市场
- 路线/街景补充: 从难波站北口出发，沿商店街步行，最后进入黑门市场入口。
</workflow>
<source>
QA source for travel_video.
</source>
""",
            response_schema=ProjectOverview,
        )
    )

    data = json.loads(result.text)

    assert data["genre"] == "QA旅游视频"
    assert "大阪难波站" in data["synopsis"]
    assert "黑门市场" in data["synopsis"]
    assert "QA短剧" not in data["genre"]


@pytest.mark.asyncio
async def test_qa_fake_reference_video_respects_travel_route_and_duration() -> None:
    backend = QAFakeTextBackend()

    result = await backend.generate(
        TextGenerationRequest(
            prompt="""
<workflow>
旅游视频路线配置：
- 出发地: 大阪难波站
- 目的地: 黑门市场
- 目标时长: 60s
- 路线/街景补充: 从难波站北口出发，沿商店街步行，经过路牌和斑马线，最后进入黑门市场入口。
</workflow>
""",
            response_schema=ReferenceVideoScript,
        )
    )

    data = json.loads(result.text)
    unit = data["video_units"][0]
    joined_prompt = "\n".join(shot["text"] for shot in unit["shots"])

    assert data["duration_seconds"] == 60
    assert unit["duration_seconds"] == 60
    assert [shot["duration"] for shot in unit["shots"]] == [15, 15, 15, 15]
    assert "大阪难波站" in joined_prompt
    assert "黑门市场" in joined_prompt
