from __future__ import annotations

import json

from lib.model_rules import (
    media_rule_key,
    normalize_model_rule_configs,
    render_model_rule_appendix,
    resolve_model_rule_config,
)


def test_normalize_model_rule_configs_keeps_one_rule_source():
    configs = normalize_model_rule_configs(
        {
            "openai/gpt-5.1": {
                "mode": "uploaded_skill",
                "skill_runtime": "claude_code",
                "skill_name": "SKILL.md",
                "skill_content": "# Skill",
                "prompt": "ignore me",
                "skill_github_url": "https://github.com/demo/skill",
            }
        }
    )

    assert configs["openai/gpt-5.1"] == {
        "mode": "uploaded_skill",
        "skill_runtime": "claude_code",
        "skill_name": "SKILL.md",
        "skill_content": "# Skill",
    }


def test_resolve_model_rule_config_falls_back_by_model_id():
    configs = normalize_model_rule_configs(
        json.dumps(
            {
                "anthropic/claude-sonnet-4-7": {
                    "mode": "prompt",
                    "prompt": "use strict screenplay JSON",
                }
            }
        )
    )

    assert resolve_model_rule_config(
        configs,
        "openai",
        "claude-sonnet-4-7",
        backend_name="openai",
    ) == {
        "mode": "prompt",
        "prompt": "use strict screenplay JSON",
    }


def test_resolve_model_rule_config_falls_back_to_media_type():
    configs = normalize_model_rule_configs(
        {
            media_rule_key("image"): {
                "mode": "prompt",
                "prompt": "use global image style",
            }
        }
    )

    assert resolve_model_rule_config(
        configs,
        "gemini",
        "imagen-4",
        media_type="image",
    ) == {
        "mode": "prompt",
        "prompt": "use global image style",
    }


def test_resolve_model_rule_config_uses_media_type_when_model_is_empty():
    configs = normalize_model_rule_configs(
        {
            media_rule_key("video"): {
                "mode": "prompt",
                "prompt": "use default video rules",
            }
        }
    )

    assert resolve_model_rule_config(
        configs,
        "runway",
        "",
        media_type="video",
    ) == {
        "mode": "prompt",
        "prompt": "use default video rules",
    }


def test_resolve_model_rule_config_prefers_specific_model_over_media_type():
    configs = normalize_model_rule_configs(
        {
            media_rule_key("video"): {
                "mode": "prompt",
                "prompt": "use global video style",
            },
            "runway/gen-4": {
                "mode": "prompt",
                "prompt": "use runway-specific rules",
            },
        }
    )

    assert resolve_model_rule_config(
        configs,
        "runway",
        "gen-4",
        media_type="video",
    ) == {
        "mode": "prompt",
        "prompt": "use runway-specific rules",
    }


def test_render_model_rule_appendix_for_skill():
    appendix = render_model_rule_appendix(
        {
            "mode": "github_skill",
            "skill_runtime": "hermes_agent",
            "skill_name": "SKILL.md",
            "skill_github_url": "https://github.com/demo/repo/blob/main/SKILL.md",
            "skill_content": "# Hermes Skill",
        }
    )

    assert 'source="github_skill"' in appendix
    assert 'runtime="hermes_agent"' in appendix
    assert "# Hermes Skill" in appendix


def test_render_model_rule_appendix_escapes_skill_attributes():
    appendix = render_model_rule_appendix(
        {
            "mode": "github_skill",
            "skill_runtime": "openai",
            "skill_name": 'Travel "Guide".md',
            "skill_github_url": "https://github.com/acme/repo/blob/main/skills?a=1&b=2",
            "skill_content": "# Skill",
        }
    )

    assert 'name="Travel &quot;Guide&quot;.md"' in appendix
    assert "a=1&amp;b=2" in appendix
