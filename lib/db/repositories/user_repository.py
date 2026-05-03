"""User account repository."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from sqlalchemy import func, select

from lib.db.base import dt_to_iso
from lib.db.models.user import User
from lib.db.repositories.base import BaseRepository


def _user_to_dict(row: User) -> dict[str, Any]:
    return {
        "id": row.id,
        "username": row.username,
        "password_hash": row.password_hash,
        "role": row.role,
        "is_active": row.is_active,
        "created_at": dt_to_iso(row.created_at),
        "updated_at": dt_to_iso(row.updated_at),
    }


class UserRepository(BaseRepository):
    async def get_by_id(self, user_id: str) -> dict[str, Any] | None:
        stmt = select(User).where(User.id == user_id)
        result = await self.session.execute(stmt)
        row = result.scalar_one_or_none()
        return _user_to_dict(row) if row else None

    async def get_by_username(self, username: str) -> dict[str, Any] | None:
        normalized = username.strip().lower()
        stmt = select(User).where(func.lower(User.username) == normalized)
        result = await self.session.execute(stmt)
        row = result.scalar_one_or_none()
        return _user_to_dict(row) if row else None

    async def search_users(self, query: str, *, limit: int = 10) -> list[dict[str, Any]]:
        normalized = query.strip().lower()
        if not normalized:
            return []
        limit = max(1, min(limit, 25))
        pattern = f"%{normalized}%"
        stmt = (
            select(User)
            .where(
                User.is_active.is_(True),
                (func.lower(User.username).like(pattern)) | (func.lower(User.id).like(pattern)),
            )
            .order_by(User.username.asc())
            .limit(limit)
        )
        result = await self.session.execute(stmt)
        return [_user_to_dict(row) for row in result.scalars().all()]

    async def list_users(self, *, query: str = "", limit: int = 50) -> list[dict[str, Any]]:
        normalized = query.strip().lower()
        limit = max(1, min(limit, 100))
        stmt = select(User).order_by(User.created_at.desc()).limit(limit)
        if normalized:
            pattern = f"%{normalized}%"
            stmt = (
                select(User)
                .where((func.lower(User.username).like(pattern)) | (func.lower(User.id).like(pattern)))
                .order_by(User.created_at.desc())
                .limit(limit)
            )
        result = await self.session.execute(stmt)
        return [_user_to_dict(row) for row in result.scalars().all()]

    async def count_active_admins(self) -> int:
        stmt = select(func.count()).select_from(User).where(User.role == "admin", User.is_active.is_(True))
        result = await self.session.execute(stmt)
        return int(result.scalar_one())

    async def update_user(
        self,
        user_id: str,
        *,
        role: str | None = None,
        is_active: bool | None = None,
        password_hash: str | None = None,
    ) -> dict[str, Any] | None:
        stmt = select(User).where(User.id == user_id)
        result = await self.session.execute(stmt)
        row = result.scalar_one_or_none()
        if row is None:
            return None

        if role is not None:
            row.role = role
        if is_active is not None:
            row.is_active = is_active
        if password_hash is not None:
            row.password_hash = password_hash

        await self.session.flush()
        await self.session.refresh(row)
        return _user_to_dict(row)

    async def create_user(
        self,
        *,
        username: str,
        password_hash: str,
        role: str = "user",
    ) -> dict[str, Any]:
        row = User(
            id=f"user_{uuid4().hex}",
            username=username.strip(),
            password_hash=password_hash,
            role=role,
            is_active=True,
        )
        self.session.add(row)
        await self.session.flush()
        await self.session.refresh(row)
        return _user_to_dict(row)
