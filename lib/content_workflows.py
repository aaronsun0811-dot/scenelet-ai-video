"""Content-type workflow presets.

These presets are the backend counterpart of the create-project content types.
They keep defaults and prompt guidance in one place so generation can adapt to
short drama, scene sketches, ads, explainers, and narration stories.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

ContentTypeId = Literal[
    "scene_sketch",
    "short_drama",
    "fiction_adaptation",
    "narration_story",
    "ad_story",
    "education_sketch",
    "travel_video",
]

ContentMode = Literal["narration", "drama"]
AspectRatio = Literal["9:16", "16:9"]
GenerationMode = Literal["storyboard", "grid", "reference_video"]


@dataclass(frozen=True)
class ContentWorkflowPreset:
    id: ContentTypeId
    label: str
    content_mode: ContentMode
    aspect_ratio: AspectRatio
    generation_mode: GenerationMode
    default_duration: int
    style_template_id: str
    overview_goal: str
    script_goal: str
    structure_rules: tuple[str, ...]
    visual_rules: tuple[str, ...]
    travel_video_settings: dict[str, str] = field(default_factory=dict)


CONTENT_WORKFLOW_PRESETS: dict[str, ContentWorkflowPreset] = {
    "scene_sketch": ContentWorkflowPreset(
        id="scene_sketch",
        label="情景剧",
        content_mode="drama",
        aspect_ratio="16:9",
        generation_mode="storyboard",
        default_duration=8,
        style_template_id="content_scene_sketch",
        overview_goal="把素材整理成几分钟、多角色、单场景或少量场景推进的生活化情景剧。",
        script_goal="生成适合几分钟情景剧的连续对话分镜，重点是人物关系、生活质感和场面调度。",
        structure_rules=(
            "开场先建立场景、人物关系和当下矛盾，不要直接压缩成短剧式强反转。",
            "每个分镜服务于连续对话和表演节奏，保留角色反应、停顿、眼神和走位。",
            "允许同一场景内多轮对话推进，避免每个分镜都换地点或制造大事件。",
        ),
        visual_rules=(
            "优先横屏多人构图，明确角色站位、坐姿、视线关系和空间层次。",
            "画面应像可拍摄的室内/生活场景，避免过度夸张的商业短剧滤镜。",
        ),
    ),
    "short_drama": ContentWorkflowPreset(
        id="short_drama",
        label="短剧",
        content_mode="drama",
        aspect_ratio="9:16",
        generation_mode="storyboard",
        default_duration=8,
        style_template_id="content_short_drama",
        overview_goal="把素材整理成竖屏连续短剧，突出开场钩子、冲突升级、反转和悬念。",
        script_goal="生成适合竖屏短剧的高密度分镜，重点是强情绪、强冲突和结尾追看。",
        structure_rules=(
            "前 1-2 个分镜必须给出明确钩子：危机、羞辱、误会、秘密或利益冲突。",
            "中段持续升级冲突，尽量让每个分镜都有信息增量或情绪转折。",
            "结尾保留悬念、反转或未解决问题，适合连续分集观看。",
        ),
        visual_rules=(
            "优先竖屏近景和中近景，强调表情、压迫感和角色对峙。",
            "镜头动作要紧凑，避免横向大场面导致手机端主体过小。",
        ),
    ),
    "fiction_adaptation": ContentWorkflowPreset(
        id="fiction_adaptation",
        label="小说改编",
        content_mode="drama",
        aspect_ratio="9:16",
        generation_mode="storyboard",
        default_duration=8,
        style_template_id="content_fiction_adaptation",
        overview_goal="把长文本拆成可连续生产的剧集：人物关系、关键场景、主线矛盾和章节节奏。",
        script_goal="生成小说改编剧集分镜，既保留原文信息，又把心理/叙述转成可拍画面。",
        structure_rules=(
            "优先抽取人物关系、目标、阻碍和秘密，减少无法画面化的纯心理描写。",
            "把大段叙述改成动作、对话、道具和场景信息，不要只复述原文。",
            "每集围绕一个清晰情节节点推进，并为下一集留下人物动机或悬念。",
        ),
        visual_rules=(
            "镜头要明确时代、地点、身份和关键道具，帮助小说信息视觉化。",
            "人物初次登场时突出可复用外观特征，便于后续角色一致性。",
        ),
    ),
    "narration_story": ContentWorkflowPreset(
        id="narration_story",
        label="口播故事",
        content_mode="narration",
        aspect_ratio="9:16",
        generation_mode="storyboard",
        default_duration=8,
        style_template_id="content_narration_story",
        overview_goal="把素材整理成旁白驱动的故事短片，突出叙事线、情绪变化和可视化节点。",
        script_goal="生成旁白驱动的画面分段，让画面跟随叙述节奏而不是角色连续表演。",
        structure_rules=(
            "保留原文叙述信息，按旁白节奏拆成清晰段落。",
            "每段只承载一个叙事信息点，避免一个视频片段塞入多个时间跳跃。",
            "有对话时只保留关键台词，其他信息用可视画面配合旁白表达。",
        ),
        visual_rules=(
            "画面要主体明确、氛围干净，适合搭配旁白。",
            "避免复杂多人调度，优先可理解的情绪画面、关键物件和场景象征。",
        ),
    ),
    "ad_story": ContentWorkflowPreset(
        id="ad_story",
        label="广告剧情",
        content_mode="drama",
        aspect_ratio="9:16",
        generation_mode="reference_video",
        default_duration=8,
        style_template_id="content_ad_story",
        overview_goal="把素材整理成产品/服务驱动的剧情广告：痛点、冲突、产品入场、卖点和转化动作。",
        script_goal="生成广告剧情短片分镜，让产品自然进入冲突并解决问题，避免硬广堆卖点。",
        structure_rules=(
            "先建立用户痛点或冲突，再让产品/服务作为剧情解决方案出现。",
            "每个卖点必须通过角色动作、结果变化或对话体现，不要写成说明书。",
            "结尾给出清晰记忆点或行动暗示，但不要破坏剧情真实感。",
        ),
        visual_rules=(
            "产品出现时要说明位置、手部动作、使用场景和可见细节。",
            "画面保持商业级干净光线，避免杂乱背景削弱产品识别。",
        ),
    ),
    "education_sketch": ContentWorkflowPreset(
        id="education_sketch",
        label="知识小剧场",
        content_mode="narration",
        aspect_ratio="16:9",
        generation_mode="storyboard",
        default_duration=8,
        style_template_id="content_education_sketch",
        overview_goal="把素材整理成用角色互动讲清知识点的小剧场：问题、解释、例子和总结。",
        script_goal="生成知识小剧场分段，重点是讲解清晰、例子具体、角色互动自然。",
        structure_rules=(
            "先提出具体问题或误区，再用角色对话/演示拆解知识点。",
            "每段只讲一个知识点，必要时用白板、道具或类比辅助理解。",
            "结尾要有一句清晰总结，帮助观众记住核心结论。",
        ),
        visual_rules=(
            "优先横屏教学构图，保留白板、桌面道具或演示空间。",
            "画面信息层次要清晰，避免装饰元素抢走知识点。",
        ),
    ),
    "travel_video": ContentWorkflowPreset(
        id="travel_video",
        label="旅游视频",
        content_mode="narration",
        aspect_ratio="16:9",
        generation_mode="reference_video",
        default_duration=8,
        style_template_id="content_travel_video",
        overview_goal="把出发地、目的地、路线节点和讲解人设整理成可生成的旅游路线视频。",
        script_goal="生成沿路线推进的旅游视频分镜，结合街景/地图参考、导游口播、转向提示和目的地亮点。",
        structure_rules=(
            "先明确出发地、目的地、路线来源和关键途经点；缺少地图数据时允许使用用户手动填写的路线说明或多图参考。",
            "按路径节点推进镜头：出发、沿途转向/地标、接近目的地、抵达总结，避免跳跃式地点切换。",
            "讲解内容要像真实导游或城市向导，包含方向提示、观察点和轻量背景信息。",
        ),
        visual_rules=(
            "优先横屏街景/步行视角构图，保留道路、路牌、建筑立面和方向感。",
            "如有角色导游，应与街景透视一致，不遮挡关键路标或目的地信息。",
        ),
        travel_video_settings={
            "route_source": "google_street_view",
            "narration_language": "auto",
            "target_duration": "45s",
            "camera_style": "street_walk_turns",
            "narrator_persona": "enthusiastic_guide",
        },
    ),
}

DEFAULT_CONTENT_TYPE: ContentTypeId = "scene_sketch"


def is_known_content_type(content_type: str | None) -> bool:
    return bool(content_type) and content_type in CONTENT_WORKFLOW_PRESETS


def get_workflow_preset(content_type: str | None) -> ContentWorkflowPreset | None:
    if not content_type:
        return None
    return CONTENT_WORKFLOW_PRESETS.get(str(content_type))


def require_workflow_preset(content_type: str) -> ContentWorkflowPreset:
    preset = get_workflow_preset(content_type)
    if preset is None:
        raise KeyError(content_type)
    return preset


def preset_project_defaults(content_type: str | None) -> dict[str, object]:
    """Return project fields that should be applied when a content type is selected.

    This is intentionally data-only so routers, import/migration tools, and future
    workflow setup code can reuse the same defaults without re-encoding business
    rules in UI handlers.
    """
    preset = get_workflow_preset(content_type)
    if preset is None:
        return {}
    defaults: dict[str, object] = {
        "content_type": preset.id,
        "content_mode": preset.content_mode,
        "aspect_ratio": preset.aspect_ratio,
        "generation_mode": preset.generation_mode,
        "default_duration": preset.default_duration,
        "style_template_id": preset.style_template_id,
    }
    if preset.travel_video_settings:
        defaults["travel_video_settings"] = dict(preset.travel_video_settings)
    return defaults


def _format_travel_video_settings(settings: Mapping[str, object] | None) -> str:
    if not isinstance(settings, Mapping):
        return ""

    route_source_labels = {
        "google_street_view": "Google 街景/地图（可选增强）",
        "baidu_maps": "百度地图（可选增强）",
        "amap_maps": "高德地图（可选增强）",
        "manual": "手动路线说明",
        "reference_images": "多图参考",
    }
    target_duration = settings.get("target_duration")
    if target_duration == "custom":
        custom_duration = settings.get("custom_duration_seconds")
        target_duration = f"任意长度 {custom_duration}s" if custom_duration else "任意长度"
    fields = [
        ("出发地", settings.get("origin")),
        ("目的地", settings.get("destination")),
        ("路线来源", route_source_labels.get(str(settings.get("route_source") or ""), settings.get("route_source"))),
        ("讲解语言", settings.get("narration_language")),
        ("目标时长", target_duration),
        ("镜头风格", settings.get("camera_style")),
        ("讲解人设", settings.get("narrator_persona")),
        ("路线/街景补充", settings.get("route_notes")),
        ("角色脚本补充", settings.get("character_notes")),
    ]
    lines = [
        f"- {label}: {str(value).strip()}"
        for label, value in fields
        if value is not None and str(value).strip()
    ]

    raw_refs = settings.get("reference_images")
    if isinstance(raw_refs, list):
        refs = [str(item).strip() for item in raw_refs if isinstance(item, str) and item.strip()][:10]
        lines.append("- 路线参考图规则: 可不传；如使用，最多 10 张，可混合人物/导游、街景、地图和地标图。")
        if refs:
            lines.append(f"- 路线参考图: {', '.join(refs)}")

    preview = settings.get("route_preview")
    if isinstance(preview, Mapping):
        summary = str(preview.get("summary") or "").strip()
        distance = str(preview.get("distance_text") or "").strip()
        duration = str(preview.get("duration_text") or "").strip()
        if summary:
            lines.append(f"- 已解析路线摘要: {summary}")
        if distance or duration:
            lines.append(f"- 已解析路线距离/时长: {distance or '未知'} / {duration or '未知'}")
        raw_nodes = preview.get("nodes")
        if isinstance(raw_nodes, list):
            node_lines: list[str] = []
            for index, node in enumerate(raw_nodes[:8], start=1):
                if not isinstance(node, Mapping):
                    continue
                instruction = str(node.get("instruction") or node.get("label") or "").strip()
                lat = node.get("lat")
                lng = node.get("lng")
                street_status = str(node.get("street_view_status") or "").strip()
                location = f" @ {lat},{lng}" if lat is not None and lng is not None else ""
                street = f" 街景={street_status}" if street_status else ""
                if instruction or location or street:
                    node_lines.append(f"{index}. {instruction}{location}{street}".strip())
            if node_lines:
                lines.append("- 已解析路线节点: " + " | ".join(node_lines))

    if not lines:
        return ""
    return "旅游视频路线配置：\n" + "\n".join(lines)


def format_workflow_context(
    preset: ContentWorkflowPreset | None,
    *,
    phase: Literal["overview", "script"],
    travel_video_settings: Mapping[str, object] | None = None,
) -> str:
    if preset is None:
        return ""

    goal = preset.overview_goal if phase == "overview" else preset.script_goal
    rules = (*preset.structure_rules, *preset.visual_rules)
    rules_text = "\n".join(f"- {rule}" for rule in rules)
    travel_settings_text = (
        "\n" + _format_travel_video_settings(travel_video_settings)
        if preset.id == "travel_video" and travel_video_settings
        else ""
    )
    return f"""内容类型：{preset.label}（{preset.id}）
默认工作流：content_mode={preset.content_mode}, aspect_ratio={preset.aspect_ratio}, generation_mode={preset.generation_mode}, default_duration={preset.default_duration}s, style_template_id={preset.style_template_id}
目标：{goal}
执行规则：
{rules_text}{travel_settings_text}"""
