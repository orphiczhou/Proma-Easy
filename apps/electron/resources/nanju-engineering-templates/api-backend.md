# API 后端服务 · 工程模板 v2

> 版本：v2.0 | 代号：`api-backend` | 适用模式：快消型 & 长期迭代型
> 证据等级：**[实证]** / **[文证]** / **[推断]**。
> 与 v1 关系：v1（全文见本文件附录 A）的 §1 双栈决策表、§2 目录结构、§3 路由/错误码体系、§5 安全清单**保留沿用**；本文新增 v2 章节。注：本品类为现行实现中替代 PRD §11.2"硬件联调"的品类（差异说明见平台知识库《工程模版改进-v1/00-现状差距分析》§7，2026-09-18）。

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

驱动骨架：`driver-skeleton.py` / `driver-skeleton.cjs`（随模版分发，含五项运行时自检：storyId 校验 / expected-actual 同源 / 输出 schema+退出码表 / 顶层异常包裹 / 环境前置自检）。

### 5.5 标杆测试闭环（本机可跑，B2 实证提炼）

> 来源：平台知识库《标杆解析-v1/测试闭环汇总》§2.2/§2.3（2026-09-18，hono / fastapi-full-stack-fastapi-template / fastapi-best-practices 实证）。命令照抄可用 [文证：标杆实证]，本品类模板未串跑。与 §5.2 的关系：§5.2 依赖容器起真库；本节是免容器的脚本门禁形态，与 §2.1 C1 降级替代（SQLite/进程内 map）同向。

**① 工具链与命令** [文证：标杆实证]

TS（Hono 路线）——双闸 + 进程内免起服务器：

```json
{ "test": "tsc --noEmit && vitest --run" }   // hono 双闸：类型不过则单测不跑
```

```ts
// 单测直用 app.request()，免起真服务器、免监听端口
const res = await app.request('/api/users', {
  method: 'POST', body: JSON.stringify(payload),
});
expect(res.status).toBe(201);
```
- 数据层 DI 注入 SQLite/内存 KV：测试库与生产库同一 schema 不同 provider。

Python（FastAPI 路线）——uv + ruff + pytest + TestClient：

```bash
uv sync                                                          # .venv 就绪
bash scripts/lint.sh                                             # ruff check --fix src && ruff format src
FASTAPI_ENV=test coverage run -m pytest tests/ && coverage report
```
- conftest.py 三 fixture（标杆全文可抄）：session 级 `db`（init_db 种子→测后清理）、`superuser_token_headers` / `normal_user_token_headers`（认证分层）；DB 用 SQLite 文件替代 PG——TestClient 进程内同步调用，无容器即无 pre_start 轮询需求。
- tests/ 目录域镜像 src/ 域（api/ crud/ 一一对应），目录即测试清单。

**② 证据形态**
- TS：tsc 退出码 + vitest 摘要；Python：pytest 摘要 + coverage 报告（`htmlcov/` 可落盘）
- 驱动脚本证据仍按 §5.3 写 `evidence/api_log.jsonl`（门禁与 §5.2 驱动闭环互补，不替代）

**③ 降级对照（一行表）**

| 受限 | 标杆替代 [文证：标杆实证] |
|---|---|
| 无 Docker | TS：SQLite/内存 KV；Py：TestClient + SQLite 文件（conftest fixture） |
| 无网 | `app.request()` / TestClient 全进程内，零外部调用 |
| 无密钥 | 认证 fixture 自生成 token，不依赖真实 IdP |

**④ DoD 要点**（取自汇总 §5 七条，本品类相关 3 条）
- `pnpm test` / `pytest` 一条命令跑完类型+单测，新项目空测试也绿
- 单测不碰网络/容器/真 key（进程内 TestClient + SQLite）
- `pnpm build` 产物存在且 `test` 已前置依赖最新产物

## 6. Spike 实验协议
引用 `02-Spike实验协议.md`。高发触发点：鉴权库真实行为验证、第三方 API 端点/格式确认、限流策略在真实 Redis 的行为。[推断]

## 7. 坑库
**PIT-AB-001** [推断待验证] 集成测试连容器 DB 失败 → compose `--wait` + healthcheck 前置。
**PIT-AB-002** [推断待验证] argon2 npm 包编译链问题 → 优先 `argon2-cffi`（Python）或 scrypt 降级。
**PIT-AB-003** [推断] CORS 与 SameSite 在本地 https 混合部署下表现差异 → 首个项目实测回填。

## 8. 标杆项目映射

