#!/usr/bin/env python3
"""Configure local QA fake models and grant platform credits."""

from __future__ import annotations

import argparse
import asyncio

from lib.config.service import ConfigService
from lib.db import async_session_factory, init_db
from lib.db.base import PLATFORM_USER_ID
from lib.db.repositories.credential_repository import CredentialRepository
from lib.db.repositories.credit_repository import CreditRepository

QA_TEXT_BACKEND = "qa-fake/qa-fake-text"
QA_IMAGE_BACKEND = "qa-fake/qa-fake-image"
QA_VIDEO_BACKEND = "qa-fake/qa-fake-video"


async def _ensure_credential(user_id: str) -> None:
    async with async_session_factory() as session:
        repo = CredentialRepository(session, user_id=user_id)
        existing = await repo.list_by_provider("qa-fake")
        if existing:
            await repo.activate(existing[0].id, "qa-fake")
        else:
            await repo.create("qa-fake", "QA Fake", api_key="qa-fake")
        await session.commit()


async def _configure_defaults() -> None:
    async with async_session_factory() as session:
        svc = ConfigService(session, user_id=PLATFORM_USER_ID)
        await svc.set_setting("default_text_backend", QA_TEXT_BACKEND)
        await svc.set_setting("text_backend_script", QA_TEXT_BACKEND)
        await svc.set_setting("text_backend_overview", QA_TEXT_BACKEND)
        await svc.set_setting("text_backend_style", QA_TEXT_BACKEND)
        await svc.set_setting("default_image_backend", QA_IMAGE_BACKEND)
        await svc.set_setting("default_video_backend", QA_VIDEO_BACKEND)
        await session.commit()


async def _grant_credits(user_id: str, credits: int) -> None:
    if credits <= 0:
        return
    async with async_session_factory() as session:
        repo = CreditRepository(session, user_id=user_id)
        await repo.add_entry(
            amount=credits,
            kind="admin_grant",
            description="Local QA fake platform credit grant",
            metadata={"source": "setup_qa_fake_platform.py"},
            idempotency_key=f"qa-fake-platform-grant:{user_id}:{credits}",
        )
        await session.commit()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", default="default", help="User receiving local platform QA credits.")
    parser.add_argument("--credits", type=int, default=100_000, help="Credits to grant idempotently to --user-id.")
    parser.add_argument("--skip-init-db", action="store_true", help="Skip DB migration/init before writing settings.")
    args = parser.parse_args()

    if not args.skip_init_db:
        await init_db()

    await _ensure_credential(PLATFORM_USER_ID)
    await _ensure_credential(args.user_id)
    await _configure_defaults()
    await _grant_credits(args.user_id, args.credits)

    print("QA fake platform configured")
    print(f"  text:  {QA_TEXT_BACKEND}")
    print(f"  image: {QA_IMAGE_BACKEND}")
    print(f"  video: {QA_VIDEO_BACKEND}")
    print(f"  credits user: {args.user_id} (+{args.credits}, idempotent)")


if __name__ == "__main__":
    asyncio.run(main())
