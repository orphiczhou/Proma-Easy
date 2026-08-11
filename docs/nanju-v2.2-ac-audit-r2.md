# 南大向导 v2.2 AC Round 2 审计

## Attacker (DeepSeek V4 Pro)

# AC Round 2 攻击者审查报告

## 一、Round 1 Red 修复验证

| 编号 | 问题 | v2.1 状态 | v2.2 修复 | 判定 |
|------|------|-----------|-----------|------|
| **F2** | tree-worker 冲突 | 3602 行 tree-engine + 68KB SKILL 加载到 L2 | 完全移除 tree-engine/tree-worker/tree-commander，L2 改用纯 systemPrompt + 3 件套契约 | ✅ **真正修复** |
| **F4** | 用户确认缺失 | 阶段完成无用户确认环节 | 所有活跃阶段 `requiresUserConfirmation: true`，推进流程第 5 步强制 `AskUserQuestion`（3 选项：通过/修改/终止） | ✅ **真正修复** |
| **F6** | PHASE_COMPLETE 不可靠 | 依赖事件标记，无文件验证 | 替换为 `fs.existsSync` + `fs.statSync.size >= 100` 文件验证 + retryCount 循环 | ✅ **真正修复** |
| **F11** | 零异常恢复 | 失败即静默终止 | 新增 `PhaseResult` 接口 + `handlePhaseResult` + `retryLimit` + 超限后 `notify_user` | ✅ **真正修复** |

**结论：4 个 Round 1 red 全部真正修复，无"换说法"式规避。**

---

## 二、v2.2 新增 Red 发现

### 🔴 R1 — Section 9 AC 审计文件写入与 canUseTool Write 禁令直接矛盾

**维度**: C1 自洽性 / C2 保真度 / C3 可造性

**证据**:

Section 9 要求：
> 每完成一个阶段后：将本阶段的 AC 审计结果写入文件（`{projectDir}/_ac-audit-{phaseId}.md`）

同时 Section 5 `PHASE_TOOL_WHITELIST` 中，**所有活跃阶段均不包含 `Write`**：
```typescript
const PHASE_TOOL_WHITELIST: Record<PhaseId, Set<string>> = {
  requirements:  new Set(['delegate_agent', ..., 'Read', 'LS', 'AskUserQuestion', ...]),
  prototype:     new Set([...同上...]),
  architecture:  new Set([...同上...]),
  planning:      new Set([...同上...]),
  // ⚠️ Write 不在任何一个活跃阶段的 whitelist 中
}
```

Section 7 调度员 systemPrompt 更明确：
> 你绝对不能做的：自己写代码或文档（**系统会拦截**）

**分析**：L1 调度员被硬门禁禁止 Write，但 Section 9 又要求它"写入" AC 审计结果。文档未说明由谁写（L1？Harness？L2？），三个可能性都有问题：
- L1 写 → 被 canUseTool 拦截，运行时失败
- Harness 写 → 文档未定义此机制
- 新 L2 写 → 文档未定义此委派流程

**Fix**: 明确写入主体。若由 Harness 写入，在 Section 9 中补充实现路径；若由 L1 写入，需在相关阶段 whitelist 中增加 `Write`（需评估安全影响）；或将审计结果写入委托给 `delegate_agent(inline:true)` 。

---

### 🔴 R2 — iterative 路由 prototype.next 泄露 quick 路由定义

**维度**: C1 自洽性 / C3 可造性

**证据**:

```typescript
const ROUTES: Record<'quick' | 'iterative', PhaseNode[]> = {
  quick: [
    { id: 'requirements', ..., next: 'prototype' },
    { id: 'prototype', ..., next: 'delivered' },      // ← prototype → delivered
    { id: 'delivered', ..., next: null },
  ],
  iterative: [
    // requirements 和 prototype 同 quick               // ← 声称复用 quick 定义
    // prototype.next = 'architecture'（而非 'delivered'） // ← 但需要不同的 next
    { id: 'architecture', ..., next: 'planning' },
    { id: 'planning', ..., next: 'delivered' },
    { id: 'delivered', ..., next: null },
  ],
}
```

