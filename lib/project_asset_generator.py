"""LLM-driven asset extraction: characters / scenes / props / overview / episode draft.

Extracted from ``ProjectManager`` so the file stops being a god class.
``ProjectManager`` retains thin wrapper methods that delegate here, so all
existing callers (routers, agent skills, tests) keep working unchanged.

Access to project storage is done through the supplied ``ProjectManager``
instance — this class owns no filesystem or DB state of its own.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import TYPE_CHECKING

from lib.asset_types import ASSET_SPECS
from lib.content_workflows import format_workflow_context, get_workflow_preset
from lib.db.base import DEFAULT_USER_ID
from lib.project_models import (
    GeneratedCharactersResult,
    GeneratedPropsResult,
    GeneratedScenesResult,
    ProjectOverview,
)

if TYPE_CHECKING:
    from lib.project_manager import ProjectManager

logger = logging.getLogger(__name__)


class ProjectAssetGenerator:
    """LLM-driven asset extraction collaborator for ``ProjectManager``."""

    def __init__(self, pm: ProjectManager) -> None:
        self.pm = pm

    # ==================== prompt material helpers ====================

    @staticmethod
    def _normalize_generated_asset_name(name: str) -> str:
        """清理模型返回的资产名称，避免编号、换行和路径分隔符进入项目资产 key。"""
        normalized = re.sub(r"\s+", " ", str(name or "")).strip(" \t\r\n\"'`:-：，,")
        normalized = re.sub(r"^\d+[.、)\s]+", "", normalized).strip()
        normalized = re.sub(r"[/\\]+", " ", normalized)
        normalized = re.sub(r"\s+", " ", normalized).strip(" \t\r\n\"'`:-：，,")
        return normalized[:40]

    @staticmethod
    def _overview_material(project: dict) -> str:
        """把已有 overview 转成可供角色抽取的素材块。"""
        overview = project.get("overview") or {}
        if not isinstance(overview, dict):
            return ""
        fields = [
            ("故事梗概", overview.get("synopsis")),
            ("题材类型", overview.get("genre")),
            ("核心主题", overview.get("theme")),
            ("世界观", overview.get("world_setting")),
        ]
        lines = [f"{label}: {str(value).strip()}" for label, value in fields if str(value or "").strip()]
        return "\n".join(lines)

    @staticmethod
    def _existing_asset_block(project: dict, bucket_key: str) -> str:
        bucket = project.get(bucket_key) or {}
        lines = [
            f"- {name}: {str(data.get('description') or '').strip() or '暂无描述'}"
            for name, data in sorted(bucket.items())
            if isinstance(data, dict)
        ]
        return "\n".join(lines) if lines else "暂无"

    @staticmethod
    def _asset_prompt_block(title: str, assets: dict) -> str:
        lines = [
            f"- {name}: {str(data.get('description') or '').strip() or '暂无描述'}"
            for name, data in sorted((assets or {}).items())
            if isinstance(data, dict)
        ]
        return f"{title}:\n" + ("\n".join(lines) if lines else "暂无")

    @staticmethod
    def _clip_prompt_text(text: str, limit: int = 1400) -> str:
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) <= limit:
            return text
        return text[:limit].rstrip() + "..."

    @staticmethod
    def _episode_draft_filename(project: dict, episode_entry: dict | None = None) -> str:
        """按项目/集级模式解析 Step1 草稿文件名。"""
        from lib.project_manager import effective_mode

        episode = episode_entry or {}
        gen_mode = effective_mode(project=project, episode=episode)
        if gen_mode == "reference_video":
            return "step1_reference_units.md"
        if project.get("content_mode") == "narration":
            return "step1_segments.md"
        return "step1_normalized_script.md"

    @staticmethod
    def _episode_draft_prompt_requirements(project: dict, episode: int) -> str:
        from lib.project_manager import effective_mode

        gen_mode = effective_mode(project=project, episode={"episode": episode})
        if gen_mode == "reference_video":
            return (
                "请输出 reference_video 模式的 Step1 Markdown，用 ## Unit E{episode}U01 这类小节组织。"
                "每个 Unit 要包含剧情目的、画面内容、镜头运动、时长建议、角色/场景/道具引用。"
            )
        if project.get("content_mode") == "narration":
            return (
                "请输出口播/旁白模式的 Step1 Markdown，用 ## Segment E{episode}S01 这类小节组织。"
                "每段只承载一个叙事信息点，包含旁白要点、画面内容、时长建议、角色/场景/道具引用。"
            )
        return (
            "请输出剧情/情景剧模式的 Step1 Markdown，用 ## Scene E{episode}S01 这类小节组织。"
            "每场包含场景、出场角色、动作/对白节奏、画面调度、时长建议、关键道具。"
        )

    def _asset_generation_material(self, project_name: str, project: dict) -> tuple[str, str]:
        """读取项目素材；source 为空时回退 overview。返回 (source_type, text)。"""
        source_content = self.pm._read_source_files(project_name)
        if source_content:
            return "source", source_content
        return "overview", self._overview_material(project)

    def _merge_generated_assets(
        self,
        project_name: str,
        asset_type: str,
        generated: dict[str, dict],
    ) -> dict:
        """把生成资产合并进 project.json：新增缺失项，只补齐已有项的空描述。"""
        spec = ASSET_SPECS[asset_type]
        stats = {"added": 0, "updated": 0, "skipped": 0}

        def _mutate(data: dict) -> None:
            bucket = data.setdefault(spec.bucket_key, {})
            for name, entry in generated.items():
                existing = bucket.get(name)
                if existing is None:
                    bucket[name] = self.pm._build_asset_entry(asset_type, entry.get("description", ""), entry)
                    stats["added"] += 1
                    continue

                if not isinstance(existing, dict):
                    stats["skipped"] += 1
                    continue

                existing.setdefault(spec.sheet_field, "")
                for field in spec.extra_string_fields:
                    existing.setdefault(field, "")

                changed = False
                if not str(existing.get("description") or "").strip() and entry.get("description"):
                    existing["description"] = entry["description"]
                    changed = True
                for field in spec.extra_string_fields:
                    if not str(existing.get(field) or "").strip() and entry.get(field):
                        existing[field] = entry[field]
                        changed = True

                if changed:
                    stats["updated"] += 1
                else:
                    stats["skipped"] += 1

        self.pm.update_project(project_name, _mutate)
        return stats

    def _episode_continuity_block(self, project_name: str, project: dict, target_episode: int) -> str:
        """汇总目标集之前的剧本/草稿，供续写分集草稿时保持连续性。"""
        previous_entries: list[str] = []
        project_dir = self.pm.get_project_path(project_name)
        episodes = sorted(
            [
                ep
                for ep in (project.get("episodes") or [])
                if isinstance(ep, dict) and isinstance(ep.get("episode"), int) and ep["episode"] < target_episode
            ],
            key=lambda ep: ep["episode"],
        )

        for ep in episodes[-6:]:
            ep_no = ep["episode"]
            title = str(ep.get("title") or f"第 {ep_no} 集")
            lines = [f"### 第 {ep_no} 集：{title}"]
            script_file = str(ep.get("script_file") or "").strip()
            script: dict | None = None
            if script_file:
                try:
                    script = self.pm.load_script(project_name, script_file)
                except FileNotFoundError:
                    script = None

            if script:
                summary = str(script.get("summary") or "").strip()
                if summary:
                    lines.append(f"- 剧情摘要：{self._clip_prompt_text(summary, 700)}")
                if script.get("content_mode") == "reference_video":
                    units = script.get("video_units") or []
                    for unit in units[:6]:
                        shots = unit.get("shots") or []
                        shot_text = " / ".join(
                            str(shot.get("text") or "").strip() for shot in shots if isinstance(shot, dict)
                        )
                        if shot_text:
                            lines.append(f"- {unit.get('unit_id', 'Unit')}：{self._clip_prompt_text(shot_text, 260)}")
                elif script.get("content_mode") == "narration":
                    for segment in (script.get("segments") or [])[:6]:
                        text = str(segment.get("novel_text") or segment.get("note") or "").strip()
                        if text:
                            lines.append(f"- {segment.get('segment_id', 'Segment')}：{self._clip_prompt_text(text, 260)}")
                else:
                    for scene in (script.get("scenes") or [])[:6]:
                        desc = str(scene.get("scene_type") or scene.get("note") or scene.get("image_prompt") or "").strip()
                        if desc:
                            lines.append(f"- {scene.get('scene_id', 'Scene')}：{self._clip_prompt_text(desc, 260)}")
            else:
                draft_filename = self._episode_draft_filename(project, ep)
                draft_path = project_dir / "drafts" / f"episode_{ep_no}" / draft_filename
                if not draft_path.exists():
                    draft_path = next((project_dir / "drafts" / f"episode_{ep_no}").glob("step1_*.md"), None)
                if draft_path and draft_path.exists():
                    draft_text = draft_path.read_text(encoding="utf-8").strip()
                    if draft_text:
                        lines.append(f"- 草稿摘录：{self._clip_prompt_text(draft_text)}")

            previous_entries.append("\n".join(lines))

        return "\n\n".join(previous_entries) if previous_entries else "暂无"

    # ==================== async generators ====================

    async def generate_episode_draft(
        self,
        project_name: str,
        episode: int = 1,
        *,
        user_id: str = DEFAULT_USER_ID,
    ) -> dict:
        """从项目素材生成第 N 集 Step1 草稿，并确保 project.json 有对应 episode 条目。"""
        from .text_backends.base import TextGenerationRequest, TextTaskType
        from .text_generator import TextGenerator

        if episode < 1:
            raise ValueError("集数必须大于等于 1")

        project = self.pm.load_project(project_name)
        material_source, material = self._asset_generation_material(project_name, project)
        if not material:
            raise ValueError("source 目录为空且项目概述为空，无法生成分集草稿")

        workflow_context = format_workflow_context(
            get_workflow_preset(project.get("content_type")),
            phase="script",
            travel_video_settings=project.get("travel_video_settings"),
        )
        overview_block = self._overview_material(project) or "暂无"
        continuity_block = self._episode_continuity_block(project_name, project, episode)
        assets_block = "\n\n".join(
            [
                self._asset_prompt_block("角色库", project.get("characters") or {}),
                self._asset_prompt_block("场景库", project.get("scenes") or {}),
                self._asset_prompt_block("道具库", project.get("props") or {}),
            ]
        )
        workflow_block = f"\n\n<workflow>\n{workflow_context}\n</workflow>" if workflow_context else ""
        prompt = (
            f"请为项目生成第 {episode} 集 Step1 中间草稿，只返回 Markdown，不要返回 JSON。"
            "这份草稿会继续交给 JSON 剧本生成器使用，所以结构要清晰、编号稳定、可编辑。"
            f"{self._episode_draft_prompt_requirements(project, episode)}"
            "尽量复用已有角色、场景、道具名称；不要凭空引入大量新资产。"
            "第 2 集及以后必须承接 previous_episodes，避免重复已经发生过的剧情。"
            "如果素材较长，只截取适合这一集的开端或一个完整剧情节点。"
            f"{workflow_block}\n\n<overview>\n{overview_block}\n</overview>"
            f"\n\n<previous_episodes>\n{continuity_block}\n</previous_episodes>"
            f"\n\n<assets>\n{assets_block}\n</assets>"
            f"\n\n<material source=\"{material_source}\">\n{material}\n</material>"
        )

        generator = await TextGenerator.create(TextTaskType.SCRIPT, project_name, user_id=user_id)
        result = await generator.generate(
            TextGenerationRequest(prompt=prompt, max_output_tokens=16000),
            project_name=project_name,
        )
        draft_text = result.text.strip()
        if not draft_text:
            raise ValueError("未能生成分集草稿")

        script_file = f"scripts/episode_{episode}.json"
        episode_entry = {"episode": episode, "title": f"第 {episode} 集", "script_file": script_file}
        draft_filename = self._episode_draft_filename(project, episode_entry)
        project_dir = self.pm.get_project_path(project_name)
        draft_dir = project_dir / "drafts" / f"episode_{episode}"
        draft_dir.mkdir(parents=True, exist_ok=True)
        draft_path = draft_dir / draft_filename
        draft_path.write_text(draft_text, encoding="utf-8")

        def _mutate(data: dict) -> None:
            episodes = data.setdefault("episodes", [])
            existing = next((ep for ep in episodes if ep.get("episode") == episode), None)
            if existing is None:
                episodes.append(episode_entry)
            else:
                existing.setdefault("title", episode_entry["title"])
                existing.setdefault("script_file", episode_entry["script_file"])
            episodes.sort(key=lambda ep: ep.get("episode", 0))

        self.pm.update_project(project_name, _mutate)
        return {
            "episode": episode,
            "title": episode_entry["title"],
            "script_file": script_file,
            "draft_path": draft_path.relative_to(project_dir).as_posix(),
            "content": draft_text,
            "source": material_source,
        }

    async def generate_characters(self, project_name: str, *, user_id: str = DEFAULT_USER_ID) -> dict:
        """使用文本模型从项目素材中生成/补全角色库。"""
        from .text_backends.base import TextGenerationRequest, TextTaskType
        from .text_generator import TextGenerator

        project = self.pm.load_project(project_name)
        material_source, source_content = self._asset_generation_material(project_name, project)
        if not source_content:
            raise ValueError("source 目录为空且项目概述为空，无法生成角色")

        workflow_context = format_workflow_context(
            get_workflow_preset(project.get("content_type")),
            phase="overview",
            travel_video_settings=project.get("travel_video_settings"),
        )
        existing_block = self._existing_asset_block(project, "characters")
        workflow_block = f"\n\n<workflow>\n{workflow_context}\n</workflow>" if workflow_context else ""
        existing_section = f"\n\n<existing_characters>\n{existing_block}\n</existing_characters>"
        prompt = (
            "请从项目素材中生成角色库。"
            "只抽取会反复出现、会影响剧情推进或需要保持视觉一致性的主要角色；"
            "不要把路人、群演、纯道具或没有明确身份的人物写入角色库。"
            "每个角色的 description 要适合后续生成角色设定图，包含身份、人际关系、目标动机、"
            "年龄感、气质、服装/外观关键词；voice_style 写一句可用于配音或台词风格的口吻。"
            "如果已有角色存在，请避免重复命名；可以为已有但描述为空的角色补充信息。"
            f"{workflow_block}{existing_section}\n\n<material source=\"{material_source}\">\n{source_content}\n</material>"
        )

        generator = await TextGenerator.create(TextTaskType.OVERVIEW, project_name, user_id=user_id)
        result = await generator.generate(
            TextGenerationRequest(
                prompt=prompt,
                response_schema=GeneratedCharactersResult,
            ),
            project_name=project_name,
        )
        parsed = GeneratedCharactersResult.model_validate_json(result.text)

        generated: dict[str, dict] = {}
        for item in parsed.characters:
            name = self._normalize_generated_asset_name(item.name)
            description = str(item.description or "").strip()
            voice_style = str(item.voice_style or "").strip()
            if not name or (not description and not voice_style) or name in generated:
                continue
            generated[name] = {
                "description": description,
                "voice_style": voice_style,
            }
        if not generated:
            raise ValueError("未能从素材中识别出可生成的角色")

        stats = self._merge_generated_assets(project_name, "character", generated)
        project = self.pm.load_project(project_name)
        return {
            "characters": project.get("characters", {}),
            "source": material_source,
            **stats,
        }

    async def generate_scenes(self, project_name: str, *, user_id: str = DEFAULT_USER_ID) -> dict:
        """使用文本模型从项目素材中生成/补全场景库。"""
        from .text_backends.base import TextGenerationRequest, TextTaskType
        from .text_generator import TextGenerator

        project = self.pm.load_project(project_name)
        material_source, source_content = self._asset_generation_material(project_name, project)
        if not source_content:
            raise ValueError("source 目录为空且项目概述为空，无法生成场景")

        workflow_context = format_workflow_context(
            get_workflow_preset(project.get("content_type")),
            phase="overview",
            travel_video_settings=project.get("travel_video_settings"),
        )
        workflow_block = f"\n\n<workflow>\n{workflow_context}\n</workflow>" if workflow_context else ""
        existing_section = f"\n\n<existing_scenes>\n{self._existing_asset_block(project, 'scenes')}\n</existing_scenes>"
        prompt = (
            "请从项目素材中生成场景库。"
            "只抽取会反复出现、承担剧情调度或需要保持视觉一致性的主要空间；"
            "不要把一次性镜头、泛泛背景、抽象情绪或角色动作误写成场景。"
            "每个场景的 description 要适合后续生成场景设定图，包含地点功能、空间结构、"
            "时代/地域、陈设、光线、氛围、可拍摄构图和关键视觉元素。"
            "如果已有场景存在，请避免重复命名；可以为已有但描述为空的场景补充信息。"
            f"{workflow_block}{existing_section}\n\n<material source=\"{material_source}\">\n{source_content}\n</material>"
        )

        generator = await TextGenerator.create(TextTaskType.OVERVIEW, project_name, user_id=user_id)
        result = await generator.generate(
            TextGenerationRequest(
                prompt=prompt,
                response_schema=GeneratedScenesResult,
            ),
            project_name=project_name,
        )
        parsed = GeneratedScenesResult.model_validate_json(result.text)

        generated: dict[str, dict] = {}
        for item in parsed.scenes:
            name = self._normalize_generated_asset_name(item.name)
            description = str(item.description or "").strip()
            if not name or not description or name in generated:
                continue
            generated[name] = {"description": description}
        if not generated:
            raise ValueError("未能从素材中识别出可生成的场景")

        stats = self._merge_generated_assets(project_name, "scene", generated)
        project = self.pm.load_project(project_name)
        return {
            "scenes": project.get("scenes", {}),
            "source": material_source,
            **stats,
        }

    async def generate_props(self, project_name: str, *, user_id: str = DEFAULT_USER_ID) -> dict:
        """使用文本模型从项目素材中生成/补全道具库。"""
        from .text_backends.base import TextGenerationRequest, TextTaskType
        from .text_generator import TextGenerator

        project = self.pm.load_project(project_name)
        material_source, source_content = self._asset_generation_material(project_name, project)
        if not source_content:
            raise ValueError("source 目录为空且项目概述为空，无法生成道具")

        workflow_context = format_workflow_context(
            get_workflow_preset(project.get("content_type")),
            phase="overview",
            travel_video_settings=project.get("travel_video_settings"),
        )
        workflow_block = f"\n\n<workflow>\n{workflow_context}\n</workflow>" if workflow_context else ""
        existing_section = f"\n\n<existing_props>\n{self._existing_asset_block(project, 'props')}\n</existing_props>"
        prompt = (
            "请从项目素材中生成道具库。"
            "只抽取会影响剧情、产品展示、人物身份识别或需要保持视觉一致性的关键道具；"
            "不要把普通背景杂物、身体部位、纯概念词或不需要单独设计的物品写入道具库。"
            "每个道具的 description 要适合后续生成道具设定图，包含外观、材质、尺寸感、"
            "使用方式、剧情作用、出现位置和关键可视化细节。"
            "如果已有道具存在，请避免重复命名；可以为已有但描述为空的道具补充信息。"
            f"{workflow_block}{existing_section}\n\n<material source=\"{material_source}\">\n{source_content}\n</material>"
        )

        generator = await TextGenerator.create(TextTaskType.OVERVIEW, project_name, user_id=user_id)
        result = await generator.generate(
            TextGenerationRequest(
                prompt=prompt,
                response_schema=GeneratedPropsResult,
            ),
            project_name=project_name,
        )
        parsed = GeneratedPropsResult.model_validate_json(result.text)

        generated: dict[str, dict] = {}
        for item in parsed.props:
            name = self._normalize_generated_asset_name(item.name)
            description = str(item.description or "").strip()
            if not name or not description or name in generated:
                continue
            generated[name] = {"description": description}
        if not generated:
            raise ValueError("未能从素材中识别出可生成的道具")

        stats = self._merge_generated_assets(project_name, "prop", generated)
        project = self.pm.load_project(project_name)
        return {
            "props": project.get("props", {}),
            "source": material_source,
            **stats,
        }

    async def generate_overview(self, project_name: str, *, user_id: str = DEFAULT_USER_ID) -> dict:
        """使用文本模型从项目素材中生成项目概述。"""
        from .text_backends.base import TextGenerationRequest, TextTaskType
        from .text_generator import TextGenerator

        source_content = self.pm._read_source_files(project_name)
        if not source_content:
            raise ValueError("source 目录为空，无法生成概述")
        project = self.pm.load_project(project_name)
        workflow_context = format_workflow_context(
            get_workflow_preset(project.get("content_type")),
            phase="overview",
            travel_video_settings=project.get("travel_video_settings"),
        )

        generator = await TextGenerator.create(TextTaskType.OVERVIEW, project_name, user_id=user_id)

        workflow_block = f"\n\n<workflow>\n{workflow_context}\n</workflow>" if workflow_context else ""
        prompt = (
            "请分析以下素材，提取项目概述。"
            "如果提供 workflow，请按内容类型识别主线、人物关系、节奏重点和可视频化信息。"
            f"{workflow_block}\n\n<source>\n{source_content}\n</source>"
        )

        result = await generator.generate(
            TextGenerationRequest(
                prompt=prompt,
                response_schema=ProjectOverview,
            ),
            project_name=project_name,
        )

        overview = ProjectOverview.model_validate_json(result.text)
        overview_dict = overview.model_dump()
        overview_dict["generated_at"] = datetime.now().isoformat()

        project["overview"] = overview_dict
        self.pm.save_project(project_name, project)

        logger.info("项目概述已生成并保存")
        return overview_dict


__all__ = ["ProjectAssetGenerator"]
