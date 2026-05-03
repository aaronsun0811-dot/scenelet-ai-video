"""Deterministic image backend for local QA flows."""

from __future__ import annotations

import asyncio
import hashlib
import re
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from lib.image_backends.base import (
    ImageCapability,
    ImageGenerationRequest,
    ImageGenerationResult,
)

_FAIL_MARKERS = ("[qa-fake:fail]", "QA_FAKE_FAIL")


class QAFakeImageBackend:
    """A no-network image backend that writes deterministic placeholder PNGs."""

    def __init__(self, model: str | None = None, **_: Any) -> None:
        self._model = model or "qa-fake-image"

    @property
    def name(self) -> str:
        return "qa-fake"

    @property
    def model(self) -> str:
        return self._model

    @property
    def capabilities(self) -> set[ImageCapability]:
        return {ImageCapability.TEXT_TO_IMAGE, ImageCapability.IMAGE_TO_IMAGE}

    async def generate(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        _raise_if_forced_failure(request.prompt)
        await _sleep_if_requested(request.prompt)
        await asyncio.to_thread(_write_placeholder, request)
        return ImageGenerationResult(
            image_path=request.output_path,
            provider=self.name,
            model=self.model,
            usage_tokens=128,
            text_input_tokens=max(1, len(request.prompt) // 4),
            image_input_tokens=max(0, len(request.reference_images) * 64),
            image_output_tokens=256,
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
        return 1280, 720
    if ratio == "9:16":
        return 720, 1280
    if ratio == "3:4":
        return 768, 1024
    if ratio == "4:3":
        return 1024, 768
    return 1024, 1024


def _write_placeholder(request: ImageGenerationRequest) -> None:
    output_path = Path(request.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    width, height = _dimensions(request.aspect_ratio)
    digest = hashlib.sha256(request.prompt.encode("utf-8")).digest()
    bg = (40 + digest[0] % 80, 52 + digest[1] % 80, 68 + digest[2] % 80)
    accent = (150 + digest[3] % 80, 150 + digest[4] % 80, 150 + digest[5] % 80)
    image = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(image)
    margin = max(24, min(width, height) // 16)
    draw.rectangle((margin, margin, width - margin, height - margin), outline=accent, width=max(4, margin // 8))
    draw.line((margin, height - margin, width - margin, margin), fill=accent, width=max(3, margin // 12))
    label = f"QA FAKE IMAGE\n{request.aspect_ratio}\n{request.project_name or ''}"
    draw.multiline_text((margin * 1.4, margin * 1.4), label, fill=(245, 247, 250), spacing=8)
    image.save(output_path, format="PNG")
