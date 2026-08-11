
# 南大向导 v2 架构设计：三层固定路由 Harness

## 问题诊断

### 当前 tree-engine 的问题
自检实测（v0.16.61）暴露：
1. **Auditor 独立性鸡生蛋**：Agent 花了 15+ 工具调用在 auditor 注册、命名规范、信任锚点上打转，从未推进到 UX 阶段
2. **tree-engine 太重**：68KB 的 tree-commander SKILL + 3602 行 tree-engine.cjs，对于固定流程的项目向导是过度工程
3. **状态不透明**：Agent 需要反复 `tree_help` 查用法，消耗大量上下文

### 核心洞察
南大向导的工作流是**固定的先后顺序**，不是动态树。从 PRD 和用户故事看：

```
需求分析 → PRD 确认 → UX 原型 → 架构设计 → 工程规划 → 编码
```

这是一个**确定性管道**（deterministic pipeline），不需要 tree 的动态分支/剪枝/审计树。

---

## 框架调研结论

| 框架 | 模式 | 适配度 | 问题 |
|------|------|--------|------|
| LangGraph | StateGraph + Supervisor | ⭐⭐⭐ | Python 生态，需独立服务，与 Proma (Electron/TypeScript) 架构不符 |
| CrewAI | Sequential Process | ⭐⭐⭐ | Python，概念最接近（角色 + 固定任务序列），但引入外部依赖 |
| awesome-harness-engineering | State machine guardrails | ⭐⭐⭐⭐⭐ | **就是 Proma 已有的架构**：canUseTool phase-gate = state machine guardrails |

**结论：不需要引入外部框架。** Proma 已有的 `canUseTool` 硬门禁 + `delegate_agent` 委派 + `inline` 子 Agent，正好构成一个轻量级 harness 的三个原语。我们只需要把它们组织成清晰的三层结构。

---

## 三层固定路由架构

```
┌─────────────────────────────────────────────────────────┐
│  L1: 调度员 (Dispatcher) — 主会话                        │
│  ┌───────────────────────────────────────────────────┐  │
│  │  固定路由状态机 (nanju-router.ts)                   │  │
│  │  state: "requirements" → "prototype" → "arch" → …  │  │
│  │  每个状态：                                          │  │
│  │    1. 注入角色 prompt（systemPrompt）                │  │
│  │    2. canUseTool 硬门禁（限制工具集）                │  │
│  │    3. 完成条件检测（文件存在？用户确认？）            │  │
│  └───────────────────────────────────────────────────┘  │
│                         │                                │
│    ┌────────────────────┼────────────────────┐          │
│    ▼                    ▼                    ▼          │
│  delegate_agent      delegate_agent      delegate_agent  │
│  (可见子会话)        (可见子会话)        (可见子会话)      │
└────┬───────────────────┬───────────────────┬────────────┘
     │                   │                   │
     ▼                   ▼                   ▼
┌─────────┐      ┌──────────┐       ┌────────────┐
│ L2: 角色  │      │ L2: 角色  │       │ L2: 角色    │
│ 需求分析师│      │ UX 顾问   │       │ 架构师      │
│ deepseek │      │ glm-zhipu│       │ deepseek   │
│          │      │          │       │            │
│ ┌──────┐ │      │          │       │ ┌──────┐  │
│ │L3:AC │ │      │          │       │ │L3:AC │  │
│ │attack│ │      │          │       │ │attack│  │
│ │inline│ │      │          │       │ │inline│  │
│ ├──────┤ │      │          │       │ ├──────┤  │
│ │L3:AC │ │      │          │       │ │L3:AC │  │
│ │defend│ │      │          │       │ │defend│  │
│ │inline│ │      │          │       │ │inline│  │
│ └──────┘ │      │          │       │ └──────┘  │
└─────────┘      └──────────┘       └────────────┘
```

### L1: 调度员 (Dispatcher) — 固定路由状态机