**分析**：quick 路由中 `prototype.next = 'delivered'`；iterative 路由注释称 prototype "同 quick" 但又说 `next = 'architecture'`。这两个陈述互斥。iterative 路由数组本身只含 `architecture / planning / delivered`，**没有重新定义 prototype 节点**。实现时若直接复用 quick 的 prototype 对象，iterative 路由将错误地从 prototype 跳到 delivered（跳过 architecture + planning），等价于 quick 路由。

**Fix**: 在 iterative 数组中显式定义 prototype 节点（从 quick clone 并修改 `next: 'architecture'`）；或改为运行时根据 mode 动态覆盖 `next` 字段。

---

## 三、v2.2 新增 Yellow 发现

### 🟡 Y1 — `Finding` 和 `PhaseAction` 类型未定义

**维度**: C3 可造性

**证据**:
```typescript
interface PhaseResult {
  acFindings?: Finding[]     // ← Finding 未定义
}

function handlePhaseResult(result: PhaseResult, phase: PhaseNode): PhaseAction {
  // ← PhaseAction 未定义
  if (result.acFindings?.some(f => f.severity === 'red')) {
    // ← severity 字段无类型约束
  }
}
```

`Finding` 接口（含 `severity: 'red' | 'yellow' | 'green'`、`evidence`、`fix` 等字段）应在文档中定义。`PhaseAction` 的判别联合类型（`{ action: 'retry' | 'advance' | 'ask_user' | 'notify_user', reason?: string }`）同样缺失。

**Fix**: 补充 `Finding` 和 `PhaseAction` 类型定义。

---

### 🟡 Y2 — `handlePhaseResult` 未处理 `needs_modification` 状态

**维度**: C1 自洽性

**证据**:
```typescript
interface PhaseResult {
  status: 'success' | 'failed' | 'timeout' | 'needs_modification'
  //                                            ^^^^^^^^^^^^^^^^ 定义了但...
}

function handlePhaseResult(result: PhaseResult, phase: PhaseNode): PhaseAction {
  if ((result.status === 'failed' || result.status === 'timeout') ...) { ... }
  // ⚠️ needs_modification 不匹配任何条件，直接落入 ask_user/advance
}
```

当 L2 返回 `needs_modification` 时，`handlePhaseResult` 将其等同于 `success`（走 `ask_user` 或 `advance`），语义错误。该状态本应表示"产出存在但需要修改"→ 应触发 retry 而非推进。

**Fix**: 将 `needs_modification` 加入 retry 判断分支，或新增专门处理逻辑。

---

### 🟡 Y3 — L2 架构师无法访问原型文件路径

**维度**: C2 保真度

**证据**:

architecture 节点的 task 为"根据 PRD 和原型，产出架构文档"。但 L2 三件套契约模板只传递了 PRD 摘要：
```yaml
task: |
  你是{角色名}。{任务描述}
  PRD 摘要：{prdSummary 或 "无（这是需求阶段）"}
```
原型文件路径（`02_UX_DESIGN/prototype.html`）没有通过契约传给 L2 架构师。L2 不知道原型在哪、是否可读。

**Fix**: 在 L2 契约中增加 `前序产出` 字段，按需注入 prototype/PRD 路径。

---

### 🟡 Y4 — `_nanju-projects.json` 接口定义与描述不一致

**维度**: C1 自洽性 / C3 可造性

**证据**:

文档描述："`_nanju-projects.json`（全局）…`_nanju-projects.json` 是数组，追加不冲突"

但 TypeScript 接口定义为单个对象：
```typescript
interface NanjuProjectState {
  projectId: string
  name: string
  // ... 无外层数组包装
}
```

**Fix**: 补充 `type NanjuProjectsFile = NanjuProjectState[]` 包装类型。

---

