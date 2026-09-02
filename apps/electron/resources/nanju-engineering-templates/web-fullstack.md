# Web 全栈应用 · 工程模板

> 版本：v1.0 | 代号：`web-fullstack` | 适用模式：快消型 & 长期迭代型

---

## 元信息

### 适用场景
- 博客、内容网站、电商、管理后台、SaaS 产品
- 有前端 UI + 后端 API + 数据库 的完整 Web 项目
- 用户说："做个网站/网页/博客/商城/后台管理系统/社区/SaaS"

### 典型项目规模
- 小型：3-10 页面，单表 CRUD（博客、个人站）
- 中型：10-50 页面，多表关联、用户认证（商城、社区）
- 大型：50+ 页面，多团队协作（企业 SaaS）

### 不适用场景
- 无需 UI 的纯 API 服务 → 用 `02-api-backend`
- 以 LLM 调用为核心逻辑 → 用 `06-ai-application`
- 纯静态内容站 → 可直接用 Next.js 静态导出，简化版

---

## 1. 技术栈

### 1.1 推荐选型（2026 Gold Standard）

| 层级 | 推荐 | 版本锚点 | 为什么 |
|------|------|---------|--------|
| **框架** | Next.js (App Router) | v15+ | 全栈能力最强：Server Components、Server Actions、文件系统路由 |
| **语言** | TypeScript | v5.5+ | 类型安全是工程质量的底线 |
| **样式** | Tailwind CSS v4 + shadcn/ui | v4 / latest | 原子化 CSS 消除样式冲突；shadcn/ui 提供可复制的无障碍组件 |
| **ORM** | Drizzle ORM | latest | 类型安全、轻量、SQL-like API、migration 自动化 |
| **认证** | Better Auth (自托管) 或 Clerk (托管) | latest | 前者开源免费，后者开发体验最佳 |
| **API 层** | tRPC | v11+ | 端到端类型安全，前后端共享类型 |
| **状态管理** | TanStack Query + Zustand | v5+ / v5+ | Query 管服务端状态，Zustand 管客户端状态，职责分明 |
| **验证** | Zod | v3+ | 运行时类型验证，与 tRPC 原生集成 |
| **支付** | Stripe | latest | 行业标准 |

### 1.2 备选方案

| 层级 | 备选 | 适用场景 |
|------|------|---------|
| **框架** | Remix / Nuxt | 更偏好 Web 标准 API / Vue 生态 |
| **ORM** | Prisma | 团队更熟悉 Prisma schema 语法；需要可视化工具 Prisma Studio |
| **认证** | NextAuth v5 | 开源方案的另一个成熟选择 |
| **API 层** | GraphQL (with Pothos) | 需要灵活查询、多客户端共用 |

### 1.3 不建议方案

| 方案 | 原因 |
|------|------|
| Pages Router (Next.js) | 已进入维护模式，App Router 是未来 |
| 纯 React (CRA/纯 Vite) | 缺少 SSR/SSG/API Routes，需要自己搭后端 |
| Redux Toolkit | 对于非专业团队过重，Zustand 足够 |
| MongoDB/Mongoose | 对于有关系的业务数据，关系型数据库更安全 |
| 裸 CSS | 大型项目中难以维护 |

---

## 2. 目录结构

### 2.1 标准结构（中型项目）

