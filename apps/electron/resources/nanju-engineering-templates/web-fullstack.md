# Web 全栈应用 · 工程模板 v2

> 版本：v2.0 | 代号：`web-fullstack` | 适用模式：快消型 & 长期迭代型
> 证据等级图例：**[实证]**=本机跑通留证据；**[文证]**=有来源；**[推断]**=待验证。
> 与 v1 关系：v1（530 行，全文见本文件附录 A）的 §1 技术栈三表、§2 目录结构、§3 核心配置、§6 CI YAML **整体保留沿用**（该部分是六品类中实证密度最高的 [文证：含完整配置代码]），本文不重复，只新增 v2 要求的章节。新增章节的知识大多来自**分析推断**，已标注。

---

## 0. 品类判定

### 0.1 判定特征（≥3 条命中）
- [ ] 有浏览器访问的前端 UI
- [ ] 有后端业务逻辑（API/数据持久化）
- [ ] 用户说："网站 / 网页 / 博客 / 商城 / 后台管理系统 / 社区 / SaaS"

### 0.2 反例与边界
| 表述 | 分流 |
|------|------|
| "只要接口给别的系统调" | → `api-backend` |
| "AI 对话是产品本体" | → `ai-application` |
| "手机上用的页面" | 响应式 Web 归本品类；需原生能力/应用商店 → `mobile-app` |
| "纯静态内容站" | 本品类简化版（Next.js 静态导出），不算独立品类 |

### 0.3 子形态
| 路径 | 适用 |
|------|------|
| 快速验证路径 | 单机演示/快消型：SQLite/内存库替代 Postgres，`next dev` 直接验 [推断] |
| 正式交付路径 | v1 全栈：Next.js 15 + tRPC + Drizzle + Postgres [文证] |

## 1. 技术栈矩阵
v1 §1 三表（推荐/备选/不建议）保留沿用。快速验证路径补充：数据层用 SQLite + Drizzle（drizzle 原生支持），省去 Postgres 容器；认证可先用 Better Auth 的内存 adapter。[推断待验证——建议首个项目实测后回填]

## 2. 组件环境清单

### 2.1 总览
| 组件 | 用途 | 必装性 |
|------|------|--------|
| Node.js 22（含 corepack） | 运行时 | 必须 |
| pnpm | 包管理 | 必须 |
| PostgreSQL 16 | 数据库（正式路径） | 按需（快速路径可用 SQLite） |
| Playwright + 浏览器 | E2E | 按需 |

### 2.2 组件卡片
**C1 Node.js 22**
- 探测：`node -v`（需 v22.x）
- 安装：nvm `nvm install 22`
- 已知坑：Node 20 跑 Next.js 15 的部分特性有兼容告警 [推断]；系统源 Node 版本普遍过旧，禁止 apt 直装 [推断]
- 降级替代：Node 20 LTS（降级时在 README 标注）

**C2 pnpm**
- 探测：`pnpm -v`
- 安装：`corepack enable && corepack prepare pnpm@latest --activate`
- 已知坑：多项目 store 权限冲突（不同 $HOME）[推断]；CI 中必须 `--frozen-lockfile` [文证：v1 CI 样例]
- 降级替代：npm（lockfile 迁移成本需评估）

**C3 PostgreSQL 16**
- 探测：`pg_isready` 或 `docker compose ps`
- 安装：推荐 docker-compose（v1 无 compose 样例，建议补：postgres:16-alpine + 卷 + healthcheck）[推断]
- 已知坑：本地直装版与 Docker 版数据目录冲突；连接串 `localhost` vs 容器网络名 [推断]
- 降级替代：SQLite（快速路径）；Neon/Supabase 免费云库（需网络）

**C4 Playwright**
- 探测：`pnpm exec playwright --version`
- 安装：`pnpm exec playwright install --with-deps`（Linux 需系统依赖包）
- 已知坑：无头环境缺依赖时报错信息不指向 `--with-deps` [推断]
- 降级替代：Vitest + jsdom 先行，E2E 后补

### 2.3 环境一键探测
沿用 desktop-app.md §2.3 脚本骨架，替换组件清单为上表四项（脚本略，格式一致）。

### 2.4 外部服务环境
Stripe（webhook 本地需 `stripe listen`）/ Resend 等：快消型一律先 mock。[推断] v1 §3.4 的 .env 规范沿用。

## 3. 目录结构
v1 §2 完整保留（最完整的部分）。[文证]

## 4. 核心配置
v1 §3 完整保留（package.json scripts / tsconfig / eslint / env.ts）。[文证]

## 5. 测试闭环样例

### 5.1 闭环定义
同 desktop-app.md §5.1：架构决定 → 驱动（本品类为 HTTP/浏览器驱动）→ 证据文件。

### 5.2 标准闭环：从建库到第一条 E2E 证据 [推断待验证（命令均来自 v1 样例，端到端串跑未实测）]