### 🟡 Y5 — 非 AC 阶段无内容质量校验

**维度**: C2 保真度

**证据**:

文件验证仅检查 `existsSync` + `size >= 100` 字节。内容质量完全依赖 L2 自控。`requiresAC` 仅在 `architecture` 为 `true`。requirements、prototype、planning 阶段产出可能为空壳文件（101 字节的占位内容）通过验证。

**Fix**: 至少加入最低限度的内容检查（如 Markdown 阶段检查是否含 `# ` 标题，HTML 阶段检查是否含 `<html`），或对更多阶段启用 inline AC。

---

### 🟡 Y6 — `delivered` 哨兵节点使用空字符串填充必填字段

**维度**: C1 自洽性 / C4 可懂性

**证据**:
```typescript
{
  id: 'delivered',
  role: '', title: '', channel: '', model: '',  // ← 必填字段空字符串
  task: '', outputPath: '', constraints: [],
  requiresUserConfirmation: false,
  requiresAC: false,
  retryLimit: 0,
  next: null,
}
```

`PhaseNode` 接口所有字段均为必填（无 `?`），`delivered` 填入空字符串在 TypeScript 层面合法但语义上表示"不适用"。类型系统无法区分"真正的空值"和"哨兵节点"。

**Fix**: 将哨兵相关字段改为可选（`role?: string`），或将 `delivered` 从 `ROUTES` 中移除，在路由查询中单独处理终态。

---

### 🟡 Y7 — L2 重试时无失败上下文反馈

**维度**: C3 可造性

**证据**:

Section 4.1 文件验证失败时仅 `retryCount++` 然后重新委派 L2。L2 收到的 task 与首次完全相同，不知道上次为什么失败（文件未生成？太小？）。L2 可能重复相同错误。

**Fix**: 重试时在 task 中追加失败原因（如 `上次产出文件过小（<100 字节），请确保内容完整`）。

---

### 🟡 Y8 — 状态机/Harness 边界模糊

**维度**: C4 可懂性

**证据**:

文档混用两种语言风格：
- Harness 层：`fs.existsSync`、`fs.statSync`、`const ROUTES`、`handlePhaseResult`（像 Node.js 运行时代码）
- Agent 层：`delegate_agent`、`AskUserQuestion`、`Read`（Agent 工具调用）

未明确说明哪些逻辑在 Harness（系统强制执行）中运行，哪些由 Agent systemPrompt（软引导）驱动。例如：`handlePhaseResult` 是 TypeScript 函数还是 Agent 行为指令？Section 4.1 的推进流程是代码还是 prompt？

**Fix**: 增加一节明确 Harness ↔ Agent 职责边界，标注每个组件运行在哪个层级。

---

### 🟡 Y9 — `EnterPlanMode` 在 whitelist 中存在潜在旁路

**维度**: C3 可造性

**证据**:

所有活跃阶段 whitelist 均包含 `EnterPlanMode` 和 `ExitPlanMode`。进入计划模式后，Agent 可能生成包含 Bash/Write 指令的计划并在用户批准后执行，间接绕过 canUseTool 硬门禁。

**Fix**: 从 whitelist 中移除 `EnterPlanMode` / `ExitPlanMode`；若确实需要计划能力，限定计划模式内可用的工具子集。

---

## 四、总结

| 类别 | 数量 | 关键项 |
|------|------|--------|
| Round 1 Red 修复确认 | 4/4 ✅ | F2/F4/F6/F11 全部真正修复 |
| v2.2 新增 Red | **2** | Section 9 Write 矛盾、iterative prototype.next 泄露 |
| v2.2 新增 Yellow | **9** | 未定义类型、needs_modification 漏处理、契约不完整等 |

**整体评估**: v2.2 对 Round 1 问题的修复扎实，但引入了两个会直接阻塞实现的新 red 问题，以及若干接口完整性和边界清晰度方面的 yellow 问题。建议在修复 R1（AC 文件写入路径）和 R2（iterative prototype 定义）后再进入实现阶段。

