"""项目相关的 Pydantic 数据模型。

用于 Structured Outputs（LLM 结构化输出）的纯数据模型。
从 ``lib/project_manager.py`` 抽离，便于复用且不再依赖 ProjectManager 实例。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ProjectOverview(BaseModel):
    """项目概述数据模型，用于 Gemini Structured Outputs"""

    synopsis: str = Field(description="故事梗概，200-300字，概括主线剧情")
    genre: str = Field(description="题材类型，如：古装宫斗、现代悬疑、玄幻修仙")
    theme: str = Field(description="核心主题，如：复仇与救赎、成长与蜕变")
    world_setting: str = Field(description="时代背景和世界观设定，100-200字")


class GeneratedCharacterProfile(BaseModel):
    """从项目素材中抽取的角色条目。"""

    name: str = Field(description="角色名称，使用短而稳定的称呼")
    description: str = Field(description="角色身份、人物关系、目标动机和可视化外观关键词")
    voice_style: str = Field(default="", description="角色口吻或声音风格，可为空")


class GeneratedCharactersResult(BaseModel):
    """项目角色生成结果，用于 Structured Outputs。"""

    characters: list[GeneratedCharacterProfile] = Field(description="适合进入角色库的主要角色列表")


class GeneratedSceneProfile(BaseModel):
    """从项目素材中抽取的场景条目。"""

    name: str = Field(description="场景名称，使用短而稳定的空间称呼")
    description: str = Field(description="场景空间、时代/地域、陈设、光线、氛围和可拍摄要点")


class GeneratedScenesResult(BaseModel):
    """项目场景生成结果，用于 Structured Outputs。"""

    scenes: list[GeneratedSceneProfile] = Field(description="适合进入场景库的主要场景列表")


class GeneratedPropProfile(BaseModel):
    """从项目素材中抽取的道具条目。"""

    name: str = Field(description="道具名称，使用短而稳定的称呼")
    description: str = Field(description="道具外观、材质、用途、剧情作用和可视化关键词")


class GeneratedPropsResult(BaseModel):
    """项目道具生成结果，用于 Structured Outputs。"""

    props: list[GeneratedPropProfile] = Field(description="适合进入道具库的关键道具列表")


__all__ = [
    "ProjectOverview",
    "GeneratedCharacterProfile",
    "GeneratedCharactersResult",
    "GeneratedSceneProfile",
    "GeneratedScenesResult",
    "GeneratedPropProfile",
    "GeneratedPropsResult",
]
