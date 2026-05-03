"""Deterministic video backend for local QA flows."""

from __future__ import annotations

import asyncio
import hashlib
import re
from pathlib import Path
from typing import Any

from lib.video_backends.base import (
    VideoCapabilities,
    VideoCapability,
    VideoGenerationRequest,
    VideoGenerationResult,
)

_FAIL_MARKERS = ("[qa-fake:fail]", "QA_FAKE_FAIL")


class QAFakeVideoBackend:
    """A no-network video backend that writes tiny valid MP4 files with ffmpeg."""

    def __init__(self, model: str | None = None, **_: Any) -> None:
        self._model = model or "qa-fake-video"

    @property
    def name(self) -> str:
        return "qa-fake"

    @property
    def model(self) -> str:
        return self._model

    @property
    def capabilities(self) -> set[VideoCapability]:
        return {
            VideoCapability.TEXT_TO_VIDEO,
            VideoCapability.IMAGE_TO_VIDEO,
            VideoCapability.GENERATE_AUDIO,
            VideoCapability.SEED_CONTROL,
        }

    @property
    def video_capabilities(self) -> VideoCapabilities:
        return VideoCapabilities(first_frame=True, last_frame=True, reference_images=True, max_reference_images=10)

    async def generate(self, request: VideoGenerationRequest) -> VideoGenerationResult:
        _raise_if_forced_failure(request.prompt)
        await _sleep_if_requested(request.prompt)
        await _write_placeholder_video(request)
        return VideoGenerationResult(
            video_path=request.output_path,
            provider=self.name,
            model=self.model,
            duration_seconds=request.duration_seconds,
            video_uri=f"qa-fake://{request.output_path.name}",
            usage_tokens=max(1, request.duration_seconds) * 100,
            generate_audio=request.generate_audio,
            seed=request.seed,
        )


def _raise_if_forced_failure(prompt: str) -> None:
    if any(marker in prompt for marker in _FAIL_MARKERS):
        raise RuntimeError("QA fake forced failure")


async def _sleep_if_requested(prompt: str) -> None:
    match = re.search(r"\[qa-fake:sleep:(\d+(?:\.\d+)?)\]", prompt)
    if not match:
        return
    await asyncio.sleep(min(float(match.group(1)), 5.0))


def _dimensions(aspect_ratio: str) -> tuple[int, int]:
    ratio = (aspect_ratio or "").strip()
    if ratio == "16:9":
        return 640, 360
    if ratio == "9:16":
        return 360, 640
    return 512, 512


async def _write_placeholder_video(request: VideoGenerationRequest) -> None:
    output_path = Path(request.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    width, height = _dimensions(request.aspect_ratio)
    digest = hashlib.sha256(request.prompt.encode("utf-8")).digest()
    color = f"0x{digest[0]:02x}{digest[1]:02x}{digest[2]:02x}"
    # Keep the generated file short so QA suites stay fast while preserving the
    # requested duration in VideoGenerationResult for billing and metadata paths.
    synthetic_duration = min(max(float(request.duration_seconds or 1), 0.5), 1.0)
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"color=c={color}:s={width}x{height}:d={synthetic_duration}:r=12",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(output_path),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    if proc.returncode != 0 or not output_path.exists():
        raise RuntimeError("QA fake video generation failed: ffmpeg could not create placeholder mp4")