**不是 Agent，是代码。** 调度员不"思考"该做什么——路由是硬编码的。

```typescript
// nanju-router.ts
const ROUTE: PhaseNode[] = [
  {
    id: 'requirements',
    role: 'requirement-analyst',
    title: '需求分析师',
    channel: 'deepseek',
    model: 'deepseek-v4-pro',
    prompt: '收集需求，产出 PRD → {projectDir}/01_PRD/prd.md',
    completion: { type: 'file_exists', path: '01_PRD/prd.md' },
    next: 'prototype',
  },
  {
    id: 'prototype',
    role: 'ux-advisor',
    title: 'UX 顾问',
    channel: 'glm-zhipu',
    model: 'glm-5.2',
    prompt: '根据 PRD 生成 HTML 原型 → {projectDir}/02_UX_DESIGN/prototype.html',
    completion: { type: 'file_exists', path: '02_UX_DESIGN/prototype.html' },
    next: 'architecture',  // 或 'delivered'（快消型）
  },
  {
    id: 'architecture',
    role: 'architect',
    title: '架构师',
    channel: 'deepseek',
    model: 'deepseek-v4-pro',
    prompt: '根据 PRD + 原型，产出架构文档 → {projectDir}/03_ARCHITECTURE/architecture.md',
    completion: { type: 'file_exists', path: '03_ARCHITECTURE/architecture.md' },
    next: 'planning',
  },
  // ... planning → coding
]
```

**调度员会话的 systemPrompt 只说三件事：**
1. 你是调度员，当前处于 X 阶段
2. 你的任务是用 `delegate_agent` 委派 {角色} 子会话
3. 不要自己做，委派后等结果，检查产出文件，用户确认后推进

### L2: 角色子会话 — delegate_agent (可见)

每个阶段一个 `delegate_agent` 可见子会话：
- **渠道/模型**：按角色配置（UX 顾问用 glm-zhipu，其他用 deepseek）
- **Skill**：加载 tree-worker（精简版，只取契约解析 + 自审部分）
- **5 件套契约**：调度员通过 delegate_agent 的 task 参数下发
- **产出**：文件写入指定路径（PRD → 01_PRD/prd.md，原型 → 02_UX_DESIGN/prototype.html）

### L3: 审计/辅助 — inline 子Agent (不可见)

角色子会话内部可用 `delegate_agent(inline:true)` 派发不可见子 Agent：
- **AC 攻击者** (deepseek)：审查 PRD/架构文档的缺陷
- **AC 防御者** (glm-zhipu)：反驳或接受攻击者的 findings
- **实现者**：辅助编码（如果角色需要）

**这是软约束层**：AC 方法论通过 SKILL.md 的 prompt 引导，不是硬门禁。
L3 的 inline Agent 不受 canUseTool phase-gate 限制（因为它们的产出是文本，不是文件）。

---

## 与 tree-engine 的关系

| 能力 | tree-engine (弃用) | nanju-router (新) |
|------|-------------------|-----------------|
| 流程控制 | 动态树（leaf_add/milestone/audit_gate） | 固定路由状态机 |
| 状态存储 | tree-state.json + 29 个 MCP 工具 | _nanju-projects.json + currentStage 字段 |
| 审计 | tree_audit_gate（硬约束，鸡生蛋） | inline AC（软约束，可选） |
| Agent 认知开销 | 高（68KB SKILL + 反复 tree_help） | 低（精简 systemPrompt + 固定路由） |
| 代码量 | tree-engine.cjs 3602 行 + tree-mcp-tools.ts | nanju-router.ts ~200 行 |

**tree-engine 的 29 个 MCP 工具保留在 Proma 中**，用户需要动态树形任务管理时仍可用。
只是南大向导不再依赖它。

---

## 实现计划

