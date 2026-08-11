# 南大向导 v2 AC 审计记录

## Attacker (DeepSeek V4 Pro)

# AC 攻击者审查报告：南大向导 v2 架构设计

---

## Findings 总览

| # | 维度 | Severity | 摘要 |
|---|------|----------|------|
| F1 | C1 | 🔴 red | v2.0 三层架构图与 v2.1 修正相互矛盾，文档内自毁 |
| F2 | C1 | 🔴 red | "保留 tree-worker" 与 修正#4 "不加载 tree-worker" 直接冲突 |
| F3 | C1 | 🟡 yellow | 调度员定义摇摆——"不是 Agent，是代码" vs 需要运行 AC inline 审计 |
| F4 | C2 | 🔴 red | 用户确认机制完全缺失——路由仅靠文件存在推进，违反"用户驱动"目标 |
| F5 | C2 | 🟡 yellow | coding 阶段在路由定义中缺失，与 PRD 流程不一致 |
| F6 | C3 | 🔴 red | `PHASE_COMPLETE:X` 文本标记检测机制不可靠且未定义如何实现 |
| F7 | C3 | 🟡 yellow | `canUseTool` phase-gate 声称是已有架构，但无引用/接口说明 |
| F8 | C3 | 🟡 yellow | `_nanju-projects.json` 结构未定义；多项目并发、状态恢复未覆盖 |
| F9 | C4 | 🟡 yellow | 快消型/迭代型路由选择逻辑完全空白 |
| F10 | C4 | 🟡 yellow | 路由推进是自动还是手动？文档两处描述矛盾 |
| F11 | A1 | 🔴 red | L2 子会话失败、超时、产出文件缺失/错误——零恢复机制 |
| F12 | A1 | 🟡 yellow | 用户中途取消、回退上一阶段、重做某阶段——零覆盖 |
| F13 | A1 | 🟡 yellow | 调度员上下文膨胀风险——多阶段 inline 审计累加，无清理策略 |

---

## 详细 Findings

---

### 🔴 F1 | C1 自洽性 | v2.0 三层架构图与 v2.1 修正自相矛盾

**Severity**: red（阻断 — 文档本身的结构会让实现者无法判断哪个版本是正确的）

**Evidence**:

> 三层固定路由架构 图中明确画出：
> ```
> L3:AC attack inline
> L3:AC defend inline
> ```

> 审计修正 #1：L3 层不可能存在
> `delegate_agent` 硬编码 `delegationDepth > 0` 即拦截...三层架构的 L3 inline AC 审计不可行。

> 修正后的架构图变为两层：
> ```
> L1 → 委派需求分析师 → AC 审计（inline: attacker=deepseek, defender=glm-zhipu）
> ```

**问题**：v2.0 主架构图和 v2.1 修正版架构图同时存在于同一文档中，且 v2.0 图**未被标记为废弃**。实现者会看到两层互相矛盾的架构。更严重的是，v2.1 的 L1 侧审计方案把 inline AC 从子会话内部搬到了主会话——但主调度员此时还要同时等待结果、检查文件、做确认。职责边界模糊。

**Fix**: 
1. 删除或明确标记 v2.0 三架构图为"已废弃"
2. 将 v2.1 修正后的架构图提升为**唯一正式架构**
3. 明确 L1 调度员在"等待→审计→确认→推进"循环中的状态转换

---

### 🔴 F2 | C1 自洽性 | "保留 tree-worker" 与修正 #4 直接冲突

**Severity**: red（阻断 — 实现者无法判断该不该加载 tree-worker）

**Evidence**:

> 可以保留...5. tree-worker skill — L2 角色子会话的契约解析指南（精简引用）

> 修正 #4：L2 不加载 tree-worker skill

**问题**：保留清单明确说保留 tree-worker 给 L2 角色子会话用，但修正 #4 明确说 L2 不加载任何 tree skill。两份指令同时有效，且优先级未定义——实现者会选错。

**Fix**: 从"可以保留"中删除第 5 项，或改为"tree-worker skill 保留在 Proma 中供其他用途，南大向导不引用"。

---

### 🟡 F3 | C1 自洽性 | 调度员身份定义摇摆

**Severity**: yellow

**Evidence**:

> **不是 Agent，是代码。** 调度员不"思考"该做什么——路由是硬编码的。

> AC 审计由 **L1 调度员** 在角色子会话完成后、用户确认前发起（inline 模式，不占可见会话）。

**问题**：前半句说调度员是纯代码状态机，后半句说它要运行 inline AC 审计——这是一项需要"理解 PRD 内容并发起攻击"的认知密集型任务，不可能由硬编码状态机完成。实际上 L1 调度员**必然是一个 Agent**（否则无法发起有意义的 AC 攻击），只是它的路由选择被限制在固定路径上。

**Fix**: 重新定义为 "L1 调度员是 Agent，其路由选择受硬编码状态机约束，不允许自主偏离"。区分"路由决策自动化"和"任务执行 Agent"两层。

