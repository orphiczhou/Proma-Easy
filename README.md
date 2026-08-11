# Proma-Easy 🚀

> 增强版 Proma — 集成 Tree/Session MCP 工具 + 南大 Agent 向导（双脑协作平台）

基于 [Proma](https://github.com/ErlichLiu/Proma) Linux 支持版本，增加了以下核心能力：

## 🌳 MCP 工具集成

- **`mcp__tree__*`（29 个工具）** — 树状任务分解引擎（V10 加固版）
- **`mcp__session__*`（11 个工具）** — 会话间通信与编排
- **`mcp__remote-session__*`（12 个工具）** — HTTP 桥接的远程会话控制
- **外部 MCP 桥接** — 端口 19876-19895，支持 stdio MCP 服务器接入

## 🏫 南大 Agent 向导（Nanju）

双脑协作平台：**向导 Agent**（引导需求） + **编码 Agent**（实现方案）

- **M1 模式选择** — 快消型（快速原型）/ 长期迭代型（Sprint 规划）
- **M2 工作区** — 左侧对话 + 右侧 HTML 原型预览（平铺布局）
- **M3 自动预览** — HTML 文件监听，自动打开预览分屏
- **M4 角色编排** — 4 个角色（需求分析师 → UX 顾问 → 架构师 → 工程经理）
- **M5 项目列表** — 状态筛选、卡片视图、时间线
- **M6 文档骨架** — 7 目录自动创建（01_PRD ~ 07_VERSIONS）
- **M7 快照管理** — 基于 fork_session 的线性回滚
- **M8 E2E 测试** — 9/9 全通过

## 🛠 技术栈

- Electron + React + Vite + Tailwind
- Bun monorepo（不使用 npm/pnpm）
- Jotai 状态管理
- Pi Agent runtime
- 本地优先（JSON/JSONL 持久化，无数据库）

## 📦 构建

```bash
bun install
cd apps/electron
bun run build
bun run pack
```

## 📝 版本

v0.16.44
