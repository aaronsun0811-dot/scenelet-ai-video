"""
认证 API 路由

提供 OAuth2 登录和 token 验证接口。
"""

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from lib.db import get_async_session
from lib.db.repositories.user_repository import UserRepository
from lib.i18n import Translator
from server.auth import (
    CurrentUser,
    check_credentials,
    create_token,
    db_user_auth_enabled,
    hash_password,
    registration_enabled,
    verify_password,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ==================== 响应模型 ====================


class TokenResponse(BaseModel):
    access_token: str
    token_type: str


class AuthCapabilitiesResponse(BaseModel):
    db_users_enabled: bool
    registration_enabled: bool


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.@-]+$")
    password: str = Field(min_length=8, max_length=256)


class VerifyResponse(BaseModel):
    valid: bool
    username: str
    user_id: str
    role: str


class UserSearchItem(BaseModel):
    id: str
    username: str
    role: str


class AdminUserItem(BaseModel):
    id: str
    username: str
    role: str
    is_active: bool
    created_at: str | None = None
    updated_at: str | None = None


class UserUpdateRequest(BaseModel):
    role: Literal["admin", "user"] | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=256)


class AdminCreateUserRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.@-]+$")
    password: str = Field(min_length=8, max_length=256)
    role: Literal["admin", "user"] = "user"


# ==================== 路由 ====================


def _require_admin(current_user: CurrentUser) -> None:
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="admin required")


def _admin_user_item(row: dict) -> AdminUserItem:
    return AdminUserItem(
        id=str(row["id"]),
        username=str(row["username"]),
        role=str(row["role"]),
        is_active=bool(row["is_active"]),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


@router.get("/auth/capabilities", response_model=AuthCapabilitiesResponse)
async def auth_capabilities():
    """Return public auth-mode switches for the login screen."""
    return AuthCapabilitiesResponse(
        db_users_enabled=db_user_auth_enabled(),
        registration_enabled=registration_enabled(),
    )


@router.post("/auth/register", response_model=TokenResponse)
async def register_account(
    body: RegisterRequest,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
):
    """Create a DB-backed user account when registration is explicitly enabled."""
    if not registration_enabled():
        raise HTTPException(status_code=403, detail="registration is disabled")

    username = body.username.strip()
    repo = UserRepository(session)
    existing = await repo.get_by_username(username)
    if existing is not None:
        raise HTTPException(status_code=409, detail="username already exists")

    user = await repo.create_user(
        username=username,
        password_hash=hash_password(body.password),
        role="user",
    )
    await session.commit()

    token = create_token(user["username"], user_id=user["id"], role=user["role"])
    logger.info("新用户注册成功: %s", username)
    return TokenResponse(access_token=token, token_type="bearer")


@router.post("/auth/token", response_model=TokenResponse)
async def login_for_access_token(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
):
    """用户登录

    使用 OAuth2 标准表单格式验证凭据，成功返回 access_token。
    """
    if db_user_auth_enabled():
        user = await UserRepository(session).get_by_username(form_data.username)
        password_hash = user.get("password_hash") if user else None
        if user is not None and not user.get("is_active"):
            logger.warning("停用用户尝试登录: %s", form_data.username)
            raise HTTPException(
                status_code=401,
                detail=_t("unauthorized"),
                headers={"WWW-Authenticate": "Bearer"},
            )
        if (
            user is not None
            and user.get("is_active")
            and isinstance(password_hash, str)
            and verify_password(form_data.password, password_hash)
        ):
            token = create_token(user["username"], user_id=user["id"], role=user["role"])
            logger.info("数据库用户登录成功: %s", user["username"])
            return TokenResponse(access_token=token, token_type="bearer")

    if not check_credentials(form_data.username, form_data.password):
        logger.warning("登录失败: 用户名或密码错误 (用户: %s)", form_data.username)
        raise HTTPException(
            status_code=401,
            detail=_t("unauthorized"),
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = create_token(form_data.username)
    logger.info("用户登录成功: %s", form_data.username)
    return TokenResponse(access_token=token, token_type="bearer")


@router.get("/auth/verify", response_model=VerifyResponse)
async def verify(
    current_user: CurrentUser,
):
    """验证 token 有效性

    使用 OAuth2 Bearer token 依赖自动提取和验证 token。
    """
    return VerifyResponse(
        valid=True,
        username=current_user.sub,
        user_id=current_user.id,
        role=current_user.role,
    )


@router.get("/auth/users/search", response_model=list[UserSearchItem])
async def search_users(
    _user: CurrentUser,
    query: str = "",
    limit: int = 10,
    session: AsyncSession = Depends(get_async_session),
):
    """Search active users for project collaboration pickers."""
    if not query.strip():
        return []
    rows = await UserRepository(session).search_users(query, limit=limit)
    return [
        UserSearchItem(
            id=str(row["id"]),
            username=str(row["username"]),
            role=str(row["role"]),
        )
        for row in rows
    ]


@router.get("/auth/users", response_model=list[AdminUserItem])
async def list_users(
    current_user: CurrentUser,
    query: str = "",
    limit: int = 50,
    session: AsyncSession = Depends(get_async_session),
):
    """Admin-only user list for SaaS account operations."""
    _require_admin(current_user)
    rows = await UserRepository(session).list_users(query=query, limit=limit)
    return [_admin_user_item(row) for row in rows]


@router.post("/auth/users", status_code=201, response_model=AdminUserItem)
async def create_user(
    body: AdminCreateUserRequest,
    current_user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
):
    """Admin-only account creation independent of public registration."""
    _require_admin(current_user)
    username = body.username.strip()
    repo = UserRepository(session)
    existing = await repo.get_by_username(username)
    if existing is not None:
        raise HTTPException(status_code=409, detail="username already exists")

    user = await repo.create_user(
        username=username,
        password_hash=hash_password(body.password),
        role=body.role,
    )
    await session.commit()
    logger.info("管理员创建用户成功: %s", username)
    return _admin_user_item(user)


@router.patch("/auth/users/{user_id}", response_model=AdminUserItem)
async def update_user(
    user_id: str,
    body: UserUpdateRequest,
    current_user: CurrentUser,
    session: AsyncSession = Depends(get_async_session),
):
    """Admin-only user role/status updates."""
    _require_admin(current_user)
    repo = UserRepository(session)
    existing = await repo.get_by_id(user_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")

    demotes_admin = body.role == "user" and existing.get("role") == "admin"
    deactivates_admin = body.is_active is False and existing.get("role") == "admin"
    if existing.get("is_active") and (demotes_admin or deactivates_admin):
        active_admins = await repo.count_active_admins()
        if active_admins <= 1:
            raise HTTPException(status_code=400, detail="cannot modify last active admin")

    updated = await repo.update_user(
        user_id,
        role=body.role,
        is_active=body.is_active,
        password_hash=hash_password(body.password) if body.password is not None else None,
    )
    await session.commit()
    if updated is None:
        raise HTTPException(status_code=404, detail="user not found")
    return _admin_user_item(updated)