| 项目 | 看什么文件 | 验证什么 | 解析状态 |
|------|-----------|---------|---------|
| honojs/hono | `src/middleware/`、`src/helper/`、vitest.config.ts | 中间件组合与 RPC 模式；tsc+vitest 双闸+六运行时 projects | B2 已实证 ●（2026-09-18 平台标杆解析） |
| ~~amoncusir/fastapi-template~~ | — | 已实测 404（REFERENCE_PROJECTS #8） | ✖ 已淘汰，勿解析 |
| fastapi/full-stack-fastapi-template | `conftest.py`（官方三 fixture）、test.sh、workflows | pytest+coverage+compose+playwright 官方闭环 | B2 已实证 ●（替代 2 个 404 项目，质量高于原选型） |
| zhanymkanov/fastapi-best-practices | README 章节结构 | DDD 分层/async 测试/ruff（文档型理论基座） | B2 部分 ◐（文档仓库：结构+章节摘要，如实标注） |

## 9. 常见模式与反模式
v1 §5 安全清单（8 项 checklist）保留作交付门禁。[文证]

---
## CHANGELOG

- v2.2（2026-09-18）：§5.5 标杆测试闭环并入——Hono/FastAPI 双路线本机可跑门禁（双闸命令+conftest fixture+降级对照+DoD），证据等级 [文证：标杆实证]；来源：平台知识库《标杆解析-v1/测试闭环汇总》。
- v2.1（2026-09-18）：L2-5 驱动自检骨架——`driver-skeleton.py`/`driver-skeleton.cjs` 随模版分发（五项运行时自检：storyId 非空 / expected-actual 同源 / 输出 schema 校验+退出码表 / 顶层异常包裹 / 环境前置自检）；§5 增骨架引用（desktop-app §5.3 骨架代码段升级为骨架文件引用，三条硬规则保留并标注由骨架承载）。
- v2.0（2026-09-18）：迁移定稿入运行时快照 `nanju-engineering-templates/` 与模版源头 `nanju-guide/09_工程模板/`（平台 v0.17.126）；§8 标杆映射按 B2 标杆解析（2026-09-18，14 仓库实证）回填实测状态、剔除/替代 404 条目。
- v2.0-draft（2026-09-18，草案）：新增 §0/§2/§5/§6/§7/§8；v1 §1-§3、§5 保留沿用。
- v1.0（2026-07-17）：初始 195 行版本。

---

# 附录 A：v1 保留沿用内容（v1.0，2026-07-17）

> 正文引用的「v1 §N」均指本附录内容；v1 与 v2 冲突处以 v2 正文为准。

---

# API 后端服务 · 工程模板

> 版本：v1.0 | 代号：`api-backend` | 适用模式：快消型 & 长期迭代型

---

## 元信息

### 适用场景
- 独立 REST API 服务、微服务
- 为 Web / Mobile / 第三方客户端提供 API
- 用户说："做个用户系统的后端 API / 对接现有前端的后端 / 数据接口服务"

### 不适用场景
- 需要 SSR/前端页面的全栈项目 → 用 `01-web-fullstack`
- 命令行工具 → 用 `05-cli-tool`

---

## 1. 技术栈

### 推荐选型

| 层级 | 推荐 (TypeScript) | 推荐 (Python) | 版本 |
|------|------------------|---------------|------|
| **框架** | Hono | FastAPI | latest |
| **运行时** | Node.js 22 / Bun | Python 3.12+ | — |
| **数据库** | PostgreSQL 16+ | PostgreSQL 16+ | — |
| **ORM** | Drizzle ORM | SQLAlchemy 2.0 (async) | latest |
| **验证** | Zod | Pydantic v2 | latest |
| **缓存** | Redis (ioredis) | Redis (redis-py) | — |
| **认证** | JWT + Argon2id | JWT + Argon2id | — |
| **API 文档** | OpenAPI (自动生成) | OpenAPI (自动生成) | 3.1 |
| **日志** | pino | structlog | latest |
| **测试** | Vitest | pytest + httpx | latest |

### 选择 Node.js 还是 Python？

| 条件 | 选择 |
|------|------|
| 需要与前端共享类型（TypeScript 项目） | Node.js (Hono) |
| AI/ML 集成、数据处理密集型 | Python (FastAPI) |
| 团队熟悉 JS/TS 生态 | Node.js (Hono) |
| 性能关键、边缘部署 | Node.js (Hono on Bun) |

> **模板默认**：Node.js (Hono) — 与 nanju 平台主要生态（TypeScript）保持一致。

---

## 2. 目录结构