---

### 🔴 F4 | C2 保真度 | 用户确认机制完全缺失

**Severity**: red（阻断 — 违反 PRD 中"用户驱动"的核心约束）

**Evidence**:

> 每个状态：...3. 完成条件检测（文件存在？用户确认？）

> 调度员...不要自己做，委派后等结果，检查产出文件，用户确认后推进

**问题**：全文**从未定义**"用户确认"是什么机制。是：
- 调度员直接用 `AskUserQuestion` 弹窗？
- 等待用户在聊天中回复"通过"/"继续"？
- 自动推进，用户可随时喊停？

这三种行为差异巨大。且完成条件中的 `completion: { type: 'file_exists', path: '01_PRD/prd.md' }` 完全没有 `requires_user_confirmation` 字段——如果文件存在就自动推进，等于绕过了用户确认。

**Fix**: 
1. 在 `PhaseNode` 类型中增加 `requiresUserConfirmation: boolean` 字段
2. 定义确认机制：调度员调用 `AskUserQuestion({ header: "阶段产出确认", question: "PRD 是否通过？", options: ["通过，进入下一阶段", "需要修改", "跳过此阶段"] })`
3. 用户不确认时路由卡在当前阶段，不做任何推进

---

### 🟡 F5 | C2 保真度 | coding 阶段在路由定义中缺失

**Severity**: yellow

**Evidence**:

> PRD 流程：需求分析 → PRD 确认 → UX 原型 → 架构设计 → 工程规划 → **编码**

```typescript
const ROUTE: PhaseNode[] = [
  { id: 'requirements', ... next: 'prototype' },
  { id: 'prototype', ... next: 'architecture' },
  { id: 'architecture', ... next: 'planning' },
  // ... planning → coding
]
```

**问题**：`planning → coding` 被注释掉（`// ...`），且 ITERATIVE_ROUTE 也只到 `'coding'`（无定义）。coding 阶段的 `PhaseNode`、完成条件、角色分配全部缺失。

**Fix**: 补充 coding 阶段的完整定义，或显式声明"v2 scope 不含 coding 阶段，规划阶段为终点，coding 留 v3"。

---

### 🔴 F6 | C3 可造性 | `PHASE_COMPLETE:X` 文本标记检测不可靠

**Severity**: red（阻断 — 核心推进机制的实现未定义）

**Evidence**:

> `[PHASE_COMPLETE:prototype]` 只是文本标记，Agent 可以谎报。

> 在 PHASE_COMPLETE 检测后加 `fs.existsSync` 检查产出文件

**问题**：
1. **谁输出这个标记**？L2 子会话在 task 描述中被要求输出这个标记？如果是，它可能忘记、可能拼错、可能输出 `PHASE_DONE:prototype` 之类变体。
2. **谁检测这个标记**？L1 调度员需要解析 `delegate_agent` 的返回文本——但 `delegate_agent` 返回的是结构化摘要（`get_delegation_results`），不是原始对话文本。标记可能根本不在返回的摘要里。
3. **`fs.existsSync` 在哪里执行**？如果 L1 和 L2 共享文件系统（同一工作区），可行。但 `existsSync` 检查的是相对于谁的路径？`{projectDir}` 变量由谁解析？
4. 文件存在不代表内容正确——Agent 可能写了一个只有 `<html></html>` 的空文件然后输出 `PHASE_COMPLETE`。

**Fix**: 
1. 放弃文本标记，改为显式 API：`delegate_agent` 的 `expectedOutput` 中要求返回结构化 JSON `{ phase: "prototype", status: "done", files: ["02_UX_DESIGN/prototype.html"] }`
2. L1 解析返回的结构化数据，验证 `files` 数组中每个文件存在且**非空**
3. 实现 `phaseCompletionCheck(phaseId: string, result: DelegateResult): CompletionVerdict`

---

### 🟡 F7 | C3 可造性 | `canUseTool` phase-gate 无接口说明

**Severity**: yellow

**Evidence**:

> Proma 已有的 `canUseTool` 硬门禁 + delegate_agent 委派 + inline 子 Agent，正好构成一个轻量级 harness 的三个原语。

> 2. canUseTool 硬门禁（限制工具集）

**问题**：`canUseTool` 被列为已有原语，但：
- 无 `canUseTool` 的 API 签名或引用文档
- 无说明如何把 `canUseTool` 和路由状态绑定（`requirements` 阶段允许哪些工具？`prototype` 阶段允许哪些？）
- 南大向导的 `systemPrompt` 中说"不要自己做"——但如果调度员本身就是 Agent，它仍然**可以被 prompt 说服**去自己做，`canUseTool` 是唯一硬防线。防线不定义清楚等于没有防线。