## Defender (GLM 5.2)

现在我已经充分了解了项目结构、实际数据格式和 Proma 平台机制。以下是我作为防御者对每个 finding 的判断。

---

# AC Round 2 — Defender 审查报告

## 审查立场声明

作为 Defender，我的职责是基于对 Proma 平台和南大向导实际实现的独立认知，对每个 finding 做 accept/refute/clarify 判断。我不盲目防御——如果攻击者有理，我接受。

**注意**：攻击者报告声称 9 个 yellow，但实际可见 Y1–Y6（6 个），Y6 的 Fix 被截断。以下基于可见的 2 red + 6 yellow 共 8 个 finding 进行评审。

---

## 二、Red Findings 逐条裁定

### 🔴 R1 — AC 审计文件写入与 Write 禁令矛盾

**裁定：✅ ACCEPT — Red 成立**

攻击者的分析准确无误。我从三个角度独立验证：

**1. Proma 平台机制验证**：Proma Agent SDK 的 `canUseTool` 钩子（如果按设计实现）会在工具调用前拦截。当前会话中 `write` 工具确实存在且可用——但如果 Harness 代码中 `PHASE_TOOL_WHITELIST` 不含 `Write`，则 L1 调度员调用 `write()` 时会被硬拦截，返回拒绝。这不是假设，是平台行为。

**2. 文档三重矛盾验证**：
- Section 5 whitelist：所有活跃阶段无 `Write` ✅ 已确认
- Section 7 systemPrompt："你绝对不能做的：自己写代码或文档（**系统会拦截**）" ✅ 明确禁止
- Section 9："将本阶段的 AC 审计结果写入文件" ✅ 要求写入

三者形成不可调和的逻辑闭环矛盾。

**3. 三个出路均不通**：
- L1 写 → canUseTool 拦截，运行时 TypeError
- Harness 写 → 文档未定义此机制，Harness 职责边界不清
- L2 写 → Section 9 语境是"完成阶段后"的 AC 审计，不是 L2 的产出委派；且 AC 审计的执行主体本身就未明确

**为什么是 Red 而非 Yellow**：这不是"可以推断出正确做法"的歧义，而是"任何实现路径都会在运行时失败"的硬矛盾。开发者按文档实现后，第一个 `requiresAC: true` 的阶段（architecture）完成时就会触发错误。

**建议 Fix 方向（同意攻击者）**：最干净的方案是**由 Harness 写入**。在 Section 9 补充：`// Harness 代码：fs.writeFileSync(...)，不由 L1 Agent 调用 Write 工具`。这样 L1 的 canUseTool 不需要添加 Write，安全边界不被打破。

---

### 🔴 R2 — iterative 路由 prototype.next 泄露 quick 定义

**裁定：✅ ACCEPT — Red 成立**

攻击者的分析完全正确。我从 TypeScript 语义层面验证：

**实际代码行为**：`ROUTES.iterative` 作为一个 `PhaseNode[]` 类型的值，其数组中**只有 3 个对象字面量**：`architecture`、`planning`、`delivered`。注释 `// requirements 和 prototype 同 quick` 和 `// prototype.next = 'architecture'` **不会产生运行时对象**。

**运行时后果**：
- `ROUTES.iterative` 查找 `requirements` 节点 → `undefined`（数组中没有这个 id）
- 状态机起始节点未定义 → 运行时 crash 或逻辑错误
- 即使手动修复起始点，从 `prototype` 到 `architecture` 的跳转不存在 → 无限循环或错误终止

**为什么是 Red 而非 Yellow**：这不是"建议补充"的文档缺失，而是"按此实现必然产生错误路由"的设计 bug。quick 和 iterative 两条路径都会受到波及——iterative 路由完全无法工作。

**建议 Fix 方向（同意攻击者）**：

