# API 后端服务 · 工程模板 v2（改进草案）

> 版本：v2.0-draft | 代号：`api-backend` | 适用模式：快消型 & 长期迭代型
> 证据等级：**[实证]** / **[文证]** / **[推断]**。
> 与 v1 关系：v1（`/home/orphic/proma-patches/p1-quick-engineering/apps/electron/resources/nanju-engineering-templates/api-backend.md`）的 §1 双栈决策表、§2 目录结构、§3 路由/错误码体系、§5 安全清单**保留沿用**；本文新增 v2 章节。注：本品类为现行实现中替代 PRD §11.2"硬件联调"的品类（差异说明见 `../00-现状差距分析.md` §7）。

---

## 0. 品类判定

### 0.1 判定特征（≥3 条命中）
- [ ] 纯后端：无 SSR/前端页面，输出 HTTP/gRPC API
- [ ] 消费者是其他程序（前端应用/第三方系统/定时任务）
- [ ] 用户说："后端 API / 给我的 App 提供接口 / 数据服务 / 微服务"

### 0.2 反例与边界
| 表述 | 分流 |
|------|------|
| "要管理页面" | → `web-fullstack` |
| "本地批处理脚本，无需常驻服务" | → `cli-tool` |
| "接口主要给 LLM 编排调用" | → `ai-application`（若 LLM 为核心） |

### 0.3 子形态
| 路径 | 适用 |
|------|------|
| 快速验证路径 | Node + SQLite/内存态 + 进程内启动，curl 即可驱动 [推断] |
| 正式交付路径 | v1 双栈：Hono/TS 或 FastAPI/Python + Postgres + Redis [文证] |

## 1. 技术栈矩阵
v1 §1 选型表与 Node/Python 决策表保留沿用。[文证] 快速验证路径：Hono 可 `@hono/node-server` 单文件起服务，或 FastAPI + uvicorn；数据层 SQLite（SQLAlchemy/Drizzle 均支持）替代 Postgres。[推断待验证]

## 2. 组件环境清单

### 2.1 总览
| 组件 | 用途 | 必装性 |
|------|------|--------|
| Node.js 22 / Python 3.12 | 运行时 | 必须 |
| Docker + compose | Postgres/Redis 本地环境 | 按需（正式路径必须） |
| PostgreSQL 16 / Redis 7 | 数据/缓存 | 按需 |
| curl / httpie | API 驱动 | 必须 |
| argon2/bcrypt 原生依赖 | 密码哈希 | 认证类必须 |

### 2.2 组件卡片
**C1 Docker + compose**
- 探测：`docker compose version`
- 安装：官方源或发行版 `docker.io docker-compose-plugin`
- 已知坑：无 root 权限需 docker 组（`usermod -aG docker` 后重登）[推断]；容器健康检查未就绪即跑测试是集成测试假失败首因 [推断]
- 降级替代：SQLite（去 Postgres）+ 进程内 map（去 Redis），接口层不变

**C2 原生哈希库（argon2）**
- 探测：`python -c "import argon2"` / `node -e "require('argon2')"`
- 安装：`pip install argon2-cffi`（预编译轮子）或 `npm i argon2`（可能需编译链 build-essential）[推断]
- 已知坑：npm argon2 缺预编译二进制时需 node-gyp 全套工具链 [推断]
- 降级替代：Node 内置 `crypto.scrypt` [文证：Node 官方文档]

**C3 curl 驱动**
- 探测：`curl --version`
- 已知坑：默认无超时，驱动脚本必须 `--max-time` [推断]
- 降级替代：httpie / httpx 脚本

### 2.3 环境一键探测
沿用 desktop-app.md §2.3 脚本骨架，替换组件为上表。

### 2.4 外部服务环境
本品类常见外部依赖为第三方 API（支付/短信）。规则：接入前先 curl 一条真实请求验证端点与鉴权形态，把**已验证的端点/模型/格式**写进 §2.4 卡片（形态同 desktop-app.md §2.4 DashScope 卡片）。[推断——本规则由昨晚 ASR 教训泛化]

## 3. 目录结构
v1 §2 保留。[文证] 增补：`drivers/`（验收驱动脚本）与 `evidence/`（证据）两个顶层目录，`00_SPIKES/` 按 Spike 协议。

## 4. 核心配置
v1 §3 保留。[文证] docker-compose.yml 建议补 healthcheck 样例：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: test }
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 5s, retries: 10 }
```
[推断待验证]

## 5. 测试闭环样例

### 5.1 闭环定义
同全栈品类：架构决定 → 驱动（HTTP 调用）→ 证据文件（JSON 响应 + 状态码 + ts）。

### 5.2 标准闭环：容器健康 → 迁移 → 驱动 → 证据 [推断待验证（命令来自 v1 生态常识，未端到端实测）]

```bash
docker compose up -d --wait                       # --wait 等待 healthcheck 通过
pnpm db:migrate                                   # 或 alembic upgrade head
curl -s --max-time 10 -o evidence/user_create.json -w '{"http":%{http_code},"ts":'$(date +%s)'}' \
  -X POST localhost:3000/api/v1/users -H 'content-type: application/json' \
  -d '{"email":"a@b.c","password":"***"}'
# 判读：evidence 文件 http==201 且响应含 id → 闭环通
```

### 5.3 驱动断言规范
- 同串断言：错误码（v1 §3.3 体系）与状态码精确比对；`USER_NOT_FOUND` 不等于 `RESOURCE_NOT_FOUND` [推断]
- 证据落盘：每条驱动一行 JSON（请求摘要/响应/http/ts）追加进 `evidence/api_log.jsonl`
- 崩溃隔离：服务进程被 `--wait`/`--max-time` 包裹，超时写 `verdict: service_unreachable` 而非挂死 [推断]

### 5.4 降级验证
无 Docker：SQLite 路径；无网络：全部用例本地闭环（本品类天然优势）。

## 6. Spike 实验协议
引用 `../02-Spike实验协议.md`。高发触发点：鉴权库真实行为验证、第三方 API 端点/格式确认、限流策略在真实 Redis 的行为。[推断]

## 7. 坑库
**PIT-AB-001** [推断待验证] 集成测试连容器 DB 失败 → compose `--wait` + healthcheck 前置。
**PIT-AB-002** [推断待验证] argon2 npm 包编译链问题 → 优先 `argon2-cffi`（Python）或 scrypt 降级。
**PIT-AB-003** [推断] CORS 与 SameSite 在本地 https 混合部署下表现差异 → 首个项目实测回填。

## 8. 标杆项目映射

| 项目 | 看什么文件 | 验证什么 | 解析状态 |
|------|-----------|---------|---------|
| honojs/hono | `src/middleware/`、`src/helper/` | 中间件组合与 RPC 模式 | 待下载待解析 |
| amoncusir/fastapi-template | `application/domain/infrastructure/` | DDD 分层依赖方向 | 待下载待解析 |

## 9. 常见模式与反模式
v1 §5 安全清单（8 项 checklist）保留作交付门禁。[文证]

---
## CHANGELOG
- v2.0-draft（2026-09-18）：新增 §0/§2/§5/§6/§7/§8；v1 §1-§3、§5 保留沿用。
- v1.0（2026-07-17）：初始 195 行版本。