**Fix**: 
1. 补充 `canUseTool(phaseId: PhaseId) → ToolAllowlist` 的接口定义
2. 明确每个阶段允许的工具集（如 requirements 阶段：仅 `delegate_agent`, `wait_for_delegations`, `read`, `AskUserQuestion`，禁止 `write`, `bash`, `edit`）
3. 提供 phase-gate 配置的最小示例

---

### 🟡 F8 | C3 可造性 | `_nanju-projects.json` 结构与并发未定义

**Severity**: yellow

**Evidence**:

> `_nanju-projects.json` + currentStage 字段

**问题**：
- 文件 schema 未定义（字段列表、类型、示例）
- 多项目并发场景：两个南大向导项目同时运行时，`_nanju-projects.json` 是全局单例还是每个项目目录一个？读写竞争如何处理？
- 状态恢复：调度员会话崩溃/重启后，如何从 `_nanju-projects.json` 恢复当前阶段和上下文？
- `currentStage` 是每个项目的还是全局的？

**Fix**: 
```typescript
interface NanjuProjectState {
  projectId: string;
  projectDir: string;
  currentStage: PhaseId;
  stageHistory: { phaseId: PhaseId; startedAt: number; completedAt?: number; files: string[] }[];
  routeType: 'quick' | 'iterative';
  createdAt: number;
}
```
每个项目目录下存 `_nanju-project.json`（单例），主调度员启动时扫描所有活跃项目。

---

### 🟡 F9 | C4 可懂性 | 快消型/迭代型路由选择逻辑空白

**Severity**: yellow

**Evidence**:

```typescript
const QUICK_ROUTE = ['requirements', 'prototype', 'delivered']
const ITERATIVE_ROUTE = ['requirements', 'prototype', 'architecture', 'planning', 'coding']
```

**问题**：两条路由何时选哪条？
- 用户启动时选？
- 根据 PRD 内容自动判断？
- 在 requirements 阶段结束后让用户选？
- `delivered` 是什么状态？是阶段还是终态？它在 `ROUTE: PhaseNode[]` 中没有定义。

**Fix**: 
1. 在 L1 调度员启动时加入路由选择步骤：`AskUserQuestion({ question: "项目类型？", options: ["快消型（原型即交付）", "迭代型（完整工程流程）"] })`
2. 定义 `delivered` 为终态（`next: null`），执行项目归档操作
3. 把 `ROUTE` 改为 `ROUTES: Record<'quick' | 'iterative', PhaseNode[]>`

---

### 🟡 F10 | C4 可懂性 | 路由推进：自动 vs 手动矛盾

**Severity**: yellow

**Evidence**:

> 调度员...路由是硬编码的。每个状态：完成条件检测...用户确认后推进

> 文件不存在 → 不推进，返回提示让 Agent 补产出。

**问题**：第一段暗示"确认后自动推进"，第二段暗示"调度员主动检测并决定是否推进"。如果调度员"不是 Agent，是代码"，它不能"返回提示让 Agent 补产出"——代码只能抛异常或设置状态。这里把调度员当作 Agent 在描述。

**Fix**: 统一为 Agent 驱动模型：L1 调度员是一个运行固定 systemPrompt（含状态机）的 Agent，它检测→判断→提示→等待→推进。状态机是它的约束，不是它的全部。

---

### 🔴 F11 | A1 反向映射 | L2 子会话失败——零恢复机制

**Severity**: red（阻断 — 任何生产环境中子会话都会以某种概率失败）

**Evidence**:

> 等待完成 → AC 审计 → 文件验证 + 用户确认 → 推进

**问题**：整个流程描述了 happy path。以下场景覆盖为零：
1. **L2 模型超时/报错**：`delegate_agent` 返回 error 状态。调度员做什么？重试？降级？通知用户？
2. **L2 产出文件写到了错误路径**：文件不存在 → 返回提示"补产出"。但调度员不知道正确路径时怎么补？
3. **L2 的产出质量极差**（如 PRD 只有一句话）：文件存在检查通过，AC 审计可能发现问题，但 AC 的 findings 只是软约束——如果 AC 给了大量 red，路由还推进吗？
4. **inline AC 审计本身超时**：调度员卡在审计步骤怎么办？
5. **用户确认超时**：用户离开，`AskUserQuestion` 悬挂。有超时策略吗？

**Fix**: 
```typescript
interface PhaseResult {
  status: 'success' | 'failed' | 'timeout' | 'needs_review';
  delegateResult?: DelegateResult;
  acFindings?: Finding[];
  error?: string;
  retryCount: number;
}

function handlePhaseCompletion(result: PhaseResult): 'advance' | 'retry' | 'abort' | 'wait_for_user' {
  if (result.status === 'failed' && result.retryCount < 3) return 'retry';
  if (result.acFindings?.some(f => f.severity === 'red')) return 'wait_for_user';
  // ...
}
```

---

### 🟡 F12 | A1 反向映射 | 用户交互异常场景零覆盖

**Severity**: yellow