```bash
# 1. 环境
pnpm install && pnpm db:push                 # 建表
pnpm dev &                                    # 起 dev server
# 2. 驱动：API 冒烟（curl 驱动，证据落盘）
curl -s -o evidence/api_create.json -w '{"http":%{http_code}}' \
  -X POST localhost:3000/api/trpc/post.create -H 'content-type: application/json' -d '{...}'
# 3. 驱动：E2E（Playwright 截图 + trace 落盘）
pnpm exec playwright test --trace on         # evidence: test-results/*.zip + 截图
```

### 5.3 驱动断言规范
- 同串断言：API 响应关键字段 `toStrictEqual` 全量比对 [推断]
- 证据落盘：`evidence/` 存响应体 + http code + ts；Playwright 报告目录即证据
- 崩溃隔离：dev server 未起时 curl 驱动应记录 `connection_refused` 而非挂死（`curl --max-time 10`）[推断]

### 5.4 降级验证
无 Postgres：SQLite 快速路径；无浏览器：Vitest 单测证据先行。

驱动骨架：`driver-skeleton.py` / `driver-skeleton.cjs`（随模版分发，含五项运行时自检：storyId 校验 / expected-actual 同源 / 输出 schema+退出码表 / 顶层异常包裹 / 环境前置自检）。

## 6. Spike 实验协议
引用 `02-Spike实验协议.md`。本品类高发触发点：
- 新 ORM/新 Next.js 大版本的 breaking change 验证 [推断]
- 第三方服务（支付/邮件）沙箱可用性验证 [推断]
产物落 `00_SPIKES/`，规范同协议 §4。

## 7. 坑库
> 本品类坑库目前以 [推断] 为主，等待首个项目实测回填升级。

**PIT-WF-001** Next.js 15 App Router 双渲染环境（RSC vs Client）边界错误 → 构建期报错，绕行：`"use client"` 边界最小化（v1 §7.3 已有该模式表）[文证]。状态：文证。
**PIT-WF-002** [推断待验证] Playwright 系统依赖缺失导致安装失败 → `--with-deps`。
**PIT-WF-003** [推断待验证] Drizzle push vs migrate 混用导致迁移历史分叉 → 开发期 push、稳定后 generate+migrate 二选一策略显式化。

## 8. 标杆项目映射

| 项目 | 看什么文件 | 验证什么 | 解析状态 |
|------|-----------|---------|---------|
| calcom/cal.com | `apps/web/`、`packages/trpc/`、turbo.json、vitest.config.mts | monorepo tRPC 组织；vitest 三模式+playwright+CI 清单 | B2 已实证 ●（结构+关键文件精读，2026-09-18 平台标杆解析） |
| dubinc/dub | `web/package.json`、playwright.config、global-setup | storageState 双角色 e2e+webServer 自起 | B2 已实证 ●（旧名 steven-tey/dub 已迁移） |
| t3-oss/create-t3-app | cli/package.json、ci.yml/e2e.yml、extras 结构 | 矩阵 scaffold→build 闭环 | B2 已实证 ●（脚手架测试黄金样本） |
| vercel/next-forge | `apps/app/env.ts`、`packages/database/keys.ts`、vitest.config | keys.ts extends 组合的 env 管理 | B2 已实证 ●（env.ts 不存在已实证，如实标注） |
| shadcn-ui/taxonomy | `app/(marketing)/(dashboard)/` 路由组 | App Router 布局隔离 | 本轮未立项（非优先级）；二轮按需补解析 |

> v1 §9 五项目清单已由 B2 解析回填（cal.com/dub/create-t3-app/next-forge 四项实证 + taxonomy 未立项）。各项目测试闭环事实标准与"本机可跑"改造方案详见平台知识库《标杆解析-v1/测试闭环汇总》（2026-09-18）。

## 9. 常见模式与反模式
v1 §7.3 DO/DON'T 表完整保留。[文证]

---
## CHANGELOG

- v2.1（2026-09-18）：L2-5 驱动自检骨架——`driver-skeleton.py`/`driver-skeleton.cjs` 随模版分发（五项运行时自检：storyId 非空 / expected-actual 同源 / 输出 schema 校验+退出码表 / 顶层异常包裹 / 环境前置自检）；§5 增骨架引用（desktop-app §5.3 骨架代码段升级为骨架文件引用，三条硬规则保留并标注由骨架承载）。
- v2.0（2026-09-18）：迁移定稿入运行时快照 `nanju-engineering-templates/` 与模版源头 `nanju-guide/09_工程模板/`（平台 v0.17.126）；§8 标杆映射按 B2 标杆解析（2026-09-18，14 仓库实证）回填实测状态、剔除/替代 404 条目。
- v2.0-draft（2026-09-18，草案）：新增 §0 判定/§2 组件环境/§5 闭环/§6 Spike/§7 坑库/§8 映射（标注解析状态）；v1 §1-§4、§6、§7、§9 保留沿用不重复。
- v1.0（2026-07-17）：初始 530 行版本。

---

# 附录 A：v1 保留沿用内容（v1.0，2026-07-17）

> 正文引用的「v1 §N」均指本附录内容；v1 与 v2 冲突处以 v2 正文为准。

---

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
