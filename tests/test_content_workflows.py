from lib.content_workflows import (
    CONTENT_WORKFLOW_PRESETS,
    format_workflow_context,
    get_workflow_preset,
    is_known_content_type,
    preset_project_defaults,
    require_workflow_preset,
)


def test_content_workflow_presets_cover_expected_types():
    assert set(CONTENT_WORKFLOW_PRESETS) == {
        "scene_sketch",
        "short_drama",
        "fiction_adaptation",
        "narration_story",
        "ad_story",
        "education_sketch",
        "travel_video",
    }
    assert CONTENT_WORKFLOW_PRESETS["scene_sketch"].content_mode == "drama"
    assert CONTENT_WORKFLOW_PRESETS["scene_sketch"].aspect_ratio == "16:9"
    assert CONTENT_WORKFLOW_PRESETS["ad_story"].generation_mode == "reference_video"
    assert CONTENT_WORKFLOW_PRESETS["education_sketch"].content_mode == "narration"
    assert CONTENT_WORKFLOW_PRESETS["travel_video"].generation_mode == "reference_video"
    assert CONTENT_WORKFLOW_PRESETS["short_drama"].default_duration == 8
    assert CONTENT_WORKFLOW_PRESETS["travel_video"].style_template_id == "content_travel_video"


def test_workflow_lookup_and_formatting():
    assert is_known_content_type("short_drama") is True
    assert is_known_content_type("missing") is False
    assert get_workflow_preset(None) is None
    assert require_workflow_preset("short_drama").label == "短剧"

    context = format_workflow_context(get_workflow_preset("short_drama"), phase="script")
    assert "内容类型：短剧" in context
    assert "明确钩子" in context
    assert "content_mode=drama" in context
    assert "default_duration=8s" in context


def test_travel_video_workflow_context_includes_route_settings():
    context = format_workflow_context(
        get_workflow_preset("travel_video"),
        phase="script",
        travel_video_settings={
            "origin": "大阪难波站",
            "destination": "黑门市场",
            "route_source": "reference_images",
            "route_notes": "沿千日前通前进，看到商店街后右转。",
            "target_duration": "custom",
            "custom_duration_seconds": 240,
            "reference_images": ["travel_references/map.png", "travel_references/street.webp"],
            "route_preview": {
                "summary": "Sennichimae Dori",
                "distance_text": "1.2 km",
                "duration_text": "15 mins",
                "nodes": [
                    {
                        "label": "路线节点 1",
                        "instruction": "Head east",
                        "lat": 34.665,
                        "lng": 135.501,
                        "street_view_status": "OK",
                    }
                ],
            },
        },
    )

    assert "旅游视频路线配置" in context
    assert "出发地: 大阪难波站" in context
    assert "目的地: 黑门市场" in context
    assert "路线来源: 多图参考" in context
    assert "目标时长: 任意长度 240s" in context
    assert "路线参考图规则: 可不传；如使用，最多 10 张" in context
    assert "路线参考图: travel_references/map.png, travel_references/street.webp" in context
    assert "已解析路线摘要: Sennichimae Dori" in context
    assert "已解析路线节点: 1. Head east @ 34.665,135.501 街景=OK" in context


def test_preset_project_defaults_returns_full_create_defaults():
    defaults = preset_project_defaults("travel_video")
    assert defaults["content_mode"] == "narration"
    assert defaults["aspect_ratio"] == "16:9"
    assert defaults["generation_mode"] == "reference_video"
    assert defaults["default_duration"] == 8
    assert defaults["style_template_id"] == "content_travel_video"
    assert defaults["travel_video_settings"] == {
        "route_source": "google_street_view",
        "narration_language": "auto",
        "target_duration": "45s",
        "camera_style": "street_walk_turns",
        "narrator_persona": "enthusiastic_guide",
    }