**Evidence**: 全文无任何异常场景描述

**问题**：
- **用户中途取消**：用户说"算了，不要做架构了"。调度员怎么终止当前 L2 子会话？怎么标记项目状态？
- **用户要回退**："UX 原型不行，回到 PRD 重新做"。路由只定义了 `next`（前进），没有 `prev`（回退）。状态机只能单向推进。
- **用户要跳过某阶段**：路由没有 skip 机制。
- **用户说"重做这个阶段"**：当前阶段的 `completion` 已满足（文件存在），不会重新触发。
- **用户修改了 PRD 后想重跑原型**：原型阶段的文件已存在，router 可能直接认为完成而跳过。

**Fix**: 
1. 在 `PhaseNode` 中加 `allowBacktrack: boolean` 和 `allowSkip: boolean`
2. 调度员 systemPrompt 中增加指令："听到用户说'回退/重做/跳过/取消'时，调用对应操作"
3. 实现 `forceStage(phaseId)` 函数，重置目标阶段的 completion 状态

---

### 🟡 F13 | A1 反向映射 | 调度员上下文膨胀风险

**Severity**: yellow

**Evidence**:

> AC 审计由 L1 调度员在角色子会话完成后、用户确认前发起（inline 模式）

**问题**：inline AC 攻击+防御的输出是长文本（attack findings + defend rebuttals + arbiter verdicts）。如果项目走 ITERATIVE_ROUTE（5 个阶段），每个阶段都跑 inline AC，调度员会话的上下文会被 5 轮审计文本填满。加上每轮的 delegate_agent 返回摘要、用户对话，6 阶段后上下文可能超出窗口。

**Fix**: 
1. inline AC 的输出写入项目文件（`01_PRD/ac-audit.md`），不保留在对话上下文中
2. 调度员只读取 AC 的 summary verdict（一句话结论），判断是否放行
3. 在路由状态机中增加上下文检查点，超过阈值时触发 `CompactContext`

---

## 总结

| 严重度 | 数量 | 阻断原因 |
|--------|------|----------|
| 🔴 red | 5 | F1(架构自毁) F2(skill冲突) F4(无用户确认) F6(完成检测不可靠) F11(零异常恢复) |
| 🟡 yellow | 8 | 其余 |

**总体评价**：这份设计文档是一次**有价值的简化尝试**——从 tree-engine 的过度工程回归固定管道是正确的方向。但 v2.0 和 v2.1 的并存、调度员身份的摇摆、以及 happy-path-only 的设计使它**还不可实现**。5 个 red 问题全部是阻断性的，需要在进入编码前先解决。建议先产出一份 **v2.2 一致修订版**再动手。

## Defender (GLM 5.2)

我已检索了工作区，被审的"南大向导 v2 架构设计"文档存在于会话上下文中（非独立文件）。攻击者的证据引用了文档原文，结合任务提供的设计摘要和我对 Proma 平台 API 的独立认知，我可以对每个 finding 做出判断。

---

# AC 防御者审查报告：南大向导 v2 架构设计

## 裁决总览

| # | 攻击者 Severity | 我的 Verdict | 我的 Severity 判断 | 理由概要 |
|---|----------------|-------------|-------------------|---------|
| F1 | 🔴 red | **accept** | 🟡 yellow | 矛盾存在，但"修正"标记隐含了优先级 |
| F2 | 🔴 red | **accept** | 🔴 red | 文字级直接冲突，成立 |
| F3 | 🟡 yellow | **clarify** | 🟡 yellow | 描述的是不同层面，非逻辑矛盾；但旧文本未清理 |
| F4 | 🔴 red | **accept** | 🔴 red | 用户确认机制在类型契约中缺失，成立 |
| F5 | 🟡 yellow | **accept** | 🟡 yellow | coding 阶段未定义或未显式排除，成立 |
| F6 | 🔴 red | **accept** | 🔴 red | 文本标记机制在 Proma API 下很可能失效，成立 |
| F7 | 🟡 yellow | **accept** | 🟡 yellow | 阶段-工具映射缺失，但 API 签名要求超出架构文档范围 |
| F8 | 🟡 yellow | **accept** | 🟡 yellow | 文件结构未定义，成立 |
| F9 | 🟡 yellow | **accept** | 🟡 yellow | 路由选择逻辑未在证据中出现，成立 |
| F10 | 🟡 yellow | **refute** | — | 与 F4 重复；两处描述是顺序门禁而非矛盾 |
| F11 | 🔴 red | **accept** | 🔴 red | L2 失败恢复为零，成立 |
| F12 | 🟡 yellow | **accept** | 🟡 yellow | 取消/回退/重做未覆盖，成立 |
| F13 | 🟡 yellow | **accept** | 🟡 yellow | 上下文膨胀风险真实，成立 |

**统计**：accept 10 ｜ clarify 1 ｜ refute 1 ｜ 其中 agree-red 4 ｜ agree-yellow 7 ｜ downgrade 1