```typescript
iterative: [
  { id: 'requirements', ..., next: 'prototype' },
  { id: 'prototype', ..., next: 'architecture' },  // ← 显式定义，next 不同
  { id: 'architecture', ..., next: 'planning' },
  { id: 'planning', ..., next: 'delivered' },
  { id: 'delivered', ..., next: null },
],
```

或使用工厂函数避免重复：
```typescript
function makeRoute(mode: 'quick' | 'iterative'): PhaseNode[] { ... }
```

---

## 三、Yellow Findings 逐条裁定

### 🟡 Y1 — Finding 和 PhaseAction 类型未定义

**裁定：✅ ACCEPT — Yellow 成立**

`Finding`（含 `severity: 'red' | 'yellow' | 'green'`、`evidence`、`fix`）和 `PhaseAction`（判别联合 `{ action: 'retry' | 'advance' | 'ask_user' | 'notify_user', reason?: string }`）在代码中被引用但未定义。

**补充证据**：攻击者还遗漏了一点——`handlePhaseResult` 函数体中访问了 `f.severity`，但 `Finding` 未定义意味着 `severity` 字段类型不受约束。实现者可能传入任意字符串（如 `'critical'`），与后续 `=== 'red'` 比较不匹配，导致 red finding 被静默忽略。

**严重程度**：Yellow 合适。这是文档完整性问题，不影响架构正确性，但会影响实现一致性。

---

### 🟡 Y2 — handlePhaseResult 未处理 needs_modification

**裁定：✅ ACCEPT — Yellow 成立，附 CLARIFY**

攻击者核心论点正确：`needs_modification` 状态落入 `ask_user`/`advance` 分支，与 `success` 等价处理。

**CLARIFY（缓解因素，但不改变裁定）**：由于 v2.2 所有活跃阶段均设 `requiresUserConfirmation: true`，`needs_modification` 会触发 `ask_user` 而非直接 `advance`。用户在确认环节有机会发现产出需要修改。因此**不会导致错误推进到下一阶段**，只是缺少对 `needs_modification` 的差异化提示（用户看到的确认选项与 `success` 完全相同，不知道系统认为产出需要修改）。

**仍为 Yellow 的原因**：UX 语义不精确。`needs_modification` 意味着"L2 明确表示产出有问题"，应至少在 `ask_user` 中标注"⚠️ 阶段产出可能需要修改"提示，而非与成功混为一谈。

---

### 🟡 Y3 — L2 架构师无法访问原型文件路径

**裁定：✅ ACCEPT — Yellow 成立**

我验证了实际项目结构。以 `project-记账本` 为例，目录结构为：
```
01_PRD/prd.md
02_UX_DESIGN/prototype.html  (35KB)
03_ARCHITECTURE/
...
```

架构师 L2 契约模板只传了 `PRD 摘要`，没有传递原型文件路径。虽然路径有固定约定（`02_UX_DESIGN/prototype.html`），但：

1. L2 架构师的 systemPrompt 是全新的——它不知道项目目录约定
2. 即使猜到路径，也无法确认文件是否存在（除非 trial-and-error 调用 Read）
3. iterative 路径下前序产出更多（PRD + prototype），契约模板需要支持多个前序产出路径

**建议 Fix（同意攻击者）**：契约模板增加 `前序产出` 字段：
```yaml
task: |
  你是{角色名}。{任务描述}
  PRD 摘要：{prdSummary 或 "无（这是需求阶段）"}
  前序产出文件（请先读取）：{priorArtifacts.join(', ') 或 "无"}
```

---

### 🟡 Y4 — _nanju-projects.json 接口与描述不一致

**裁定：✅ ACCEPT — Yellow 成立**

我读取了实际的 `_nanju-projects.json` 文件，独立验证：

```python
Type: list
Length: 9
First item keys: ['projectId', 'name', 'mode', 'status', 'currentStage', ...]
```

**实际文件确实是数组**（`NanjuProjectState[]`），文档描述正确。但 TypeScript 接口只定义了单个对象 `NanjuProjectState`，缺少数组包装类型。