### 需要新建
1. **nanju-router.ts** — 固定路由定义 + 状态推进逻辑
2. **nanju-router-prompt.ts** — 按阶段生成精简 systemPrompt（替代 nanju-phase-gate.ts）

### 需要修改
1. **agent-orchestrator.ts** — `getNanjuPhaseGatePrompt` → `getNanjuRouterPrompt`
2. **agent-orchestrator.ts** — `checkNanjuPhaseGate` → `checkNanjuRouterGate`（简化工具过滤）
3. **AGENTS.md** — 精简为调度员入口指令（不再引用 tree-commander）
4. **nanju-project.ts** — 移除 tree init 逻辑（不再需要 treeId）

### 可以保留
1. `delegate_agent` + `inline` — L2/L3 委派原语
2. `collaboration.wait_for_delegations` — 等待结果
3. `canUseTool` 硬门禁 — 仍用于限制调度员自己写代码
4. AC 方法论 skill — L3 inline 审计引导（软约束）
5. tree-worker skill — L2 角色子会话的契约解析指南（精简引用）

### 可以删除
1. tree-commander SKILL 引用 — 不再让调度员加载
2. tree-engine 初始化 — 不再 tree_init/milestone
3. tree_audit_gate 调用 — 不再强制审计树


---

## 审计修正（v2.1）

### 🔴 修正 #1：L3 层不可能存在

**问题**：`delegate_agent` 硬编码 `delegationDepth > 0` 即拦截（agent-collaboration-tools.ts:282）。
L2 子会话无法再派子会话，三层架构的 L3 inline AC 审计不可行。

**修正**：改为**两层架构 + L1 侧审计**

```
L1 调度员（主会话）
  ├── requirements 阶段：
  │   ├── 委派需求分析师（delegate_agent, deepseek）
  │   ├── 等待完成 → AC 审计（inline: attacker=deepseek, defender=glm-zhipu）
  │   └── 文件验证 + 用户确认 → 推进
  ├── prototype 阶段：
  │   ├── 委派 UX 顾问（delegate_agent, glm-zhipu）
  │   └── 文件验证 + 用户确认 → 推进
  └── ...

L2 角色子会话（delegate_agent，可见）
  ├── 接收精简契约（不是 tree-worker 5 件套，而是简单 task 描述）
  ├── 执行任务（写 PRD / HTML / MD）
  └── 完成后自动返回结果摘要
```

AC 审计由 **L1 调度员** 在角色子会话完成后、用户确认前发起（inline 模式，不占可见会话）。

### 🔴 修正 #2：完成条件必须验证文件存在

**问题**：`[PHASE_COMPLETE:prototype]` 只是文本标记，Agent 可以谎报。
**修正**：在 PHASE_COMPLETE 检测后加 `fs.existsSync` 检查产出文件：

```typescript
const PHASE_FILES: Record<string, string> = {
  'prototype': '02_UX_DESIGN/prototype.html',
  'architecture': '03_ARCHITECTURE/architecture.md',
  'planning': '05_PROJECT_PLAN/plan.md',
}
// 检测到 PHASE_COMPLETE:X 后，检查对应文件是否存在
```

文件不存在 → 不推进，返回提示让 Agent 补产出。

### 🟡 修正 #3：支持快消型短路径

```typescript
const QUICK_ROUTE = ['requirements', 'prototype', 'delivered']
const ITERATIVE_ROUTE = ['requirements', 'prototype', 'architecture', 'planning', 'coding']
```

### 🟡 修正 #4：L2 不加载 tree-worker skill

L2 角色子会话用**纯 systemPrompt**，不引用任何 tree skill。
契约从 tree-commander 的 5 件套简化为 3 件：

```yaml
task: "根据以下 PRD 生成 HTML 原型"
output_path: "{projectDir}/02_UX_DESIGN/prototype.html"
constraints:
  - "单文件 HTML，内联 CSS"
  - "简洁现代风格"
  - "覆盖 PRD 中的所有核心功能页面"
```
