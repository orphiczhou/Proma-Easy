# 南大向导 v2.3 架构设计：两层固定路由 Harness（AC 三轮审计收敛版）

> 基于 v2.0-v2.2 设计 + AC Round 1-2 审计修正（6 red + 17 yellow → 全部修复或降级）

---

## 1. 核心定位

南大向导的工作流是**确定性管道**：

```
需求分析 → PRD 确认 → UX 原型 → 架构设计 → 工程规划 → 编码
```

不需要动态树形分支。用**固定路由状态机**替代 tree-engine（3602 行 + 68KB SKILL），大幅降低复杂度和 Agent 认知开销。

---

## 2. 两层架构

```
┌──────────────────────────────────────────────────────────┐
│  L1 调度员 (Dispatcher) — 主会话（Agent，受状态机约束）     │
│                                                          │
│  状态机: requirements → prototype → arch → planning      │
│                                                          │
│  每个阶段循环：                                            │
│    1. delegate_agent 委派角色子会话（L2）                  │
│    2. wait_for_delegations 等待完成                       │
│    3. 验证产出文件（fs.existsSync + 非空检查）             │
│    4. [可选] inline AC 审计（attacker=deepseek,           │
│       defender=glm-zhipu，跨模型对抗审查）                 │
│    5. AskUserQuestion 请求用户确认                        │
│    6. 用户确认 → 推进；用户拒绝 → 重试/修改/终止           │
│                                                          │
│  canUseTool 硬门禁：调度员自己不能写代码/文档              │
└────────────────────────┬─────────────────────────────────┘
                         │ delegate_agent（可见子会话，跨渠道）
                         ▼
┌──────────────────────────────────────────────────────────┐
│  L2 角色子会话（Agent，纯 systemPrompt + 3 件套契约）      │
│                                                          │
│  纯 systemPrompt 驱动，不加载任何 tree skill               │
│  3 件套契约: task / output_path / constraints             │
│  可用 AskUserQuestion 与用户交互（通过 blocked event 冒泡）│
│  产出文件写入指定路径                                      │
│  完成后返回结构化结果摘要                                   │
│                                                          │
│  角色: 需求分析师 / UX 顾问 / 架构师 / 工程经理             │
└──────────────────────────────────────────────────────────┘
```

**L1 调度员的定义**（修正 F3）：

L1 是一个 Agent，不是纯代码。它的**路由选择**受硬编码状态机约束（不允许自主偏离），但它的**任务执行**（委派、审计、确认、验证）是正常的 Agent 工具调用行为。

---

## 3. 路由定义

```typescript
interface PhaseNode {
  id: PhaseId
  role: string
  title: string
  channel: string
  model: string
  task: string                    // 委派给 L2 的任务描述模板
  outputPath: string              // 期望产出文件的相对路径
  constraints: string[]           // L2 的约束条件
  requiresUserConfirmation: boolean  // [F4修正] 是否需要用户确认
  requiresAC: boolean             // 是否需要 AC 审计
  retryLimit: number              // [F11修正] 最大重试次数
  next: PhaseId | null            // 下一阶段（null = 终态）
}

type PhaseId = 'requirements' | 'prototype' | 'architecture' | 'planning' | 'delivered'

// 公共节点（两条路由共享 requirements + 终态）
const SENTINEL: PhaseNode = {
  id: 'delivered',
  role: '', title: '', channel: '', model: '',
  task: '', outputPath: '', constraints: [],
  requiresUserConfirmation: false,
  requiresAC: false,
  retryLimit: 0,
  next: null,
}

const REQUIREMENTS: PhaseNode = {
  id: 'requirements',
  role: 'requirement-analyst',
  title: '需求分析师',
  channel: 'deepseek',
  model: 'deepseek-v4-pro',
  task: '你是需求分析师。与用户对话收集需求，产出 PRD。',
  outputPath: '01_PRD/prd.md',
  constraints: ['用生活化语言提问', '3-5 个引导性问题', '提供选项而非填空'],
  requiresUserConfirmation: true,
  requiresAC: false,
  retryLimit: 3,
  next: 'prototype',
}

// 工厂函数：按 mode 生成完整路由（修正 R2：显式定义所有节点）
function makeRoute(mode: 'quick' | 'iterative'): PhaseNode[] {
  const prototype: PhaseNode = {
    id: 'prototype',
    role: 'ux-advisor',
    title: 'UX 顾问',
    channel: 'glm-zhipu',
    model: 'glm-5.2',
    task: '你是 UX 顾问。根据 PRD 生成可交互 HTML 原型。',
    outputPath: '02_UX_DESIGN/prototype.html',
    constraints: ['单文件 HTML，内联 CSS', '简洁现代风格', '覆盖 PRD 核心功能'],
    requiresUserConfirmation: true,
    requiresAC: false,
    retryLimit: 2,
    next: mode === 'quick' ? 'delivered' : 'architecture',  // ← 唯一差异
  }

  if (mode === 'quick') {
    return [REQUIREMENTS, prototype, SENTINEL]
  }

  // iterative：显式包含所有节点（不再用注释省略）
  const architecture: PhaseNode = {
    id: 'architecture',
    role: 'architect',
    title: '架构师',
    channel: 'deepseek',
    model: 'deepseek-v4-pro',
    task: '你是架构设计师。根据 PRD 和原型，产出架构文档。',
    outputPath: '03_ARCHITECTURE/architecture.md',
    constraints: ['技术选型 + 目录结构', 'API 规范设计'],
    requiresUserConfirmation: true,
    requiresAC: true,
    retryLimit: 2,
    next: 'planning',
  }

  const planning: PhaseNode = {
    id: 'planning',
    role: 'engineering-manager',
    title: '工程经理',
    channel: 'deepseek',
    model: 'deepseek-v4-pro',
    task: '你是工程经理。根据架构，产出工程计划。',
    outputPath: '05_PROJECT_PLAN/plan.md',
    constraints: ['技术栈确定', '开发计划 + 里程碑'],
    requiresUserConfirmation: true,
    requiresAC: false,
    retryLimit: 2,
    next: 'delivered',
  }

  return [REQUIREMENTS, prototype, architecture, planning, SENTINEL]
}

const ROUTES: Record<'quick' | 'iterative', PhaseNode[]> = {
  quick: makeRoute('quick'),
  iterative: makeRoute('iterative'),
}
```