---

## 逐条裁决

---

### F1 | v2.0 三层架构图与 v2.1 修正自相矛盾

**Verdict: accept（severity 降为 yellow）**

**Reasoning**：

攻击者的事实观察成立——v2.0 三层架构图和 v2.1 修正后的两层图确实同时存在于文档中，且原图未被显式标记为"已废弃"。这是真实的文档自洽性缺陷。

**但对 red severity 有异议**，理由如下：

1. **"修正"一词本身隐含了优先级**。文档中"审计修正 #1"明确使用"修正"（correction）作为标签，在中文技术文档的惯例中，"修正"意味着对前文的覆盖和更正。一个正常阅读顺序的读者会理解：后出现的修正部分优先于前文。

2. 攻击者引用的原文"`delegate_agent` 硬编码 `delegationDepth > 0` 即拦截"是一个**平台技术约束**，而非设计选择。v2.1 修正是因为发现了平台限制才做出的必要调整，不是设计摇摆。

3. 攻击者的次级论点——"L1 调度员同时等待、审计、确认、推进，职责边界模糊"——是一个独立的设计关切，与"两图共存"不是同一个问题。这个问题更应该在 F3 和 F4 中讨论。

**Severity 应为 yellow**：文档卫生问题（应标记原图为 deprecated），而非"文档内自毁"。实现者如果按顺序阅读、注意到"修正"标签，不会真正混淆。

---

### F2 | "保留 tree-worker" 与修正 #4 直接冲突

**Verdict: accept（维持 red）**

**Reasoning**：

这是文档中最清晰的文字级矛盾。"可以保留"清单第 5 项明确说 tree-worker skill 留给"L2 角色子会话的契约解析指南"，而修正 #4 明确说"L2 不加载 tree-worker skill"。两份指令同时有效，优先级未定义。

没有任何辩护余地：
- "保留"和"不加载"是互斥操作
- 这两条出现在同一文档中，且无仲裁规则
- 实现者无论选哪个都可能选错

攻击者的 Fix（从保留清单删除第 5 项或改为"不引用"）是正确的最小修改。

---

### F3 | 调度员身份定义摇摆

**Verdict: clarify**

**Reasoning**：

攻击者认为"不是 Agent，是代码"与"运行 inline AC 审计"构成逻辑矛盾。我的独立判断是：**这两句话描述的是不同层面，并非逻辑矛盾**。

**澄清 1：路由决策 ≠ 任务执行**

设计文档的最终表述（见设计摘要）是"**L1 调度员（受状态机约束的 Agent）**"。这个定义同时包含了两个层面：

- **路由决策层面是代码**：阶段转换路径是硬编码的（`requirements → prototype → architecture → planning`），L1 不"决定"下一个阶段是什么——这是固定的。从这个角度看，"路由是硬编码的"完全正确。
- **任务执行层面是 Agent**：L1 需要调用 `delegate_agent` 发起 AC 审计、用 `AskUserQuestion` 请求用户确认、用 `read` 验证产出文件。这些是 Agent 的工具调用行为。

**澄清 2：发起 AC 审计不需要 L1"理解"PRD**

攻击者说"发起 AC 攻击是认知密集型任务，不可能由硬编码状态机完成"。但实际上，L1 的 AC 调用可以这样实现：

```
// 硬编码的 AC 调用模板
delegate_agent({
  task: `你是 AC 攻击者。审查以下产出：\n${fileContents}\n PRD 摘要：${prdSummary}`,
  channel: 'deepseek',
  inline: true,
  role: 'review'
})
```

L1 本身不需要理解 PRD 内容——它只是把文件内容和 PRD 摘要传给攻击者子 Agent。AC 的认知工作由子 Agent 完成，L1 只做固定的路由和转发。

**但文档确实存在文本残留问题**："不是 Agent，是代码"这句话如果出现在最终版文档中（而非早期草稿），会误导读者。应该修正为"路由决策由硬编码状态机约束，L1 本身是 Agent"。

**结论**：这不是逻辑矛盾，而是措辞不精确。severity 维持 yellow——文档措辞需要清理，但设计本身是自洽的。

---

### F4 | 用户确认机制完全缺失

**Verdict: accept（维持 red）**

**Reasoning**：

这是整份报告中最重要的 finding。我完全同意 red severity。

**文档原文确实存在矛盾设计**：
- `PhaseNode` 的 `completion` 类型定义为 `{ type: 'file_exists', path: '...' }`——**仅检查文件存在**
- 文字描述说"用户确认后推进"——**需要人工批准**

如果按 `PhaseNode` 类型实现，L2 子会话写了一个空文件后路由就会自动推进到下一阶段，完全绕过用户。这与设计摘要中"用户确认"作为 L1 核心职责之一直接冲突。

