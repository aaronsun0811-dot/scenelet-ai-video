# Scenelet 安装说明

本文档给出最短可运行安装路径。推荐先用 Docker 启动，确认能登录后再配置模型供应商 API Key。

## 方式一：Docker 本地构建（推荐）

要求：

- Docker Desktop 或 Docker Engine
- Docker Compose v2
- macOS / Linux / Windows WSL2

```bash
git clone https://github.com/aaronsun0811-dot/scenelet-ai-video.git
cd scenelet-ai-video/deploy
cp .env.example .env
docker compose up -d --build
```

启动后访问：

```text
http://localhost:1241
```

默认登录：

- 用户名：`admin`
- 密码：在 `deploy/.env` 的 `AUTH_PASSWORD` 中设置；如果留空，首次启动会自动生成并写回 `.env`

登录后进入设置页，至少配置：

- Scenelet 智能体：Anthropic API Key
- 图片 / 视频 / 文本供应商：Gemini、火山方舟、Grok、OpenAI 或自定义供应商任选其一

## 方式二：源码开发启动

要求：

- Python 3.12+
- Node.js 22+
- pnpm
- uv
- ffmpeg

```bash
git clone https://github.com/aaronsun0811-dot/scenelet-ai-video.git
cd scenelet-ai-video
cp .env.example .env
uv sync
cd frontend
pnpm install
```

启动后端：

```bash
cd scenelet-ai-video
uv run uvicorn server.app:app --host 127.0.0.1 --port 1241
```

另开一个终端启动前端：

```bash
cd scenelet-ai-video/frontend
pnpm dev --host 0.0.0.0
```

开发环境访问：

```text
http://localhost:5173
```

## 生产 PostgreSQL 部署

```bash
git clone https://github.com/aaronsun0811-dot/scenelet-ai-video.git
cd scenelet-ai-video/deploy/production
cp .env.example .env
# 编辑 .env，设置 POSTGRES_PASSWORD 和登录密码
docker compose up -d --build
```

## 常用维护命令

```bash
# 查看日志
docker compose logs -f scenelet

# 停止服务
docker compose down

# 更新代码后重建
git pull
docker compose up -d --build
```

## 注意事项

- 不要提交 `.env`、`projects/`、`vertex_keys/`，这些路径已在 `.gitignore` 中排除。
- `projects/` 保存本地项目、数据库和生成素材，公开仓库不包含这些运行时数据。
- 如果需要从 SQLite 迁移到 PostgreSQL，参考 `deploy/production/MIGRATE-TO-POSTGRES.md`。