**补充发现（攻击者未提及）**：实际 JSON 中各项目对象的字段不完全一致——早期项目缺少 `treeId` 字段（如前 4 个项目），后期项目有 `treeId`。这说明接口定义还应该标记 `treeId?: string` 为可选字段。但这属于实现层差异，不影响 Y4 核心结论。

---

### 🟡 Y5 — 非 AC 阶段无内容质量校验

**裁定：✅ ACCEPT — Yellow 成立，附 CLARIFY**

攻击者指出 `existsSync` + `size >= 100` 过于宽松，101 字节占位文件可绕过。

**CLARIFY（设计意图理解）**：`requiresAC` 仅对 `architecture` 为 true 是**有意的设计选择**——AC（Adversarial Convergence）审计是重量级操作（需要多模型对抗），对每个阶段都启用 AC 成本过高。非 AC 阶段的质量保障策略是"文件验证（防完全缺失）+ 用户确认（防空壳）"双层。

**仍为 Yellow 的原因**：在**自动重试场景**中，用户确认前，L2 可能产出空壳文件并通过文件验证，触发不必要的重试循环或推进。至少应加入最低格式检查：

```typescript
const FORMAT_CHECKS: Record<PhaseId, (content: string) => boolean> = {
  requirements:  (c) => c.includes('# ') || c.includes('## '),     // Markdown 标题
  prototype:     (c) => c.includes('<html') || c.includes('<!DOCTYPE'),
  architecture:  (c) => c.includes('# '),                           // Markdown 标题
  planning:      (c) => c.includes('# '),
  delivered:     () => true,
}
```

---

### 🟡 Y6 — delivered 哨兵节点用空字符串填充必填字段

**裁定：✅ ACCEPT — Yellow 成立，但严重程度偏低**

攻击者指出 `delivered` 节点用空字符串填充 `role`、`title`、`channel` 等必填字段，TypeScript 无法区分"真正的空值"和"哨兵节点"。

**我的评估**：这是一个 **code smell**，不是功能 bug。`delivered` 节点的特殊语义（`next: null`、`retryLimit: 0`、`requiresAC: false`、`requiresUserConfirmation: false`）已经通过其他字段明确标识了它的哨兵性质。空字符串字段在实际运行中不会被读取（因为状态机到达 `delivered` 后终止）。

**建议 Fix（同意攻击者截断的意图）**：将 `PhaseNode` 字段改为 `role?: string` 等可选字段，或使用判别联合类型：

```typescript
type PhaseNode = ActivePhaseNode | SentinelPhaseNode
interface ActivePhaseNode { id: string; role: string; ...; next: string | null }
interface SentinelPhaseNode { id: 'delivered'; next: null; requiresAC: false; ... }
```

---

## 四、汇总矩阵

| Finding | 维度 | 裁定 | 理由摘要 |
|---------|------|------|----------|
| **R1** | C1/C2/C3 | ✅ **ACCEPT Red** | 三重逻辑矛盾，任何实现路径运行时失败 |
| **R2** | C1/C3 | ✅ **ACCEPT Red** | 注释非执行对象，iterative 数组缺节点，状态机必然崩溃 |
| Y1 | C3 | ✅ ACCEPT Yellow | 类型引用但未定义，severity 无类型约束 |
| Y2 | C1 | ✅ ACCEPT Yellow (clarify) | needs_modification 语义丢失，但 user confirmation 提供安全网 |
| Y3 | C2 | ✅ ACCEPT Yellow | 契约模板缺前序产出路径，架构师无法定位原型 |
| Y4 | C1/C3 | ✅ ACCEPT Yellow | 文件是数组但接口定义单对象；附 treeId 可选字段差异 |
| Y5 | C2 | ✅ ACCEPT Yellow (clarify) | 文件验证过宽，但设计意图可理解，建议加最低格式检查 |
| Y6 | C1/C4 | ✅ ACCEPT Yellow (偏轻) | Code smell 非功能 bug，哨兵节点字段无实际读取 |