**对攻击者的 Fix 的评价**：
- ✅ 增加 `requiresUserConfirmation: boolean` 字段——正确
- ✅ 定义 `AskUserQuestion` 调用机制——正确（Proma 标准工具）
- ✅ 用户不确认时路由卡住——正确

**补充**：即使增加了确认字段，还需要定义用户选择"需要修改"后的行为——是重新委派同一个 L2 角色，还是等用户手动修改后继续？这个回退路径也需要定义。

---

### F5 | coding 阶段在路由定义中缺失

**Verdict: accept（维持 yellow）**

**Reasoning**：

攻击者的事实观察准确：`ROUTE` 数组中 `planning → coding` 被注释为 `// ...`，`coding` 的 `PhaseNode` 定义缺失。

**但这是一个已知的设计边界而非错误**。从上下文推断：
- 南大向导 v2 的核心目标是简化 tree-engine，固定路由本身已经是一个重大简化
- coding 阶段（实际代码生成）是最复杂的阶段，可能需要更灵活的委派策略（多个 coding 子会话并行？迭代编译？）
- 设计可能有意将 coding 留到 v3

**问题在于**：文档没有**显式声明**这一排除。攻击者的 Fix 是正确的——要么补全定义，要么显式写明"v2 scope 不含 coding，planning 为终点"。

---

### F6 | `PHASE_COMPLETE:X` 文本标记检测不可靠

**Verdict: accept（维持 red）**

**Reasoning**：

这是技术性最强的 finding，我基于对 Proma `delegate_agent` API 的独立认知确认其成立。

**攻击者的核心论点 #2 是决定性的**：

Proma 的 `delegate_agent` 返回的是**结构化结果摘要**（通过 `get_delegation_results` 或 `wait_for_delegations` 获取），而非 L2 子会话的原始对话文本。`PHASE_COMPLETE:prototype` 这个文本标记是 L2 子会话在其输出中写的——但它**不保证出现在返回给 L1 的结构化摘要中**。

具体来说：
- `delegate_agent` 的 `expectedOutput` 参数指定了返回格式
- 如果 `expectedOutput` 没有明确要求 L2 返回这个标记，标记可能根本不会出现在 L1 能看到的数据中
- 即使 `expectedOutput` 要求了，L2 子会话也可能不遵守（它是一个 Agent，不是确定性函数）

**攻击者的 Fix 是正确的**：放弃文本标记，改用结构化 `expectedOutput`：
```json
{ "phase": "prototype", "status": "done", "files": ["02_UX_DESIGN/prototype.html"] }
```
然后 L1 验证 `files` 数组中每个文件存在且非空。

**但补充一点**：文件存在且非空仍然不能保证内容质量——这正是 AC 审计的存在意义。所以完整的流程应该是：结构化返回 → 文件验证 → AC 审计 → 用户确认。设计文档隐含了这个流程，但 PHASE_COMPLETE 标记是实现细节上的致命缺陷。

---

### F7 | `canUseTool` phase-gate 无接口说明

**Verdict: accept（severity 维持 yellow，但攻击者的部分要求超出范围）**

**Reasoning**：

**同意的部分**：
- 阶段-工具映射确实缺失。设计声称"requirements 阶段仅允许委派相关工具"，但从未列出每个阶段的具体工具白名单。
- 这是可造性问题：没有工具白名单，`canUseTool` 硬门禁就只是概念而非可实现的设计。

**不同意的部分**：
攻击者要求"补充 `canUseTool` 的 API 签名或引用文档"。但设计文档明确说这是"**Proma 已有的** `canUseTool` 硬门禁"——它是一个平台原语。一份**架构设计文档**引用平台已有能力而不重新定义其 API 签名是合理的，正如你不需要在应用架构文档中重新定义 `fetch()` 的签名。

**真正的缺口是**：每个阶段的工具白名单定义。这是项目级配置，不是平台 API 文档。攻击者的 Fix（补充 `canUseTool(phaseId) → ToolAllowlist` 的接口定义和最小示例）是正确的。

---

### F8 | `_nanju-projects.json` 结构与并发未定义

**Verdict: accept（维持 yellow）**

**Reasoning**：

攻击者的三个子问题全部成立：
1. **Schema 未定义**——文件只提到了名字和 `currentStage` 字段，没有完整类型定义
2. **多项目并发**——是全局单例还是每项目一个？未定义
3. **状态恢复**——调度员崩溃后如何恢复？未定义

攻击者提出的 `NanjuProjectState` 接口是一个合理的 Fix 起点。

**补充**：`currentStage` 字段名暗示它是单个项目级别的（而非全局），但文档没有明确这一点。如果每个项目目录下存一个 `_nanju-project.json`（单数），则多项目并发天然无竞争——但文档说的是 `_nanju-projects.json`（复数），暗示可能是全局文件，这就引入了竞争条件。

---

### F9 | 快消型/迭代型路由选择逻辑空白

**Verdict: accept（维持 yellow）**

**Reasoning**：

