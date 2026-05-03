from __future__ import annotations

import pytest

from server.services.generation_tasks import _TASK_CHANGE_SPECS, _TASK_EXECUTORS


def test_task_executors_registered_for_reference_video():
    assert "reference_video" in _TASK_EXECUTORS


def test_task_change_specs_registered_for_reference_video():
    spec = _TASK_CHANGE_SPECS.get("reference_video")
    assert spec is not None
    entity_type, action, _label_tpl, include_script_episode = spec
    assert entity_type == "reference_video_unit"
    assert action == "reference_video_ready"
    assert include_script_episode is True


def test_generation_focus_targets_reference_units_and_grid_segments():
    from server.services.generation_tasks import _build_generation_focus

    assert _build_generation_focus(
        "reference_video",
        "E1U2",
        {"script_file": "episode_1.json"},
        1,
    ) == {
        "pane": "episode",
        "episode": 1,
        "anchor_type": "reference-unit",
        "anchor_id": "E1U2",
    }
    assert _build_generation_focus(
        "grid",
        "grid_1",
        {"script_file": "episode_1.json", "scene_ids": ["E1S01", "E1S02"]},
        1,
    ) == {
        "pane": "episode",
        "episode": 1,
        "anchor_type": "segment",
        "anchor_id": "E1S01",
    }


@pytest.mark.asyncio
async def test_execute_generation_task_rejects_unknown_type():
    from server.services.generation_tasks import execute_generation_task

    with pytest.raises(ValueError, match="unsupported task_type"):
        await execute_generation_task(
            {
                "task_type": "unknown_xyz",
                "project_name": "demo",
                "resource_id": "x",
                "payload": {},
            }
        )
