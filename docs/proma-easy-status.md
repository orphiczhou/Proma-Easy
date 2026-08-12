# Proma-Easy（南大向导）项目状态文档

> 更新时间：2026-08-12 | 当前版本：v0.16.71 | 分支：linux-support

---

## 一、项目概述

Proma-Easy 是基于 [Proma](https://github.com/ErlichLiu/Proma) (v0.16.40) 的 fork，实现了"南大向导"Agent 开发平台——让零编程基础的用户通过自然语言对话完成软件需求→设计→交付的全闭环。

- **代码仓库**：`/home/orphic/proma-source`，分支 `linux-support`
- **GitHub Fork**：`github.com/orphiczhou/Proma-Easy.git`（remote: `easy`，push 因网络/对象损坏问题暂未成功）
- **设计文档**：`/home/orphic/proma-projDoc/DesignDoc/`（PRD + 用户故事 + UX 交互规范）
- **架构设计**：`docs/nanju-v2.3-design.md`（三层 AC 审计收敛版）

---

## 二、核心架构

### 2.1 两层固定路由 Harness（v2.3）

```
L1 调度员（主会话 Agent）
  ├─ canUseTool 硬门禁（不能自己写代码/文档）
  ├─ delegate_agent → 委派 L2 角色子会话（跨渠道跨模型）
  ├─ wait_for_delegations → 等待 + 代答子会话问题
  ├─ PHASE_ADVANCE 标记 → Harness 代码检测推进
  └─ v0.16.70: 推进后自动续接下一阶段（1.5秒后自动 sendMessage）

L2 角色子会话（跨渠道跨模型）
  ├─ 产出文件（PRD/原型/架构/工程计划）
  ├─ AC 对抗审计（inline subAgent，异构模型）
  │   ├─ Attacker: 不同家族模型审查（如 GLM 审查 DeepSeek 产出）
  │   ├─ Defender: 对照攻击者发现用证据反驳/确认
  │   └─ Red → 修复 → 重审（L2 自己驱动，不需要人工）
  └─ allowSubDelegation 机制（v0.16.69 新增，三层放行）
```

### 2.2 阶段路由

| 阶段 | 角色 | 渠道/模型 | 产出文件 | AC |
|------|------|----------|----------|-----|
| requirements | 需求分析师 | deepseek/v4-pro | 01_PRD/prd.md | 否（PRD 直接确认） |
| prototype | UX 顾问 | glm-zhipu/glm-5.2 | 02_UX_DESIGN/prototype.html | 否 |
| architecture | 架构师 | deepseek/v4-pro | 03_ARCHITECTURE/architecture.md | 是 |
| planning | 工程经理 | deepseek/v4-pro | 05_PROJECT_PLAN/plan.md | 否 |

快消型模式：requirements → prototype → delivered
长期迭代型：requirements → prototype → architecture → planning → delivered

---

## 三、实现文件清单

### 主进程（src/main/lib/）

| 文件 | 行数 | 作用 | 版本 |
|------|------|------|------|
| nanju-router.ts | 243 | 路由状态机定义 + 异构 AC 模型配置 | v0.16.69 |
| nanju-router-gate.ts | 138 | canUseTool 硬门禁 + 文件验证 | v0.16.62 |
| nanju-router-prompt.ts | 179 | 调度员 systemPrompt 生成（含 L2 AC 指令） | v0.16.69 |
| nanju-project.ts | 174 | 项目元数据管理（原子写 JSON） | v0.16.53 |
| nanju-preview-watcher.ts | 128 | 文件监听（Linux 递归修复） | v0.16.69 |
| nanju-ipc.ts | 153 | IPC handlers 注册 | v0.16.53 |
| nanju-orchestrator.ts | 166 | 角色编排（旧版，部分 deprecated） | v0.16.53 |
| nanju-phase-gate.ts | 318 | 旧版阶段门禁（deprecated，保留兼容） | v0.16.60 |
| nanju-snapshot.ts | 101 | 项目快照管理 | v0.16.53 |
| nanju-telemetry.ts | 89 | 埋点记录 | v0.16.53 |
| agent-orchestrator.ts | ~2269 | PHASE_ADVANCE 检测 + 自动续接 | v0.16.70 |
| agent-collaboration-tools.ts | ~1110 | delegate_agent + allowSubDelegation | v0.16.69 |
| agent-collaboration-utils.ts | ~140 | buildDelegationPrompt | v0.16.69 |
| adapters/pi-builtin-tools.ts | ~920 | collaboration 工具注册条件 | v0.16.69 |

### 渲染进程

| 文件 | 作用 | 版本 |
|------|------|------|
| components/nanju/ModeSelectView.tsx | 快消型/长期迭代型选择 | v0.16.47 |
| components/nanju/NanjuWorkspaceView.tsx | 左右分屏布局（当前未使用） | v0.16.55 |
| components/nanju/ProjectListView.tsx | 项目列表 | v0.16.58 |
| components/app-shell/AppShell.tsx | 工作区入口 + 文件监听启动 | v0.16.71（移除预览 handler） |
| hooks/useGlobalAgentListeners.ts | **全局预览监听**（v0.16.71 迁移到此） | v0.16.71 |
| components/tabs/MainArea.tsx | 预览面板分屏渲染 | v0.16.55 |
| components/tabs/TabContent.tsx | 项目创建 → 会话 Tab 切换 | v0.16.47 |

---

## 四、版本变更历史（v0.16.62 - v0.16.71）

| 版本 | 内容 |
|------|------|
| v0.16.62 | 实现 v2.3 固定路由 Harness（替代 tree-engine） |
| v0.16.63 | 代码审计 R1 修复（0 red, 3 yellow + 4 green） |
| v0.16.64 | 修复 mcp__collaboration__ 前缀缺失 |
| v0.16.65 | 修复 PRD 预览面板不弹出（第一次尝试） |
| v0.16.66 | 修复委派子会话 AskUserQuestion 对话框 |
| v0.16.67 | 回退 UI 冒泡，改用 Proma 原始 Agent 层代答 |
| v0.16.68 | 修复预览分屏+阶段推进+AC审计（未完全解决） |
| v0.16.69 | **AC 从 L1 移到 L2 内部驱动 + Linux fs.watch 递归修复 + allowSubDelegation 三层放行** |
| v0.16.70 | **PHASE_ADVANCE 后自动续接下一阶段** |
| v0.16.71 | **预览面板监听移至全局 hook（消除竞态条件）** |

---

## 五、测试验证状态

### 5.1 已验证通过（MCP 远程驱动）

| 功能 | 验证方式 | 状态 |
|------|----------|------|
| L1 委派 L2 子会话 | MCP send_message + 日志 | ✅ |
| delegate_agent 跨渠道 | deepseek + glm-zhipu | ✅ |
| allowSubDelegation 三层放行 | L2 成功创建 AC 子会话 | ✅ |
| AC 审计由 L2 驱动 | L2 自主创建 Attacker/Defender | ✅ |
| AC 修复循环 | PRD v1.0→v1.1→v1.2→v1.3（4 轮） | ✅ |
| 异构模型 | Attacker=glm-zhipu, Defender=deepseek | ✅（v70 测试确认） |
| Linux 文件监听递归 | 112+ 目录覆盖 | ✅ |
| 文件变更通知主进程 | 日志 5+ 次检测到 prd.md | ✅ |
| canUseTool 硬门禁 | TaskCreate/TaskUpdate 被拦截 | ✅ |
| PRD 文件产出 | 8805-12923 字节 markdown | ✅ |
| Typecheck | 0 errors | ✅ |
| 单元测试 | 508 pass / 0 fail | ✅ |

### 5.2 已实现但未完全验证

| 功能 | 当前状态 | 待验证 |
|------|----------|--------|
| 预览面板弹出 | v0.16.71 将监听移至全局 hook | UI 中确认右侧面板是否显示 |
| 阶段自动续接 | v0.16.70 代码已实现 | AC 完成后是否自动进入 UX 阶段 |
| UX 原型阶段 | 路由定义已完成 | prototype.html 生成 + 预览 |

### 5.3 已知问题

| 问题 | 根因 | 修复建议 |
|------|------|----------|
| GLM 渠道 modelId=None | delegate_agent 跨渠道时 LLM 没传 modelId | startDelegation 中自动选默认模型 |
| GitHub push 失败 | 网络不稳定 + 服务端对象 52d54318 损坏 | 尝试新建空仓库推送 |
| NanjuWorkspaceView 未使用 | TabContent 用 AgentView 渲染 | 保留或重构为 MainArea 分屏 |
| AC 审计耗时较长 | 每轮 ~2-3 分钟，完整 4 轮 ~10 分钟 | 考虑限制最大轮次或并行化 |

---

## 六、可用渠道与模型

| 渠道 ID | Provider | 可用模型 |
|---------|----------|----------|
| deepseek | deepseek | deepseek-v4-pro, deepseek-v4-flash |
| glm-zhipu | zhipu | glm-5.2, glm-5-turbo, GLM-4.6V |
| ad74ac74-... | minimax | MiniMax-M3, MiniMax-M2.7-highspeed |

---

## 七、关键配置

- **Proma 配置目录**：`~/.proma/`（打包版）/ `~/.proma-dev/`（开发版）
- **南大工作区**：`~/.proma/agent-workspaces/workspace-1786421210929/`
- **项目元数据**：`workspace-files/_nanju-projects.json`
- **MCP Bridge**：`http://127.0.0.1:19876`
- **启动注意**：必须 `unset ELECTRON_RUN_AS_NODE`（Prime Agent 环境会设置此变量）
- **DISPLAY**：`:10.0`（Xvfb 可用）

---

## 八、MCP Bridge API

| 工具 | 方法 | 参数 |
|------|------|------|
| get_instance_info | GET | - |
| list_workspaces | POST | - |
| list_sessions | POST | workspace_id?, limit? |
| create_session | POST | title, channel_id, workspace_id, model_id? |
| send_message | POST | session_id, message, channel_id?, wait? |
| list_messages | POST | session_id, limit? |
| get_session_info | POST | session_id |
| get_session_context | POST | session_id |
| fork_session | POST | source_session_id |
| archive_session | POST | session_id, archived? |