从可用证据看，`QUICK_ROUTE` 和 `ITERATIVE_ROUTE` 两个数组被定义了，但**如何在这两者之间选择**确实未在证据中出现。可能的选择逻辑包括：
- 用户在启动时选择？
- 根据 PRD 复杂度自动判断？
- 调度员自己决定？

没有定义意味着实现者需要自行猜测。攻击者的 finding 成立。

**但需要指出**：攻击者引用的证据在 F9 处被截断（`// ... arch` 断行），我无法确认文档的后续部分是否有选择逻辑的描述。基于可用证据，accept。

---

### F10 | 路由推进是自动还是手动

**Verdict: refute**

**Reasoning**：

攻击者声称"文档两处描述矛盾"——一处暗示自动推进（`PhaseNode.completion.type = 'file_exists'`），另一处要求手动确认（"用户确认后推进"）。

**我的反驳：这两处描述的是顺序门禁（sequential gates），不是矛盾。**

设计文档的完整推进逻辑是：
```
L2 完成 → 文件存在检查（automated gate）→ AC 审计（automated gate）→ 用户确认（human gate）→ 推进
```

- `file_exists` 是**自动前置检查**：文件不存在就不可能进入确认环节
- "用户确认后推进"是**最终人工门禁**：即使文件存在，也需要用户批准

两者是 AND 关系而非 OR 关系。文件存在是必要条件，用户确认是充分条件。

**真正的问题**（PhaseNode 类型未编码用户确认字段）已经在 **F4** 中被准确捕获。F10 没有提供超越 F4 的独立信息——它只是从另一个角度重新描述了同一个类型定义缺口。

**建议**：将 F10 合并入 F4，或标记为 F4 的衍生项。

---

### F11 | L2 子会话失败、超时、产出缺失——零恢复机制

**Verdict: accept（维持 red）**

**Reasoning**：

这是设计中**最严重的系统性缺口**。攻击者的 severity 判断正确。

`delegate_agent` 依赖外部 LLM API 和跨渠道通信，失败模式包括：
- **API 超时**：deepseek/glm-zhipu 请求超时
- **产出文件缺失**：L2 子会话声称完成但实际没有写文件
- **产出文件错误**：L2 写了文件但内容完全不对（比如把 PRD 内容写成了代码）
- **子会话异常终止**：delegate_agent 返回 error 状态
- **工具权限不足**：L2 缺少 write/bash 权限无法产出

设计文档**完全没有**定义以上任何一种失败模式的处理策略：
- 没有重试逻辑
- 没有降级策略
- 没有错误报告机制（用户如何知道 L2 失败了？）
- 没有 fallback 路由（失败后是回到当前阶段还是终止？）

在一个完全依赖子会话委派的架构中，零失败恢复等于零生产可靠性。

---

### F12 | 用户中途取消、回退、重做——零覆盖

**Verdict: accept（维持 yellow）**

**Reasoning**：

设计只覆盖了 happy path（正常推进）。以下场景完全没有定义：

- **用户在 PRD 确认环节说"这个不对，重做需求分析"**——当前阶段是否回退到 `requirements`？已产出的 `prd.md` 是否删除或覆盖？
- **用户在架构设计阶段说"我改主意了，换个方案"**——是重新委派 `architecture` 角色还是修改现有文件？
- **用户中途说"先停一下，我明天继续"**——调度员如何保存当前状态？恢复时如何重建上下文？

这些问题对于一个"用户驱动"的流水线是必须回答的。

**对 yellow severity 的评价**：同意 yellow 而非 red。这些场景虽然重要，但不阻断 v2 的核心价值验证。可以在后续迭代中补充。

---

### F13 | 调度员上下文膨胀风险

**Verdict: accept（维持 yellow）**

**Reasoning**：

风险是真实的。L1 调度员在一个完整流程中需要累积：
- 每个 L2 委派的 task 描述（几百字 × N 阶段）
- `delegate_agent` 返回的结构化结果摘要
- AC 审计的攻击者报告 + 防御者报告（各数千字 × N 阶段）
- `read` 读取的产出文件内容（PRD 可能数千字，架构设计更长）
- `AskUserQuestion` 的用户回复
- 自身的 systemPrompt 和路由配置

对于完整迭代型路由（requirements → prototype → architecture → planning → coding），这很容易累积到数万 token。

**但 yellow 是合适的 severity**，因为：
1. Proma 有 `CompactContext` 工具可以在上下文膨胀时压缩
2. 可以用 `_nanju-projects.json` 保存已完成阶段的关键信息，在压缩后恢复
3. 这是一个**可管理的运营问题**，不是设计缺陷——只需要在设计中增加一句"每完成一个阶段后，执行 CompactContext 并从 `_nanju-projects.json` 恢复路由状态"

攻击者的 finding 准确地指出了缺失，但解决方案是增量补充而非重构。

---

## 防御者总结

