"""Deterministic text backend for local QA flows."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from lib.text_backends.base import (
    TextCapability,
    TextGenerationRequest,
    TextGenerationResult,
    resolve_schema,
)

_FAIL_MARKERS = ("[qa-fake:fail]", "QA_FAKE_FAIL")


class QAFakeTextBackend:
    """A controllable, no-network backend used by QA automation."""

    def __init__(self, model: str | None = None, **_: Any) -> None:
        self._model = model or "qa-fake-text"

    @property
    def name(self) -> str:
        return "qa-fake"

    @property
    def model(self) -> str:
        return self._model

    @property
    def capabilities(self) -> set[TextCapability]:
        return {
            TextCapability.TEXT_GENERATION,
            TextCapability.STRUCTURED_OUTPUT,
            TextCapability.VISION,
        }

    async def generate(self, request: TextGenerationRequest) -> TextGenerationResult:
        _raise_if_forced_failure(request.prompt)
        await _sleep_if_requested(request.prompt)

        if request.response_schema is None:
            text = _plain_text_response(request.prompt)
        else:
            payload = _structured_response(request.response_schema, request.prompt)
            text = json.dumps(payload, ensure_ascii=False)

        return TextGenerationResult(
            text=text,
            provider=self.name,
            model=self.model,
            input_tokens=max(1, len(request.prompt) // 4),
            output_tokens=max(1, len(text) // 4),
        )


def _raise_if_forced_failure(prompt: str) -> None:
    if any(marker in prompt for marker in _FAIL_MARKERS):
        raise RuntimeError("QA fake forced failure")


async def _sleep_if_requested(prompt: str) -> None:
    match = re.search(r"\[qa-fake:sleep:(\d+(?:\.\d+)?)\]", prompt)
    if not match:
        return
    await asyncio.sleep(min(float(match.group(1)), 5.0))


def _plain_text_response(prompt: str) -> str:
    lowered = prompt.lower()
    if "reference_video" in lowered or "unit" in lowered or "路线" in prompt:
        return (
            "## Unit E1U01\n"
            "- 时长: 4s\n"
            "- 画面: 沿路线出发，街景、路牌和目的地方向清晰可见。\n"
            "- 镜头: 稳定步行视角，轻微推进。\n"
            "- 旁白: 用导游口吻介绍下一段路线。"
        )
    if "scene" in lowered or "情景剧" in prompt or "短剧" in prompt:
        return (
            "## Scene E1S01\n"
            "- 时长: 4s\n"
            "- 场景: 城市路口\n"
            "- 角色: 林遥\n"
            "- 动作: 林遥拿起红色行李箱，面对镜头说出下一步计划。"
        )
    return (
        "## Segment E1S01\n"
        "- 时长: 4s\n"
        "- 旁白: 林遥来到城市路口，故事从一个明确目标开始。\n"
        "- 画面: 红色行李箱、路牌和清晰的行动方向。"
    )


def _structured_response(schema: dict | type, prompt: str) -> dict[str, Any]:
    schema_name = getattr(schema, "__name__", "")
    if schema_name == "ProjectOverview":
        return {
            "synopsis": "林遥带着红色行李箱来到城市路口，准备完成一次路线明确的任务。冲突来自时间压力和路线选择，结尾留下下一步行动。",
            "genre": "QA短剧",
            "theme": "目标、选择与行动",
            "world_setting": "现代城市街区，街道路牌清晰，适合竖屏短剧、横屏情景剧和旅游路线视频复用。",
        }
    if schema_name == "GeneratedCharactersResult":
        return {
            "characters": [
                {
                    "name": "林遥",
                    "description": "年轻行动派主角，穿浅色外套，携带红色行李箱，目标明确，表情有紧迫感。",
                    "voice_style": "清楚、坚定、带一点导游式提示感",
                }
            ]
        }
    if schema_name == "GeneratedScenesResult":
        return {
            "scenes": [
                {
                    "name": "城市路口",
                    "description": "有清晰路牌、人行道、街边建筑和开阔转角的现代城市路口，适合路线推进和人物对话。",
                }
            ]
        }
    if schema_name == "GeneratedPropsResult":
        return {
            "props": [
                {
                    "name": "红色行李箱",
                    "description": "中号红色硬壳行李箱，带可伸缩拉杆，是主角行动目标和旅行线索的视觉锚点。",
                }
            ]
        }
    if schema_name == "NarrationEpisodeScript":
        return _narration_script()
    if schema_name == "DramaEpisodeScript":
        return _drama_script()
    if schema_name == "ReferenceVideoScript":
        return _reference_video_script()
    return _example_from_schema(resolve_schema(schema))


def _composition() -> dict[str, str]:
    return {
        "shot_type": "Medium Shot",
        "lighting": "soft daylight from storefront windows",
        "ambiance": "clear, practical QA production frame",
    }


def _image_prompt(scene: str) -> dict[str, Any]:
    return {"scene": scene, "composition": _composition()}


def _video_prompt(action: str) -> dict[str, Any]:
    return {
        "action": action,
        "camera_motion": "Tracking Shot",
        "ambiance_audio": "natural city ambience, footsteps, no background music",
        "dialogue": [{"speaker": "林遥", "line": "我们从这里出发。"}],
    }


def _generated_assets() -> dict[str, Any]:
    return {
        "storyboard_image": None,
        "storyboard_last_image": None,
        "grid_id": None,
        "grid_cell_index": None,
        "video_clip": None,
        "video_uri": None,
        "status": "pending",
    }


def _narration_script() -> dict[str, Any]:
    return {
        "title": "QA旁白测试集",
        "content_mode": "narration",
        "duration_seconds": 4,
        "summary": "林遥从城市路口出发，明确目标并推进路线。",
        "novel": {"title": "QA素材", "chapter": "第1集"},
        "segments": [
            {
                "segment_id": "E1S01",
                "duration_seconds": 4,
                "segment_break": True,
                "novel_text": "林遥站在城市路口，拉起红色行李箱，准备出发。",
                "characters_in_segment": ["林遥"],
                "scenes": ["城市路口"],
                "props": ["红色行李箱"],
                "image_prompt": _image_prompt("林遥站在城市路口，红色行李箱在身旁，路牌清晰可见。"),
                "video_prompt": _video_prompt("林遥拉起行李箱向前走，镜头跟随一步。"),
                "transition_to_next": "cut",
                "note": "QA fake narration segment",
                "generated_assets": _generated_assets(),
            }
        ],
    }


def _drama_script() -> dict[str, Any]:
    return {
        "title": "QA剧情测试集",
        "content_mode": "drama",
        "duration_seconds": 4,
        "summary": "林遥在城市路口做出行动决定。",
        "novel": {"title": "QA素材", "chapter": "第1集"},
        "scenes": [
            {
                "scene_id": "E1S01",
                "duration_seconds": 4,
                "segment_break": True,
                "scene_type": "剧情",
                "characters_in_scene": ["林遥"],
                "scenes": ["城市路口"],
                "props": ["红色行李箱"],
                "image_prompt": _image_prompt("林遥在城市路口看向前方，红色行李箱位于画面前景。"),
                "video_prompt": _video_prompt("林遥停顿后推着行李箱向前走，镜头稳定跟拍。"),
                "transition_to_next": "cut",
                "note": "QA fake drama scene",
                "generated_assets": _generated_assets(),
            }
        ],
    }


def _reference_video_script() -> dict[str, Any]:
    return {
        "title": "QA旅游路线测试集",
        "content_mode": "reference_video",
        "duration_seconds": 4,
        "summary": "沿城市路线出发，结合参考图保持街景和方向感。",
        "novel": {"title": "QA素材", "chapter": "第1集"},
        "video_units": [
            {
                "unit_id": "E1U01",
                "shots": [
                    {
                        "duration": 4,
                        "text": "从城市路口出发，路牌、街景和行进方向清晰，导游口播提示下一段路线。",
                    }
                ],
                "references": [],
                "duration_seconds": 4,
                "duration_override": False,
                "transition_to_next": "cut",
                "note": "QA fake reference-video unit",
                "generated_assets": _generated_assets(),
            }
        ],
    }


def _example_from_schema(schema: dict[str, Any]) -> Any:
    if "const" in schema:
        return schema["const"]
    if "enum" in schema and schema["enum"]:
        return schema["enum"][0]
    for key in ("anyOf", "oneOf"):
        options = schema.get(key)
        if isinstance(options, list) and options:
            non_null = next((item for item in options if item.get("type") != "null"), options[0])
            return _example_from_schema(non_null)

    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        schema_type = next((item for item in schema_type if item != "null"), schema_type[0])

    if schema_type == "object" or "properties" in schema:
        return {
            name: _example_from_schema(prop_schema) for name, prop_schema in (schema.get("properties") or {}).items()
        }
    if schema_type == "array":
        return [_example_from_schema(schema.get("items") or {"type": "string"})]
    if schema_type == "integer":
        return int(schema.get("minimum", 1))
    if schema_type == "number":
        return float(schema.get("minimum", 1.0))
    if schema_type == "boolean":
        return False
    if schema_type == "null":
        return None
    return "QA fake value"