```
project/
├── .github/workflows/
│   └── ci.yml
├── src/
│   ├── index.ts                  # 入口：创建 Hono app
│   ├── app.ts                    # app 工厂（可测试性）
│   ├── config/
│   │   ├── env.ts                #   环境变量 Zod 验证
│   │   └── database.ts           #   DB 连接池
│   ├── modules/                  # 业务模块（feature-based）
│   │   ├── auth/
│   │   │   ├── auth.routes.ts    #     路由定义
│   │   │   ├── auth.service.ts   #     业务逻辑
│   │   │   ├── auth.schema.ts    #     Zod schema（请求/响应）
│   │   │   └── auth.test.ts     #     模块测试
│   │   ├── users/
│   │   │   ├── users.routes.ts
│   │   │   ├── users.service.ts
│   │   │   ├── users.schema.ts
│   │   │   └── users.test.ts
│   │   └── posts/
│   │       ├── posts.routes.ts
│   │       ├── posts.service.ts
│   │       ├── posts.schema.ts
│   │       └── posts.test.ts
│   ├── middleware/
│   │   ├── auth.ts               #   JWT 验证中间件
│   │   ├── error-handler.ts      #   全局错误处理
│   │   ├── logger.ts             #   请求日志
│   │   ├── rate-limit.ts         #   速率限制
│   │   └── cors.ts               #   CORS 配置
│   ├── db/
│   │   ├── schema.ts             #   Drizzle schema
│   │   ├── migrations/           #   迁移文件
│   │   └── seed.ts               #   种子数据
│   └── lib/
│       ├── errors.ts             #   自定义错误类 + 错误码
│       ├── jwt.ts                #   JWT 工具
│       ├── hash.ts               #   密码哈希（Argon2id）
│       └── pagination.ts         #   分页工具
├── tests/
│   └── integration/              # 集成测试（启动真实 server）
├── docker-compose.yml            # 本地开发环境（PostgreSQL + Redis）
├── Dockerfile                    # 多阶段构建
├── .env.example
├── .gitignore
├── drizzle.config.ts
├── eslint.config.mjs
├── tsconfig.json
├── package.json
└── README.md
```

---

## 3. 核心配置

### 3.1 API 路由设计

```typescript
// src/app.ts — Hono app 组装
import { Hono } from "hono";
import { cors } from "./middleware/cors";
import { errorHandler } from "./middleware/error-handler";
import { logger } from "./middleware/logger";
import { authRoutes } from "./modules/auth/auth.routes";
import { usersRoutes } from "./modules/users/users.routes";
import { postsRoutes } from "./modules/posts/posts.routes";

const app = new Hono()
  .use("*", cors())
  .use("*", logger())
  .onError(errorHandler);

// API v1
const v1 = new Hono()
  .route("/auth", authRoutes)
  .route("/users", usersRoutes)
  .route("/posts", postsRoutes);

app.route("/api/v1", v1);

export { app };
```

### 3.2 统一响应格式

```typescript
// 成功
{ "data": { ... }, "meta": { "page": 1, "total": 100 } }

// 错误
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "User with id 'xxx' not found",
    "statusCode": 404
  }
}
```

### 3.3 错误码体系

| 类别 | 前缀 | 示例 |
|------|------|------|
| 认证/授权 | `AUTH_` | `AUTH_INVALID_TOKEN`, `AUTH_EXPIRED_TOKEN` |
| 资源 | `RESOURCE_` | `USER_NOT_FOUND`, `POST_NOT_FOUND` |
| 验证 | `VALIDATION_` | `VALIDATION_INVALID_EMAIL` |
| 服务端 | `SERVER_` | `SERVER_DB_ERROR`, `SERVER_REDIS_ERROR` |

---

## 4. 测试策略

| 层级 | 比例 | 工具 | 内容 |
|------|------|------|------|
| 单元测试 | 40% | Vitest | service 函数、工具函数 |
| 集成测试 | 50% | Vitest + testcontainers | 真实 DB 的 API endpoint 测试 |
| E2E | 10% | Vitest | 健康检查、关键业务流程 |

---

## 5. 安全清单

- [ ] 所有输入用 Zod schema 验证
- [ ] 密码使用 Argon2id 哈希（非 bcrypt）
- [ ] JWT access token 有效期 ≤ 15min，配合 refresh token
- [ ] API 限流（每个 IP/用户 每分钟 N 次）
- [ ] CORS 白名单
- [ ] SQL 注入防护（ORM 参数化查询）
- [ ] HTTP Security Headers（Helmet）
- [ ] 敏感数据不返回给客户端

---

## 6. 参考项目

| 项目 | 关键借鉴 |
|------|---------|
| [Hono](https://github.com/honojs/hono) | 极简但强大的路由设计、RPC 模式、中间件组合 |
| [FastAPI 官方最佳实践](https://github.com/hellowac/fastapi-best-practices-zh-cn) | FastAPI 项目结构标准 |
| [amoncusir/fastapi-template](https://github.com/amoncusir/fastapi-template) | DDD + Clean Architecture 分层 |
| [cal.com API](https://github.com/calcom/cal.com) | tRPC 与公开 REST API 共存的实践 |