### 接受的核心问题（需要在实现前解决）

| 优先级 | Finding | 核心修复 |
|--------|---------|---------|
| **P0** | F4 | PhaseNode 增加 `requiresUserConfirmation`，定义 AskUserQuestion 调用 |
| **P0** | F6 | 放弃 PHASE_COMPLETE 文本标记，改用结构化 expectedOutput |
| **P0** | F11 | 定义 L2 失败的最小恢复策略（至少：报告用户 + 提供重试/终止选项）|
| **P1** | F2 | 从保留清单删除 tree-worker 或标记为不引用 |
| **P1** | F7 | 补充每阶段工具白名单 |

### 接受但非阻断的问题（迭代中补充）

| Finding | 建议 |
|---------|------|
| F1 | 标记 v2.0 图为已废弃（文档卫生）|
| F3 | 清理"不是 Agent"的残留措辞 |
| F5 | 显式声明 coding 阶段的 scope |
| F8 | 定义 `_nanju-projects.json` schema |
| F9 | 定义路由选择逻辑 |
| F12 | 补充取消/回退/重做流程 |
| F13 | 增加 CompactContext 策略 |

### 反驳的 finding

| Finding | 理由 |
|---------|------|
| F10 | 与 F4 重复；两处描述是顺序门禁（AND 关系），不是矛盾。PhaseNode 类型缺口已在 F4 捕获 |

### 设计的固有优势（攻击者未触及）

作为防御者，我需要指出设计中攻击者未质疑但确实正确的部分：
1. **放弃 tree-engine 转向固定路由**——大幅降低复杂度，方向正确
2. **L1 inline AC 审计**——解决了三层架构不可行的问题，利用了 `delegate_agent` 的 `inline` 参数
3. **L2 跨渠道跨模型委派**——利用 deepseek 攻击 + glm-zhipu 防御的多模型交叉，是合理的质量保障
4. **3 件套简化契约**（task/output_path/constraints）——比 tree-worker 的 5 件套更适合固定路由场景

## Arbiter Verdict


# AC 审计仲裁结论

## 审计配置
- Attacker: DeepSeek V4 Pro (deepseek)
- Defender: GLM 5.2 (glm-zhipu)
- 仲裁者: 我（本会话）

## 最终裁决（13 findings）

| # | 攻击者 | 防御者 | 仲裁裁决 | 最终严重度 |
|---|--------|--------|----------|----------|
| F1 | 🔴 red | 🟡 yellow(降级) | **agree-defender** | 🟡 yellow（文档卫生，非阻断）|
| F2 | 🔴 red | 🔴 red | **consensus** | 🔴 red（文字级冲突，必须修）|
| F4 | 🔴 red | 🔴 red | **consensus** | 🔴 red（用户确认机制缺失）|
| F6 | 🔴 red | 🔴 red | **consensus** | 🔴 red（PHASE_COMPLETE 不可靠）|
| F11 | 🔴 red | 🔴 red | **consensus** | 🔴 red（零异常恢复）|
| F3 | 🟡 yellow | clarify | **agree-defender** | 🟡 yellow（措辞清理）|
| F5 | 🟡 yellow | 🟡 yellow | **consensus** | 🟡 yellow（coding 缺失或显式排除）|
| F7 | 🟡 yellow | 🟡 yellow | **consensus** | 🟡 yellow（工具白名单缺失）|
| F8 | 🟡 yellow | 🟡 yellow | **consensus** | 🟡 yellow（schema 未定义）|
| F9 | 🟡 yellow | 🟡 yellow | **consensus** | 🟡 yellow（路由选择空白）|
| F10 | 🟡 yellow | refute | **agree-defender** | ❌ dismissed（与 F4 重复）|
| F12 | 🟡 yellow | 🟡 yellow | **consensus** | 🟡 yellow（异常场景零覆盖）|
| F13 | 🟡 yellow | 🟡 yellow | **consensus** | 🟡 yellow（上下文膨胀风险）|

## 统计
- 4 个 red（F2/F4/F6/F11）——实现前必须解决
- 8 个 yellow——迭代中补充
- 1 个 dismissed（F10）

## 4 个 Red 的修正方案（实现前必须完成）

### F2: tree-worker 冲突 → 从保留清单删除
### F4: 用户确认缺失 → PhaseNode 加 requiresUserConfirmation + AskUserQuestion 调用
### F6: PHASE_COMPLETE 不可靠 → 改用结构化 expectedOutput + fs.existsSync 验证
### F11: 零异常恢复 → 定义失败处理：报告用户 + 重试/终止选项 + retryCount

## 防御者确认的设计优势（不需要改）
1. ✅ 弃用 tree-engine 转向固定路由
2. ✅ L1 inline AC 审计（两层架构）
3. ✅ L2 跨渠道跨模型委派
4. ✅ 3 件套简化契约
5. ✅ canUseTool 硬门禁作为状态机护栏