**路由选择逻辑**（修正 F9）：用户在 ModeSelectView 选择快消型/迭代型时确定，存入 `_nanju-projects.json` 的 `mode` 字段。

**coding 阶段 scope 声明**（修正 F5）：v2 不含 coding 阶段。planning 阶段完成后项目进入 `delivered` 终态。coding 留 v3。

---

## 4. 阶段推进机制（修正 F4 + F6 + F11）

### 4.1 推进流程

```
1. L1 委派 L2 角色（delegate_agent）
2. wait_for_delegations → 获取结构化结果

3. 文件验证（F6 修正）：
   const filePath = join(projectDir, phase.outputPath)
   if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 100) {
     → 文件缺失或过小，通知 L1 Agent "产出文件未找到，请重试或修改"
     → retryCount++，如果 retryCount >= phase.retryLimit → 通知用户失败
     → 否则重新委派 L2
   }

4. [可选] AC 审计（如果 phase.requiresAC）：
   delegate_agent(inline:true, channel='deepseek', task='攻击审查以下文档...')
   delegate_agent(inline:true, channel='glm-zhipu', task='防御审查以下文档...')
   如果 AC 发现 red severity → 通知用户，等待用户决定

5. 用户确认（F4 修正）：
   AskUserQuestion({
     header: `${phase.title} 产出确认`,
     question: `${phase.outputPath} 已生成，是否通过？`,
     options: [
       { label: '通过，进入下一阶段' },
       { label: '需要修改' },
       { label: '终止项目' },
     ]
   })

6. 根据用户选择：
   - '通过' → 推进到 phase.next
   - '需要修改' → 重新委派 L2（retryCount++）
   - '终止项目' → 标记 delivered，停止
```

### 4.2 异常恢复（F11 修正）

```typescript
interface PhaseResult {
  status: 'success' | 'failed' | 'timeout' | 'needs_modification'
  files: string[]           // 验证通过的文件列表
  acFindings?: Finding[]    // AC 审计结果
  error?: string            // 错误信息
  retryCount: number        // 当前重试次数
}

function handlePhaseResult(result: PhaseResult, phase: PhaseNode): PhaseAction {
  // 失败/超时/需修改 + 重试次数未超限 → 重试（修正 Y2：加入 needs_modification）
  if ((result.status === 'failed' || result.status === 'timeout' || result.status === 'needs_modification')
      && result.retryCount < phase.retryLimit) {
    return { action: 'retry', reason: result.error ?? 'L2 产出需要修改，正在重新委派' }
  }
  // 重试超限 → 通知用户
  if (result.retryCount >= phase.retryLimit) {
    return { action: 'notify_user', reason: `${phase.title} 已重试 ${phase.retryLimit} 次仍失败，是否终止？` }
  }
  // AC 发现 red → 通知用户
  if (result.acFindings?.some(f => f.severity === 'red')) {
    return { action: 'notify_user', reason: 'AC 审计发现严重问题，请查看后决定' }
  }
  // 正常完成 → 用户确认
  if (phase.requiresUserConfirmation) {
    return { action: 'ask_user' }
  }
  // 无需确认 → 自动推进
  return { action: 'advance' }
}
```