```
project/
├── .github/
│   └── workflows/
│       ├── ci.yml                 # CI: lint → typecheck → test → build
│       └── preview.yml            # Vercel preview deployment
├── src/
│   ├── app/                       # Next.js App Router（路由 + 页面）
│   │   ├── (marketing)/           # 路由组：营销页面
│   │   │   ├── page.tsx           #   首页 /
│   │   │   ├── about/page.tsx     #   关于 /about
│   │   │   └── layout.tsx         #   营销页布局（导航栏+页脚）
│   │   ├── (dashboard)/           # 路由组：后台管理（需认证）
│   │   │   ├── layout.tsx         #   后台布局（侧边栏+顶栏）
│   │   │   ├── dashboard/page.tsx #   仪表盘 /dashboard
│   │   │   └── settings/page.tsx  #   设置 /settings
│   │   ├── api/                   # API Routes（对外 REST 端点）
│   │   │   └── webhooks/
│   │   │       └── stripe/route.ts
│   │   ├── auth/                  # 认证相关页面
│   │   │   ├── signin/page.tsx
│   │   │   └── signup/page.tsx
│   │   ├── layout.tsx             # 根布局
│   │   └── globals.css            # 全局样式
│   ├── server/                    # 服务端代码（仅在服务端运行）
│   │   ├── api/                   # tRPC routers
│   │   │   ├── root.ts            #   根 router（合并所有子 router）
│   │   │   ├── trpc.ts            #   tRPC 上下文创建
│   │   │   └── routers/
│   │   │       ├── auth.ts        #     认证相关 API
│   │   │       ├── post.ts        #     文章 CRUD
│   │   │       └── user.ts        #     用户管理
│   │   ├── db/                    # 数据库层
│   │   │   ├── schema.ts          #   Drizzle schema 定义
│   │   │   ├── index.ts           #   DB 连接实例
│   │   │   └── migrations/        #   SQL 迁移文件（自动生成）
│   │   └── lib/                   # 服务端工具函数
│   │       ├── auth.ts            #   认证配置
│   │       └── email.ts           #   邮件发送
│   ├── components/                # 可复用组件
│   │   ├── ui/                    # shadcn/ui 基础组件（自动生成）
│   │   ├── forms/                 # 表单组件
│   │   └── layouts/               # 布局组件
│   ├── hooks/                     # 客户端 hooks
│   ├── lib/                       # 通用工具（客户端+服务端共享）
│   │   ├── utils.ts               #   cn() 等工具函数
│   │   └── constants.ts           #   常量定义
│   ├── styles/                    # 样式（Tailwind 配置等）
│   └── env.ts                     # 环境变量验证（用 Zod 校验 process.env）
├── public/                        # 静态资源
│   ├── images/
│   └── favicon.ico
├── tests/                         # 测试（与 src 分离）
│   ├── unit/                      #   单元测试
│   ├── integration/               #   集成测试
│   └── e2e/                       #   E2E 测试（Playwright）
├── .env.example                   # 环境变量模板（可提交）
├── .env.local                     # 本地环境变量（不提交）
├── .gitignore
├── components.json                # shadcn/ui 配置
├── drizzle.config.ts              # Drizzle 配置
├── eslint.config.mjs              # ESLint flat config
├── next.config.ts                 # Next.js 配置
├── package.json                   # 依赖 + scripts
├── postcss.config.mjs             # PostCSS 配置（Tailwind）
├── prettier.config.mjs            # Prettier 配置
├── tailwind.config.ts             # Tailwind 配置
├── tsconfig.json                  # TypeScript 配置
└── README.md                      # 项目文档
```

### 2.2 组织逻辑

| 决策点 | 选择 | 理由 |
|--------|------|------|
| App Router 路由组 | `(marketing)` / `(dashboard)` | 路由组不产生 URL 段，纯粹用于布局分组 |
| 服务端代码位置 | `src/server/` | 与客户端代码物理隔离，防止 import 到客户端 |
| 组件位置 | `src/components/` | 与路由解耦，便于跨路由复用 |
| 测试目录 | `tests/`（与 src 平行） | 清晰的关注点分离，CI 配置更简单 |
| UI 基础组件 | `src/components/ui/` | shadcn/ui 约定，通过 CLI 自动生成到此目录 |

### 2.3 命名约定

| 对象 | 约定 | 示例 |
|------|------|------|
| 目录 | kebab-case | `email-templates/`, `api/routers/` |
| 文件（组件） | PascalCase | `SignInForm.tsx`, `PostCard.tsx` |
| 文件（非组件） | kebab-case | `auth-utils.ts`, `email-service.ts` |
| 变量/函数 | camelCase | `createUser`, `getPosts` |
| 类型/接口 | PascalCase | `UserProfile`, `PostCreateInput` |
| 数据库表 | snake_case（复数） | `user_profiles`, `blog_posts` |
| 路由路径 | kebab-case | `/blog/my-first-post` |

---

## 3. 核心配置

### 3.1 package.json Scripts

```json
{
  "scripts": {
    "dev": "next dev --turbo",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "db:push": "drizzle-kit push",
    "prepare": "husky"
  }
}
```