---

## 五、Defender 总结

**Accept 率：8/8（100%）**。本轮攻击者的 findings 质量极高，每个都有具体证据支撑，无臆测性发现。

**关键判断**：

1. **两个 Red 均不可辩驳**。R1 是规范的逻辑矛盾（A 要求做 B 同时禁止做 B），R2 是 TypeScript 层面的事实错误（注释不能产生运行时对象）。两者都会在实现阶段必然暴露。

2. **Yellow 中 Y2 和 Y5 有缓解因素**（user confirmation 作为安全网），但缓解因素不改变问题存在——它只改变了"最坏后果"从"错误推进"降级为"用户可能未获充分信息"。仍需修复。

3. **攻击者报告截断**：声称 9 个 yellow 但仅可见 6 个（Y6 Fix 被截断于"将哨"）。建议补充完整后继续审查 Y7–Y9。

4. **无 Refute**：本轮没有需要反驳的 finding。攻击者基于实际代码证据和平台机制推理，结论可靠。

**对 v2.2 修复优先级的建议**：
- **P0**（必须在 v2.3 修复）：R1（审计文件写入矛盾）、R2（路由定义缺失）
- **P1**（强烈建议）：Y3（前序产出路径）、Y2（needs_modification 处理）
- **P2**（质量提升）：Y1（类型定义）、Y4（数组类型）、Y5（格式检查）、Y6（哨兵类型）

## Arbiter Verdict


# AC Round 2 仲裁结论

## 审计配置
- Attacker: DeepSeek V4 Pro — 发现 2 red + 9 yellow（可见 6 个）
- Defender: GLM 5.2 — 接受 8/8（100%），无反驳

## Round 1 修复验证
| R1 问题 | v2.2 状态 | 判定 |
|---------|----------|------|
| F2 tree-worker 冲突 | 完全移除 | ✅ 修复 |
| F4 用户确认缺失 | requiresUserConfirmation + AskUserQuestion | ✅ 修复 |
| F6 PHASE_COMPLETE 不可靠 | fs.existsSync + size 检查 + retryCount | ✅ 修复 |
| F11 零异常恢复 | PhaseResult + handlePhaseResult + retryLimit | ✅ 修复 |

## Round 2 新发现

### 🔴 Red（2 个，实现前必须修）

| # | 问题 | 修正方案 |
|---|------|----------|
| **R1** | Section 9 要求 L1 写 AC 审计文件，但 canUseTool 禁止 Write | 由 Harness 代码写入（fs.writeFileSync），不由 L1 Agent 调用 Write 工具 |
| **R2** | iterative 路由数组缺 requirements/prototype 节点定义（注释不是代码） | 在 iterative 数组中显式定义所有节点，用工厂函数避免重复 |

### 🟡 Yellow（8 个，迭代补充）

| # | 问题 | 优先级 |
|---|------|--------|
| Y1 | Finding/PhaseAction 类型未定义 | P2 |
| Y2 | needs_modification 未被 handlePhaseResult 处理 | P1 |
| Y3 | L2 契约缺前序产出路径 | P1 |
| Y4 | NanjuProjectState 缺数组包装类型 | P2 |
| Y5 | 非 AC 阶段无内容格式检查 | P2 |
| Y6 | delivered 哨兵用空字符串 | P2 |
| Y7 | L2 重试无失败上下文反馈 | P2 |
| Y8 | Harness ↔ Agent 职责边界模糊 | P1 |
| Y9 | EnterPlanMode 潜在旁路 | P1 |

## 收敛判断

Round 1 的 4 个 red 全部修复 ✅
Round 2 新发现 2 个 red（都是实现细节级别，不是架构方向问题）
Yellow 从 8→8（持平但质量更高，全是实现层面的）

**结论：架构方向已收敛（两层固定路由 + canUseTool 硬门禁 + delegate_agent 委派）。**
2 个新 red 是代码实现级别的矛盾，修正后可以进入实现阶段。