### 4.3 用户回退/重做（F12 修正）

调度员 systemPrompt 中增加指令：
- 用户说"回退"/"重做某阶段" → 调度员更新 `_nanju-projects.json` 的 `currentStage`
- 用户说"跳过此阶段" → 调度员直接推进到 `phase.next`，标记 skipped
- 用户说"取消" → 标记 `status: 'abandoned'`

实现：通过 L1 Agent 的 systemPrompt 指令 + `AskUserQuestion` 的选项覆盖。

---

## 5. canUseTool 硬门禁（修正 F7）

### 每阶段工具白名单

```typescript
const PHASE_TOOL_WHITELIST: Record<PhaseId, Set<string>> = {
  requirements: new Set([
    'delegate_agent', 'delegate_agents', 'wait_for_delegations',
    'list_delegations', 'stop_delegation',
    'Read', 'LS', 'AskUserQuestion',
  ]),
  prototype: new Set([
    'delegate_agent', 'delegate_agents', 'wait_for_delegations',
    'list_delegations', 'stop_delegation',
    'Read', 'LS', 'AskUserQuestion',
  ]),
  architecture: new Set([
    'delegate_agent', 'delegate_agents', 'wait_for_delegations',
    'list_delegations', 'stop_delegation',
    'Read', 'LS', 'AskUserQuestion',
  ]),
  planning: new Set([
    'delegate_agent', 'delegate_agents', 'wait_for_delegations',
    'list_delegations', 'stop_delegation',
    'Read', 'LS', 'AskUserQuestion',
  ]),
  delivered: new Set(['Read', 'LS', 'AskUserQuestion']),
}
```

**所有非 delivered 阶段都禁止**: `Write`, `Edit`, `Bash`（调度员自己不写文件）
**L2 角色子会话不受此限制**（它的 sessionId 不在 `_nanju-projects.json` 中，gate 返回 null）

---

## 6. 数据结构（修正 F8）

### _nanju-projects.json（全局，原子写）

```typescript
interface NanjuProjectState {
  projectId: string
  name: string
  mode: 'quick' | 'iterative'       // 路由类型
  status: 'active' | 'completed' | 'abandoned'
  currentStage: PhaseId
  sessionId: string                  // L1 调度员会话 ID
  workspaceSlug: string
  createdAt: string
  updatedAt: string
  stageHistory: Array<{
    phaseId: PhaseId
    startedAt: string
    completedAt?: string
    files: string[]                  // 该阶段产出的文件
    skipped?: boolean
    retryCount: number
  }>
}
```

使用 `safe-file.ts` 的 `writeJsonFileAtomic` 保证原子写。多项目并发安全（每个项目有独立的 `projectId` 和 `sessionId`，`_nanju-projects.json` 是数组，追加不冲突）。

### L2 三件套契约

```yaml
task: |
  你是{角色名}。{任务描述}
  PRD 摘要：{prdSummary 或 "无（这是需求阶段）"}
  前序产出文件（请先 Read 后再工作）：{priorArtifacts.join('、') 或 "无（这是需求阶段）"}

output_path: "{projectDir}/{phase.outputPath}"

constraints:
  - {constraint 1}
  - {constraint 2}
  - 完成后确保文件已写入 output_path
  - 用中文输出
```

---

## 7. AGENTS.md（调度员 systemPrompt）

```markdown
# 南大向导调度员

你是南大向导的调度员。当前阶段：{currentStage}

## 你的唯一职责
委派角色子会话完成工作，验证产出，引导用户确认，推进到下一阶段。

## 当前阶段信息
- 角色：{role.title}（{role.channel}/{role.model}）
- 任务：{role.task}
- 产出文件：{outputPath}
- 已重试：{retryCount}/{retryLimit} 次

## 你必须做的
1. 用 delegate_agent 委派 {role.title} 子会话
   - channelId: {role.channel}
   - modelId: {role.model}
   - task: 附带完整任务描述 + 前序阶段产出摘要
2. 用 wait_for_delegations 等待完成
3. 检查产出文件是否存在（用 Read 工具）
4. 如果需要 AC 审计（{requiresAC}），用 inline 子 Agent 做对抗审查
5. 用 AskUserQuestion 请求用户确认
6. 用户确认后，回复确认并等待系统推进

## 你绝对不能做的
- 自己写代码或文档（系统会拦截）
- 跳过用户确认直接推进
- 同时委派多个阶段的角色

## 用户指令
- 用户说"回退" → 回到上一阶段
- 用户说"跳过" → 跳过当前阶段
- 用户说"取消" → 终止项目
```