### 3.2 tsconfig.json 关键字段

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "tests"]
}
```

### 3.3 eslint.config.mjs 核心规则

```js
// ESLint flat config (v9+)
// 核心插件：@eslint/js, typescript-eslint, eslint-plugin-react-hooks
// 核心规则：
// - "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
// - "@typescript-eslint/no-explicit-any": "error"
// - "react-hooks/rules-of-hooks": "error"
// - "react-hooks/exhaustive-deps": "warn"
```

### 3.4 环境变量规范

```bash
# .env.example（提交到 Git）
# 应用
NEXT_PUBLIC_APP_URL=http://localhost:3000

# 数据库
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# 认证（Better Auth）
BETTER_AUTH_SECRET=       # openssl rand -hex 32
BETTER_AUTH_URL=http://localhost:3000

# Stripe（可选）
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# 邮件（可选）
RESEND_API_KEY=

# .env.local（不提交，开发环境真实值）
# .env.production（生产环境）
```

### 3.5 env.ts（环境变量验证）

```ts
// 用 Zod 验证所有环境变量，启动时检查
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  // ...
});

export const env = envSchema.parse(process.env);
```

---

## 4. 开发工作流

### 4.1 标准流程

```text
1. git clone → pnpm install → cp .env.example .env.local → 填入真实值
2. pnpm dev              # 启动开发服务器 (localhost:3000)
3. pnpm db:push          # 开发阶段快速同步 schema（不用 migration）
4. 开发...               # 热更新自动生效
5. pnpm lint             # 提交前检查
6. pnpm typecheck        # 提交前检查
7. pnpm db:generate      # 生产级迁移（schema 稳定后）
8. git add → git commit  # Husky 自动运行 pre-commit
9. git push              # CI 自动运行 lint → typecheck → test → build
```

### 4.2 工具链集成

| 环节 | 工具 | 触发时机 |
|------|------|---------|
| 类型检查 | `tsc --noEmit` | CI + 提交前手动 |
| Lint | ESLint | pre-commit (Husky) + CI |
| 格式化 | Prettier | pre-commit (Husky) |
| Commit 规范 | commitlint | commit-msg (Husky) |
| 测试 | Vitest + Playwright | CI |

---

## 5. 测试策略

### 5.1 测试分层

```
         ┌─────────┐
         │  E2E    │  10%  关键用户流程（登录→创建→查看）
         ├─────────┤
         │ 集成测试 │  30%  API endpoints + DB 交互
         ├─────────┤
         │ 单元测试 │  60%  工具函数 + 业务逻辑 + 组件渲染
         └─────────┘
```

### 5.2 测试框架

| 层级 | 工具 | 为什么 |
|------|------|--------|
| 单元 | Vitest + React Testing Library | 快（Vite 原生）、Jest 兼容 API |
| 集成 | Vitest + testcontainers | 测试真实的 DB/API |
| E2E | Playwright | 浏览器自动化标杆，支持多浏览器 |

### 5.3 测试文件约定

- 单元测试：`src/**/__tests__/` 或 `.test.ts(x)`（co-located）
- 集成测试：`tests/integration/`
- E2E 测试：`tests/e2e/`

### 5.4 覆盖率要求

| 指标 | 快消型 | 长期迭代型 |
|------|--------|-----------|
| Lines | ≥ 50% | ≥ 80% |
| Branches | ≥ 40% | ≥ 70% |
| 关键路径 | 100% | 100% |

---

## 6. CI/CD

### 6.1 CI Pipeline（GitHub Actions）

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm format:check        # 格式检查
      - run: pnpm lint                # Lint 检查
      - run: pnpm typecheck           # 类型检查

  test:
    needs: quality
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test

  e2e:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps
      - run: pnpm test:e2e

  build:
    needs: e2e
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
```

### 6.2 部署

| 阶段 | 方式 | 平台 |
|------|------|------|
| Preview | PR 自动部署预览环境 | Vercel / Railway |
| Staging | 合并到 main 自动部署 | Vercel / Railway |
| Production | 手动审批后部署（长期迭代型） | Vercel / Docker |

---

## 7. 代码规范

