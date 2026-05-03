from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ModelInfo:
    display_name: str
    media_type: str
    capabilities: list[str]
    default: bool = False
    supported_durations: list[int] = field(default_factory=list)
    duration_resolution_constraints: dict[str, list[int]] = field(default_factory=dict)
    resolutions: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ProviderMeta:
    display_name: str
    description: str
    required_keys: list[str]
    optional_keys: list[str] = field(default_factory=list)
    secret_keys: list[str] = field(default_factory=list)
    models: dict[str, ModelInfo] = field(default_factory=dict)

    @property
    def media_types(self) -> list[str]:
        return sorted(set(m.media_type for m in self.models.values()))

    @property
    def capabilities(self) -> list[str]:
        return sorted(set(c for m in self.models.values() for c in m.capabilities))


_OPENAI_COMPAT_OPTIONAL_KEYS = ["base_url"]
_WORKER_OPTIONAL_KEYS = ["image_max_workers", "video_max_workers"]
_GATEWAY_REQUIRED_KEYS = ["api_key", "base_url"]


PROVIDER_REGISTRY: dict[str, ProviderMeta] = {
    "gemini-aistudio": ProviderMeta(
        display_name="AI Studio",
        description="Google AI Studio 提供 Gemini 系列模型，支持图片和视频生成，适合快速原型和个人项目。",
        required_keys=["api_key"],
        optional_keys=["base_url", "image_rpm", "video_rpm", "request_gap", "image_max_workers", "video_max_workers"],
        secret_keys=["api_key"],
        models={
            # --- text ---
            "gemini-3.1-pro-preview": ModelInfo(
                display_name="Gemini 3.1 Pro",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            "gemini-3-flash-preview": ModelInfo(
                display_name="Gemini 3 Flash",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
                default=True,
            ),
            "gemini-3.1-flash-lite-preview": ModelInfo(
                display_name="Gemini 3.1 Flash Lite",
                media_type="text",
                capabilities=["text_generation", "structured_output"],
            ),
            # --- image ---
            "gemini-3-pro-image-preview": ModelInfo(
                display_name="Gemini 3 Pro Image",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                resolutions=["1K", "2K", "4K"],
            ),
            "gemini-3.1-flash-image-preview": ModelInfo(
                display_name="Gemini 3.1 Flash Image",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                default=True,
                resolutions=["1K", "2K", "4K"],
            ),
            # --- video ---
            "veo-3.1-generate-preview": ModelInfo(
                display_name="Veo 3.1",
                media_type="video",
                capabilities=["text_to_video", "image_to_video", "negative_prompt", "video_extend"],
                supported_durations=[4, 6, 8],
                duration_resolution_constraints={"1080p": [8]},
                resolutions=["720p", "1080p"],
            ),
            "veo-3.1-fast-generate-preview": ModelInfo(
                display_name="Veo 3.1 Fast",
                media_type="video",
                capabilities=["text_to_video", "image_to_video", "negative_prompt", "video_extend"],
                supported_durations=[4, 6, 8],
                duration_resolution_constraints={"1080p": [8]},
                resolutions=["720p", "1080p"],
            ),
            "veo-3.1-lite-generate-preview": ModelInfo(
                display_name="Veo 3.1 Lite",
                media_type="video",
                capabilities=["text_to_video", "image_to_video", "negative_prompt", "video_extend"],
                default=True,
                supported_durations=[4, 6, 8],
                duration_resolution_constraints={"1080p": [8]},
                resolutions=["720p", "1080p"],
            ),
        },
    ),
    "gemini-vertex": ProviderMeta(
        display_name="Vertex AI",
        description="Google Cloud Vertex AI 企业级平台，支持 Gemini 和 Imagen 模型，提供更高配额和音频生成能力。",
        required_keys=["credentials_path"],
        optional_keys=["gcs_bucket", "image_rpm", "video_rpm", "request_gap", "image_max_workers", "video_max_workers"],
        secret_keys=[],
        models={
            # --- text ---
            "gemini-3.1-pro-preview": ModelInfo(
                display_name="Gemini 3.1 Pro",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            "gemini-3-flash-preview": ModelInfo(
                display_name="Gemini 3 Flash",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
                default=True,
            ),
            "gemini-3.1-flash-lite-preview": ModelInfo(
                display_name="Gemini 3.1 Flash Lite",
                media_type="text",
                capabilities=["text_generation", "structured_output"],
            ),
            # --- image ---
            "gemini-3-pro-image-preview": ModelInfo(
                display_name="Gemini 3 Pro Image",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                resolutions=["1K", "2K", "4K"],
            ),
            "gemini-3.1-flash-image-preview": ModelInfo(
                display_name="Gemini 3.1 Flash Image",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                default=True,
                resolutions=["1K", "2K", "4K"],
            ),
            # --- video ---
            "veo-3.1-generate-001": ModelInfo(
                display_name="Veo 3.1",
                media_type="video",
                capabilities=["text_to_video", "image_to_video", "generate_audio", "negative_prompt", "video_extend"],
                supported_durations=[4, 6, 8],
                resolutions=["720p", "1080p"],
            ),
            "veo-3.1-fast-generate-001": ModelInfo(
                display_name="Veo 3.1 Fast",
                media_type="video",
                capabilities=["text_to_video", "image_to_video", "generate_audio", "negative_prompt", "video_extend"],
                default=True,
                supported_durations=[4, 6, 8],
                resolutions=["720p", "1080p"],
            ),
        },
    ),
    "ark": ProviderMeta(
        display_name="豆包 / 火山方舟",
        description="字节跳动火山方舟 AI 平台，支持 Seedance 视频生成和 Seedream 图片生成，具备音频生成和种子控制能力。",
        required_keys=["api_key"],
        optional_keys=["video_max_workers", "image_max_workers"],
        secret_keys=["api_key"],
        models={
            # --- text ---
            "doubao-seed-2-0-pro-260215": ModelInfo(
                display_name="豆包 Seed 2.0 Pro",
                media_type="text",
                capabilities=["text_generation", "vision"],
            ),
            "doubao-seed-2-0-lite-260215": ModelInfo(
                display_name="豆包 Seed 2.0 Lite",
                media_type="text",
                capabilities=["text_generation", "vision"],
                default=True,
            ),
            "doubao-seed-2-0-mini-260215": ModelInfo(
                display_name="豆包 Seed 2.0 Mini",
                media_type="text",
                capabilities=["text_generation", "vision"],
            ),
            "doubao-seed-1-8-251228": ModelInfo(
                display_name="豆包 Seed 1.8",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            # --- image ---
            "doubao-seedream-5-0-lite-260128": ModelInfo(
                display_name="Seedream 5.0 Lite",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                default=True,
            ),
            "doubao-seedream-5-0-260128": ModelInfo(
                display_name="Seedream 5.0",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
            ),
            "doubao-seedream-4-5-251128": ModelInfo(
                display_name="Seedream 4.5",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
            ),
            "doubao-seedream-4-0-250828": ModelInfo(
                display_name="Seedream 4.0",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
            ),
            # --- video ---
            "doubao-seedance-1-5-pro-251215": ModelInfo(
                display_name="Seedance 1.5 Pro",
                media_type="video",
                capabilities=["text_to_video", "image_to_video", "generate_audio", "seed_control", "flex_tier"],
                default=True,
                supported_durations=list(range(4, 13)),
                resolutions=["480p", "720p", "1080p"],
            ),
            "doubao-seedance-2-0-260128": ModelInfo(
                display_name="Seedance 2.0",
                media_type="video",
                capabilities=["text_to_video", "image_to_video", "generate_audio", "seed_control", "video_extend"],
                supported_durations=list(range(4, 16)),
                resolutions=["480p", "720p", "1080p"],
            ),
            "doubao-seedance-2-0-fast-260128": ModelInfo(
                display_name="Seedance 2.0 Fast",
                media_type="video",
                capabilities=["text_to_video", "image_to_video", "generate_audio", "seed_control", "video_extend"],
                supported_durations=list(range(4, 16)),
                resolutions=["480p", "720p", "1080p"],
            ),
        },
    ),
    "grok": ProviderMeta(
        display_name="Grok",
        description="xAI Grok 模型，支持视频和图片生成。",
        required_keys=["api_key"],
        optional_keys=["video_max_workers", "image_max_workers"],
        secret_keys=["api_key"],
        models={
            # --- text ---
            "grok-4.20-0309-reasoning": ModelInfo(
                display_name="Grok 4.20 Reasoning",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            "grok-4.20-0309-non-reasoning": ModelInfo(
                display_name="Grok 4.20 Non-Reasoning",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            "grok-4-1-fast-reasoning": ModelInfo(
                display_name="Grok 4.1 Fast Reasoning",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
                default=True,
            ),
            "grok-4-1-fast-non-reasoning": ModelInfo(
                display_name="Grok 4.1 Fast (Non-Reasoning)",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            # --- image ---
            "grok-imagine-image-pro": ModelInfo(
                display_name="Grok Imagine Image Pro",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                resolutions=["1K", "2K"],
            ),
            "grok-imagine-image": ModelInfo(
                display_name="Grok Imagine Image",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                default=True,
                resolutions=["1K", "2K"],
            ),
            # --- video ---
            "grok-imagine-video": ModelInfo(
                display_name="Grok Imagine Video",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                default=True,
                supported_durations=list(range(1, 16)),
                resolutions=["480p", "720p"],
            ),
        },
    ),
    "openai": ProviderMeta(
        display_name="OpenAI",
        description="OpenAI 官方平台，支持 GPT-5.5 / GPT-5.4 文本、GPT Image 2 图片和 Sora 视频生成。",
        required_keys=["api_key"],
        optional_keys=["base_url", "image_max_workers", "video_max_workers"],
        secret_keys=["api_key"],
        models={
            # --- text ---
            "gpt-5.5": ModelInfo(
                display_name="GPT-5.5",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            "gpt-5.4": ModelInfo(
                display_name="GPT-5.4",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            "gpt-5.4-mini": ModelInfo(
                display_name="GPT-5.4 Mini",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
                default=True,
            ),
            "gpt-5.4-nano": ModelInfo(
                display_name="GPT-5.4 Nano",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            # --- image ---
            "gpt-image-2": ModelInfo(
                display_name="GPT Image 2",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                default=True,
                resolutions=["512px", "1K", "2K"],
            ),
            "gpt-image-1.5": ModelInfo(
                display_name="GPT Image 1.5",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                resolutions=["512px", "1K", "2K"],
            ),
            "gpt-image-1-mini": ModelInfo(
                display_name="GPT Image 1 Mini",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                resolutions=["512px", "1K", "2K"],
            ),
            # --- video ---
            "sora-2": ModelInfo(
                display_name="Sora 2",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                default=True,
                supported_durations=[4, 8, 12],
                resolutions=["720p", "1080p"],
            ),
            "sora-2-pro": ModelInfo(
                display_name="Sora 2 Pro",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                supported_durations=[4, 8, 12],
                resolutions=["720p", "1080p"],
            ),
        },
    ),
    "baidu": ProviderMeta(
        display_name="文心一言",
        description="百度智能云千帆 / 文心一言模型，按 OpenAI 兼容接口接入文本生成。",
        required_keys=["api_key"],
        optional_keys=_OPENAI_COMPAT_OPTIONAL_KEYS,
        secret_keys=["api_key"],
        models={
            "ernie-4.5-turbo-128k": ModelInfo(
                display_name="ERNIE 4.5 Turbo",
                media_type="text",
                capabilities=["text_generation", "structured_output"],
                default=True,
            ),
            "ernie-x1-turbo-32k": ModelInfo(
                display_name="ERNIE X1 Turbo",
                media_type="text",
                capabilities=["text_generation", "structured_output"],
            ),
        },
    ),
    "qwen": ProviderMeta(
        display_name="通义千问",
        description="阿里云百炼 / 通义千问 Qwen 系列，按 OpenAI 兼容接口接入文本和视觉理解。",
        required_keys=["api_key"],
        optional_keys=_OPENAI_COMPAT_OPTIONAL_KEYS,
        secret_keys=["api_key"],
        models={
            "qwen-plus": ModelInfo(
                display_name="Qwen Plus",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
                default=True,
            ),
            "qwen-max": ModelInfo(
                display_name="Qwen Max",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            "qwen-vl-plus": ModelInfo(
                display_name="Qwen VL Plus",
                media_type="text",
                capabilities=["text_generation", "vision"],
            ),
        },
    ),
    "zhipu": ProviderMeta(
        display_name="智谱 GLM",
        description="智谱 AI GLM 系列，按 OpenAI 兼容接口接入文本、结构化输出和视觉理解。",
        required_keys=["api_key"],
        optional_keys=_OPENAI_COMPAT_OPTIONAL_KEYS,
        secret_keys=["api_key"],
        models={
            "glm-4.5": ModelInfo(
                display_name="GLM-4.5",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
                default=True,
            ),
            "glm-4.5-air": ModelInfo(
                display_name="GLM-4.5 Air",
                media_type="text",
                capabilities=["text_generation", "structured_output"],
            ),
            "glm-4v-plus": ModelInfo(
                display_name="GLM-4V Plus",
                media_type="text",
                capabilities=["text_generation", "vision"],
            ),
        },
    ),
    "deepseek": ProviderMeta(
        display_name="DeepSeek",
        description="DeepSeek 官方 / 兼容接口，支持通用对话和推理模型。",
        required_keys=["api_key"],
        optional_keys=_OPENAI_COMPAT_OPTIONAL_KEYS,
        secret_keys=["api_key"],
        models={
            "deepseek-chat": ModelInfo(
                display_name="DeepSeek Chat",
                media_type="text",
                capabilities=["text_generation", "structured_output"],
                default=True,
            ),
            "deepseek-reasoner": ModelInfo(
                display_name="DeepSeek Reasoner",
                media_type="text",
                capabilities=["text_generation", "structured_output", "reasoning"],
            ),
        },
    ),
    "moonshot": ProviderMeta(
        display_name="Kimi",
        description="月之暗面 Kimi / Moonshot 模型，按 OpenAI 兼容接口接入长文本生成。",
        required_keys=["api_key"],
        optional_keys=_OPENAI_COMPAT_OPTIONAL_KEYS,
        secret_keys=["api_key"],
        models={
            "kimi-latest": ModelInfo(
                display_name="Kimi Latest",
                media_type="text",
                capabilities=["text_generation", "structured_output"],
                default=True,
            ),
            "kimi-k2": ModelInfo(
                display_name="Kimi K2",
                media_type="text",
                capabilities=["text_generation", "structured_output", "reasoning"],
            ),
        },
    ),
    "minimax": ProviderMeta(
        display_name="MiniMax",
        description="MiniMax 文本模型与 Hailuo 视频模型；文本按 OpenAI 兼容接口，视频按统一视频网关接入。",
        required_keys=["api_key"],
        optional_keys=["base_url", *_WORKER_OPTIONAL_KEYS],
        secret_keys=["api_key"],
        models={
            "minimax-text-01": ModelInfo(
                display_name="MiniMax Text-01",
                media_type="text",
                capabilities=["text_generation", "structured_output"],
                default=True,
            ),
            "minimax-m1": ModelInfo(
                display_name="MiniMax M1",
                media_type="text",
                capabilities=["text_generation", "structured_output", "reasoning"],
            ),
            "hailuo-02": ModelInfo(
                display_name="Hailuo 02",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                default=True,
                supported_durations=[6, 10],
                resolutions=["720p", "1080p"],
            ),
        },
    ),
    "hunyuan": ProviderMeta(
        display_name="腾讯混元",
        description="腾讯混元 Hunyuan 系列，按 OpenAI 兼容接口接入文本生成。",
        required_keys=["api_key"],
        optional_keys=_OPENAI_COMPAT_OPTIONAL_KEYS,
        secret_keys=["api_key"],
        models={
            "hunyuan-turbo": ModelInfo(
                display_name="Hunyuan Turbo",
                media_type="text",
                capabilities=["text_generation", "structured_output"],
                default=True,
            ),
            "hunyuan-t1": ModelInfo(
                display_name="Hunyuan T1",
                media_type="text",
                capabilities=["text_generation", "structured_output", "reasoning"],
            ),
        },
    ),
    "anthropic": ProviderMeta(
        display_name="Anthropic Claude",
        description="Anthropic Claude 系列模型，用于官方 Claude 或 Claude 兼容网关。",
        required_keys=["api_key"],
        optional_keys=_OPENAI_COMPAT_OPTIONAL_KEYS,
        secret_keys=["api_key"],
        models={
            "claude-opus-4-7": ModelInfo(
                display_name="Claude Opus 4.7",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision", "reasoning"],
                default=True,
            ),
            "claude-sonnet-4-6": ModelInfo(
                display_name="Claude Sonnet 4.6",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision", "reasoning"],
            ),
            "claude-haiku-4-5-20251001": ModelInfo(
                display_name="Claude Haiku 4.5",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            "claude-sonnet-4-5-20250929": ModelInfo(
                display_name="Claude Sonnet 4.5",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
            ),
            "claude-opus-4-1-20250805": ModelInfo(
                display_name="Claude Opus 4.1",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision", "reasoning"],
            ),
            "claude-opus-4-6": ModelInfo(
                display_name="Claude Opus 4.6",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision", "reasoning"],
            ),
        },
    ),
    "midjourney": ProviderMeta(
        display_name="Midjourney",
        description="Midjourney 图片生成，通过支持 OpenAI Images 兼容格式的网关接入。",
        required_keys=_GATEWAY_REQUIRED_KEYS,
        optional_keys=["image_max_workers"],
        secret_keys=["api_key"],
        models={
            "midjourney-v7": ModelInfo(
                display_name="Midjourney V7",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                default=True,
                resolutions=["1K", "2K"],
            ),
            "midjourney-niji-v7": ModelInfo(
                display_name="Niji V7",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                resolutions=["1K", "2K"],
            ),
        },
    ),
    "luma": ProviderMeta(
        display_name="Luma",
        description="Luma Ray 视频模型，通过统一视频网关 / NewAPI 兼容接口接入。",
        required_keys=_GATEWAY_REQUIRED_KEYS,
        optional_keys=["video_max_workers"],
        secret_keys=["api_key"],
        models={
            "luma-ray-2": ModelInfo(
                display_name="Ray 2",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                default=True,
                supported_durations=[5, 9],
                resolutions=["720p", "1080p"],
            ),
            "luma-ray-flash-2": ModelInfo(
                display_name="Ray Flash 2",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                supported_durations=[5, 9],
                resolutions=["720p"],
            ),
        },
    ),
    "pika": ProviderMeta(
        display_name="Pika",
        description="Pika 视频生成模型，通过统一视频网关 / NewAPI 兼容接口接入。",
        required_keys=_GATEWAY_REQUIRED_KEYS,
        optional_keys=["video_max_workers"],
        secret_keys=["api_key"],
        models={
            "pika-2.2": ModelInfo(
                display_name="Pika 2.2",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                default=True,
                supported_durations=[5, 10],
                resolutions=["720p", "1080p"],
            ),
            "pika-2.1": ModelInfo(
                display_name="Pika 2.1",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                supported_durations=[5, 10],
                resolutions=["720p"],
            ),
        },
    ),
    "runway": ProviderMeta(
        display_name="Runway",
        description="Runway Gen 系列视频模型，通过统一视频网关 / NewAPI 兼容接口接入。",
        required_keys=_GATEWAY_REQUIRED_KEYS,
        optional_keys=["video_max_workers"],
        secret_keys=["api_key"],
        models={
            "runway-gen-4": ModelInfo(
                display_name="Gen-4",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                default=True,
                supported_durations=[5, 10],
                resolutions=["720p", "1080p"],
            ),
            "runway-gen-3-alpha": ModelInfo(
                display_name="Gen-3 Alpha",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                supported_durations=[5, 10],
                resolutions=["720p"],
            ),
        },
    ),
    "kling": ProviderMeta(
        display_name="可灵",
        description="可灵 Kling 视频模型，通过统一视频网关 / NewAPI 兼容接口接入。",
        required_keys=_GATEWAY_REQUIRED_KEYS,
        optional_keys=["video_max_workers"],
        secret_keys=["api_key"],
        models={
            "kling-v2.1-master": ModelInfo(
                display_name="Kling 2.1 Master",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                default=True,
                supported_durations=[5, 10],
                resolutions=["720p", "1080p"],
            ),
            "kling-v2.1": ModelInfo(
                display_name="Kling 2.1",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                supported_durations=[5, 10],
                resolutions=["720p"],
            ),
        },
    ),
    "jimeng": ProviderMeta(
        display_name="即梦",
        description="即梦图片与视频模型，通过 OpenAI Images / NewAPI 兼容网关接入。",
        required_keys=_GATEWAY_REQUIRED_KEYS,
        optional_keys=_WORKER_OPTIONAL_KEYS,
        secret_keys=["api_key"],
        models={
            "jimeng-seedance-2.0-image": ModelInfo(
                display_name="Seedance 2.0 Image",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                default=True,
                resolutions=["1K", "2K"],
            ),
            "jimeng-image-v3": ModelInfo(
                display_name="Jimeng Image V3",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                resolutions=["1K", "2K"],
            ),
            "jimeng-video-v3": ModelInfo(
                display_name="Jimeng Video V3",
                media_type="video",
                capabilities=["text_to_video", "image_to_video"],
                default=True,
                supported_durations=[5, 10],
                resolutions=["720p", "1080p"],
            ),
        },
    ),
    "qa-fake": ProviderMeta(
        display_name="QA Fake",
        description="本地 QA 专用可控假模型，支持文本、图片和视频闭环测试，不访问外部服务。",
        required_keys=["api_key"],
        optional_keys=_WORKER_OPTIONAL_KEYS,
        secret_keys=["api_key"],
        models={
            "qa-fake-text": ModelInfo(
                display_name="QA Fake Text",
                media_type="text",
                capabilities=["text_generation", "structured_output", "vision"],
                default=True,
            ),
            "qa-fake-image": ModelInfo(
                display_name="QA Fake Image",
                media_type="image",
                capabilities=["text_to_image", "image_to_image"],
                default=True,
                resolutions=["1K", "2K", "4K"],
            ),
            "qa-fake-video": ModelInfo(
                display_name="QA Fake Video",
                media_type="video",
                capabilities=["text_to_video", "image_to_video", "generate_audio", "seed_control"],
                default=True,
                supported_durations=[4, 6, 8, 10],
                resolutions=["480p", "720p", "1080p"],
            ),
        },
    ),
}