---

## 8. 实现文件清单

### 新建
1. `nanju-router.ts` — PhaseNode 定义 + ROUTES + 路由查询/推进逻辑（~150 行）
2. `nanju-router-gate.ts` — checkNanjuRouterGate（替代 checkNanjuPhaseGate）+ PHASE_TOOL_WHITELIST（~100 行）
3. `nanju-router-prompt.ts` — getNanjuRouterPrompt（替代 getNanjuPhaseGatePrompt）（~80 行）

### 修改
1. `agent-orchestrator.ts` — 替换 phase-gate 引用为 router
2. `nanju-project.ts` — 移除 tree init 逻辑，增加 stageHistory
3. `AGENTS.md` — 精简为调度员入口（不再引用 tree-commander）
4. `nanju-phase-gate.ts` — 标记 deprecated，保留函数签名兼容

### 不再引用
1. tree-commander skill（68KB 指挥官手册）
2. tree-engine 初始化（tree_init / milestone）
3. tree_audit_gate（审计树）
4. tree-worker skill（L2 不加载）

### 保留
1. delegate_agent + inline — L2 委派原语
2. wait_for_delegations — 等待结果
3. canUseTool — 状态机护栏
4. AC 方法论 skill — L1 inline 审计（软约束引导）
5. tree-engine + tree MCP 工具 — 给非南大场景用

---

## 9. 上下文管理（修正 F13 + R1）

每完成一个阶段后：
1. **由 Harness 代码**将本阶段的 AC 审计结果写入文件（`{projectDir}/_ac-audit-{phaseId}.md`）。
   使用 `safe-file.ts` 的 `writeJsonFileAtomic` / `writeFileSync`，**不是 L1 Agent 调用 Write 工具**。
   L1 受 canUseTool 硬门禁禁止 Write，Harness 层代码不受此限制。
2. L1 Agent 上下文中只保留 AC verdict 摘要（一句话）
3. 如果上下文接近窗口上限，调度员 systemPrompt 中提示 Agent 主动 compact

### Harness ↔ Agent 职责边界（修正 Y8）

| 职责 | 执行层 | 实现方式 |
|------|--------|----------|
| 路由查询（当前阶段 → PhaseNode） | Harness | `nanju-router.ts` 代码读取 |
| 工具白名单拦截 | Harness | `canUseTool` 回调，代码检查 |
| 文件验证（existsSync + size） | Harness | agent-orchestrator.ts 在 PHASE_COMPLETE 检测后执行 |
| AC 审计文件写入 | Harness | `writeJsonFileAtomic`，代码写入 |
| 项目状态持久化 | Harness | `writeJsonFileAtomic`，代码写入 |
| 委派角色（delegate_agent） | Agent | L1 systemPrompt 指令 + 工具调用 |
| 等待结果（wait_for_delegations） | Agent | L1 systemPrompt 指令 + 工具调用 |
| 用户确认（AskUserQuestion） | Agent | L1 systemPrompt 指令 + 工具调用 |
| AC 审计 inline 子 Agent | Agent | L1 systemPrompt 指令 + delegate_agent(inline) |
| 阶段推进声明 | Agent | L1 回复文本中包含推进标记 |

**核心原则**：所有涉及文件系统写入/验证/状态持久化的操作由 Harness 代码执行；
所有涉及 LLM 推理/工具调用/用户交互的操作由 L1 Agent 执行。

---

## 10. v2 scope 边界

### v2 包含
- 固定路由状态机（quick/iterative 两条路径）
- L1 delegate_agent 委派 + 文件验证 + 用户确认
- canUseTool 硬门禁
- inline AC 审计（可选，架构阶段启用）
- 异常恢复（重试 + 用户通知）

### v2 不含（留 v3）
- coding 阶段（代码生成）
- 用户回退 UI（通过自然语言指令实现，无专用按钮）
- 多项目并行编排
- AC 审计的完整 DUAL-GATE 停止协议