### 7.1 组件编写规范

```tsx
// ✅ DO: 服务端组件优先，需要交互时创建客户端组件
// src/app/(dashboard)/dashboard/page.tsx
import { Suspense } from "react";
import { DashboardStats } from "./_components/dashboard-stats"; // 服务端
import { RecentActivity } from "./_components/recent-activity"; // 客户端，需要轮询

export default function DashboardPage() {
  return (
    <div>
      <h1>仪表盘</h1>
      <Suspense fallback={<StatsSkeleton />}>
        <DashboardStats />
      </Suspense>
      <Suspense fallback={<ActivitySkeleton />}>
        <RecentActivity />
      </Suspense>
    </div>
  );
}
```

### 7.2 导入顺序

```text
1. Node 内置模块
2. 第三方包（React → Next.js → UI库 → 工具库）
3. 内部模块（@/server → @/components → @/lib → @/hooks）
4. 相对路径导入
5. 样式导入

每类之间空一行。
```

### 7.3 常见模式与反模式

| 模式 | DO ✅ | DON'T ❌ |
|------|-------|---------|
| **数据获取** | Server Component 中直接 await | `useEffect` 中 fetch |
| **交互** | `"use client"` 边界最小化 | 整个 layout 标为客户端 |
| **表单** | Server Actions + useActionState | 全部用客户端 fetch |
| **auth 检查** | middleware + layout 守卫 | 每个页面手动检查 |
| **错误处理** | error.tsx（错误边界） | try-catch 在每个组件 |
| **加载状态** | Suspense + loading.tsx | `if (loading)` 散落到处 |
| **数据库查询** | Drizzle 查询在 server/ 中 | 在组件中直接写 SQL |
| **环境变量** | `env.ts` 集中验证 | 散落 `process.env.X` |
| **API 调用** | tRPC（类型安全） | 裸 fetch（类型丢失） |

---

## 8. 架构模式

### 8.1 三层架构

```
┌─────────────────────────────────┐
│  表现层 (Presentation)           │
│  src/app/ — 页面、布局、加载态   │
│  src/components/ — UI 组件      │
├─────────────────────────────────┤
│  应用层 (Application)            │
│  src/server/api/ — tRPC routers │
│  Server Actions — 表单处理       │
├─────────────────────────────────┤
│  领域/数据层 (Domain/Data)       │
│  src/server/db/ — Schema、查询  │
│  src/server/lib/ — 业务逻辑     │
└─────────────────────────────────┘
```

### 8.2 请求生命周期

```text
浏览器请求
  → Next.js middleware（auth 检查 / 重定向）
    → App Router（路由匹配）
      → RSC（服务端组件数据获取）
        → tRPC / Drizzle 查询
      → SSR HTML 返回
  → 客户端水合（hydration）
  → 交互触发 Server Actions 或 tRPC mutations
```

### 8.3 认证流程

```text
Better Auth：
  注册 → 邮箱验证 → 创建 session → 设置 cookie
  登录 → 验证凭据 → 创建 session → 设置 cookie
  受保护路由 → middleware 检查 session → 放行或重定向
  
Server Action 中：通过 auth() 获取当前用户
tRPC context 中：通过 auth() 注入 user
```

---

## 9. 参考项目

以下开源项目是本模板的分析基础和持续参考：

| 项目 | Stars | 关键借鉴 |
|------|-------|---------|
| [Cal.com](https://github.com/calcom/cal.com) | ~40K | Turborepo 单体仓库组织、tRPC + Prisma 生产实践、多租户架构 |
| [Dub](https://github.com/dubinc/dub) | ~23K | API-first 设计、边缘路由、Upstash 限流、公开 REST API + 内部 tRPC 并存 |
| [Taxonomy](https://github.com/shadcn-ui/taxonomy) | ~19K | App Router + Server Components 最佳实践、shadcn/ui + Stripe 订阅 |
| [create-t3-app](https://github.com/t3-oss/create-t3-app) | ~28K | CLI 脚手架模式、typesafe 全栈栈的标准化推广 |
| [next-forge](https://github.com/vercel/next-forge) | — | Vercel 官方生产级模板：Clerk + Stripe + PostHog + Sentry + AI SDK 全套集成 |
