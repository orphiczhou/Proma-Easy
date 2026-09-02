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
