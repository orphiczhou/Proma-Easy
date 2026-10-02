# Web 全栈应用 · 工程模板 v2（改进草案）

> 版本：v2.0-draft | 代号：`web-fullstack` | 适用模式：快消型 & 长期迭代型
> 证据等级图例：**[实证]**=本机跑通留证据；**[文证]**=有来源；**[推断]**=待验证。
> 与 v1 关系：v1（530 行，`/home/orphic/proma-patches/p1-quick-engineering/apps/electron/resources/nanju-engineering-templates/web-fullstack.md`）的 §1 技术栈三表、§2 目录结构、§3 核心配置、§6 CI YAML **整体保留沿用**（该部分是六品类中实证密度最高的 [文证：含完整配置代码]），本文不重复，只新增 v2 要求的章节。新增章节的知识大多来自**分析推断**，已标注。

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

## 6. Spike 实验协议
引用 `../02-Spike实验协议.md`。本品类高发触发点：
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
| calcom/cal.com | `apps/web/`、`packages/trpc/`、turbo.json | monorepo tRPC 组织 | 待下载待解析 |
| shadcn-ui/taxonomy | `app/(marketing)/(dashboard)/` 路由组 | App Router 布局隔离 | 待下载待解析 |
| t3-oss/create-t3-app | 模板生成器目录 | 技术栈组合的脚手架化 | 待下载待解析 |

> v1 §9 的五项目清单（含 Dub/next-forge）维持"待解析"状态，解析后回填。

## 9. 常见模式与反模式
v1 §7.3 DO/DON'T 表完整保留。[文证]

---
## CHANGELOG
- v2.0-draft（2026-09-18）：新增 §0 判定/§2 组件环境/§5 闭环/§6 Spike/§7 坑库/§8 映射（标注解析状态）；v1 §1-§4、§6、§7、§9 保留沿用不重复。
- v1.0（2026-07-17）：初始 530 行版本。
