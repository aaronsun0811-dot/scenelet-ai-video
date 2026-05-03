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
        return _project_overview(prompt)
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
        return _reference_video_script(prompt)
    return _example_from_schema(resolve_schema(schema))


def _project_overview(prompt: str) -> dict[str, str]:
    lowered = prompt.lower()
    origin = _prompt_field(prompt, "出发地") or "出发地"
    destination = _prompt_field(prompt, "目的地") or "目的地"
    route_notes = _prompt_field(prompt, "路线/街景补充")
    is_travel = (
        "travel_video" in lowered
        or "旅游视频" in prompt
        or "路线视频" in prompt
        or "route_source" in lowered
        or ("出发地" in prompt and "目的地" in prompt)
    )
    if is_travel:
        route_summary = route_notes or f"从{origin}出发，沿街景和路牌线索前往{destination}。"
        return {
            "synopsis": f"这是一条从{origin}前往{destination}的 QA 旅游路线视频。内容以出发确认、沿途转向、接近目的地和抵达总结推进，结合参考图保持道路、路牌、人流和入口线索清晰，方便后续生成连续的导游口播镜头。",
            "genre": "QA旅游视频",
            "theme": "路线识别、街景引导与目的地抵达",
            "world_setting": f"现代城市步行街区，路线素材围绕{route_summary}展开，适合横屏或竖屏旅游讲解视频验收。",
        }
    if "scene_drama" in lowered or "情景剧" in prompt:
        return {
            "synopsis": "林遥带着红色行李箱来到城市路口，在一段轻量情景对话中确认目标和下一步行动。冲突来自时间压力与路线选择，结尾以明确决定推动下一场。",
            "genre": "QA情景剧",
            "theme": "对话、选择与行动",
            "world_setting": "现代城市街区，路牌、街角和行李箱构成可复用的情景剧表演空间。",
        }
    return {
        "synopsis": "林遥带着红色行李箱来到城市路口，准备完成一次路线明确的任务。冲突来自时间压力和路线选择，结尾留下下一步行动。",
        "genre": "QA短剧",
        "theme": "目标、选择与行动",
        "world_setting": "现代城市街区，街道路牌清晰，适合竖屏短剧、横屏情景剧和旅游路线视频复用。",
    }


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


def _prompt_field(prompt: str, label: str) -> str:
    match = re.search(rf"[-*]\s*{re.escape(label)}[:：]\s*([^\n\r]+)", prompt)
    return match.group(1).strip() if match else ""


def _target_seconds(prompt: str) -> int:
    patterns = (
        r"目标时长[:：]\s*(?:任意长度\s*)?(\d+)\s*s",
        r"target[_\s-]*duration[^0-9]*(\d+)\s*s",
    )
    for pattern in patterns:
        match = re.search(pattern, prompt, flags=re.IGNORECASE)
        if match:
            return max(4, min(int(match.group(1)), 60))
    return 10


def _shot_durations(total_seconds: int) -> list[int]:
    remaining = max(4, min(total_seconds, 60))
    durations: list[int] = []
    while remaining > 0 and len(durations) < 4:
        duration = min(15, remaining)
        durations.append(duration)
        remaining -= duration
    return durations or [4]


def _reference_video_script(prompt: str) -> dict[str, Any]:
    origin = _prompt_field(prompt, "出发地") or "出发地"
    destination = _prompt_field(prompt, "目的地") or "目的地"
    route_notes = _prompt_field(prompt, "路线/街景补充")
    total_seconds = _target_seconds(prompt)
    durations = _shot_durations(total_seconds)
    shot_templates = [
        f"从{origin}出发，确认路牌和街景方向，导游口播说明前往{destination}的路线。",
        route_notes or f"沿途持续观察道路、路牌和街边建筑，保持向{destination}推进的方向感。",
        f"接近{destination}前，镜头强调转弯、人流和目的地入口线索。",
        f"抵达{destination}，总结从{origin}到{destination}的步行路线和观看提示。",
    ]
    shots = [
        {
            "duration": duration,
            "text": shot_templates[index] if index < len(shot_templates) else shot_templates[-1],
        }
        for index, duration in enumerate(durations)
    ]
    return {
        "title": "QA旅游路线测试集",
        "content_mode": "reference_video",
        "duration_seconds": sum(durations),
        "summary": f"从{origin}前往{destination}，结合参考图保持街景和方向感。",
        "novel": {"title": "QA素材", "chapter": "第1集"},
        "video_units": [
            {
                "unit_id": "E1U01",
                "shots": shots,
                "references": [],
                "duration_seconds": sum(durations),
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
