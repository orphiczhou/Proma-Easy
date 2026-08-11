# 代码审计 Round 1

## Attacker

# 南大向导 v2.3 攻击者审计报告

我以**攻击者（Attacker）**视角，对四个文件进行六维审查。以下是所有发现：

---

## 🔴 RED（严重 — 可导致运行时错误或流程阻断）

### R1 · `nanju-router-gate.ts:109` — 动态 `require` 在 ESM 环境下崩溃

```typescript
// line 107-110
const { readFileSync } = require('node:fs')
const content = readFileSync(filePath, 'utf-8')
```

**证据**：文件顶部已用 `import { existsSync, statSync } from 'node:fs'`（ESM 风格），却在函数体内改用 `require('node:fs')`。如果项目 `tsconfig` 输出 ESM 或 `package.json` 设 `"type": "module"`，`require` 不存在 → **运行时抛出 `ReferenceError: require is not defined`**，`verifyPhaseOutput` 在文件存在且 ≥100 字节后直接崩溃。

**Fix**：将 `readFileSync` 加入顶部 import：
```typescript
import { existsSync, statSync, readFileSync } from 'node:fs'
```
并删除函数体内的 `require` 行。

---

### R2 · `nanju-router.ts:173-175` — AC 红牌检查无视 `requiresAC` 门禁

```typescript
// line 173-175
// AC 发现 red → 通知用户
if (result.acFindings?.some((f) => f.severity === 'red')) {
  return { action: 'notify_user', reason: 'AC 审计发现严重问题，请查看后决定' }
}
```

**攻击向量**：`PhaseResult.acFindings` 是可选字段。如果某个 L2 子会话（或被劫持的返回值）在 `requiresAC: false` 的阶段（如 `requirements`、`prototype`、`planning`）注入 `acFindings: [{ severity: 'red', ... }]`，即使 SUCCESS 完成也会被此检查拦截，**用户无法推进**。

**证据**：`handlePhaseResult` 不检查 `phase.requiresAC` 就消费 `acFindings`。只有 `architecture` 阶段 `requiresAC: true`，其余阶段 `false`。

**Fix**：
```typescript
if (phase.requiresAC && result.acFindings?.some((f) => f.severity === 'red')) {
  return { action: 'notify_user', reason: 'AC 审计发现严重问题，请查看后决定' }
}
```

---

## 🟡 YELLOW（重要 — 逻辑漏洞或边界未覆盖）

### Y1 · `nanju-router.ts:168-170` — 重试超限在 success 状态下被静默绕过

```typescript
if (result.retryCount >= phase.retryLimit && result.status !== 'success') {
  return { action: 'notify_user', ... }
}
```

**证据**：条件同时要求 `retryCount >= retryLimit` **且** `status !== 'success'`。假如调用方传入 `{ status: 'success', retryCount: 99 }`（数据异常但代码未防御），第二检查被跳过，流程落入 `ask_user` / `advance`。虽然正常情况下 retryCount 不会在 success 时超限，但 `handlePhaseResult` 作为纯函数不应依赖调用方的行为正确性。

**Fix**：拆分为独立的 retry limit 守卫，不依赖 status：
```typescript
if (result.retryCount >= phase.retryLimit && result.status !== 'success') {
  return { action: 'notify_user', reason: `...` }
}
// 新增：即使 success 但 retryCount 异常也告警
if (result.retryCount > phase.retryLimit) {
  return { action: 'notify_user', reason: `retryCount 异常 (${result.retryCount} > ${phase.retryLimit})` }
}
```

---

### Y2 · `nanju-router-gate.ts:97-99` — `verifyPhaseOutput` 冗余查询项目全量列表

```typescript
const phase = getPhaseNode(
  listNanjuProjects(workspaceSlug).find((p) => p.projectId === projectId)?.mode ?? 'iterative',
  phaseId,
)
```

**证据**：函数已接收 `projectId` 和 `phaseId`，却重新调用 `listNanjuProjects`（可能扫描文件系统）获取 `mode`。且如果 project 找不到，默认 `'iterative'`，可能拿到错误的 `PhaseNode.outputPath`（quick 与 iterative 的 prototype 节点 outputPath 碰巧相同，但脆弱）。

**Fix**：增加 `mode: ProjectMode` 参数，由调用方（已知 mode 的 orchestrator）传入，消除内部查询。

---

### Y3 · `nanju-router-gate.ts:73` — 未知阶段回退到最宽松白名单

```typescript
const whitelist = PHASE_TOOL_WHITELIST[stage] ?? PHASE_TOOL_WHITELIST.requirements
```

**证据**：如果 `project.currentStage` 被意外覆写为无效值（如 `'attack'`），代码默认回退到 `requirements` 白名单（允许 delegate_agent 等全部活跃工具），而非最安全的 `delivered` 白名单（仅 Read/LS）。

**Fix**：回退到最严格白名单：
```typescript
const whitelist = PHASE_TOOL_WHITELIST[stage] ?? PHASE_TOOL_WHITELIST.delivered
```

---

### Y4 · `nanju-router-prompt.ts:101` — 承诺"回退"但无实现

```
- 用户说"回退" → 回到上一阶段
```

**证据**：Prompt 告知用户可通过"回退"回到上一阶段，但 `PhaseNode` 只有 `next`（单向链表），无 `prev`。`nanju-router.ts` 仅导出 `getNextPhase`，无 `getPrevPhase`。调度员无法执行回退 → 用户困惑。

**Fix**：二选一 — ① 移除 prompt 中的回退承诺；② 在 `nanju-router.ts` 中增加 `getPrevPhase` 并在 orchestrator 中响应 `PHASE_ROLLBACK` 标记。

---

### Y5 · `agent-orchestrator.ts:1307` + `nanju-router-gate.ts:55` — Automation 会话注入绕过

```typescript
// orchestrator line 1307
const nanjuRouterPrompt = workspaceSlug && !automationContext && !input.triggeredBy
  ? getNanjuRouterPrompt(workspaceSlug, sessionId)
  : undefined
```

**证据**：automation 触发的会话不注入南大向导 prompt（调度员不知道自己该委派），但 `checkNanjuRouterGate` 在 `canUseTool` 中仍然拦截 Write/Edit/Bash。结果是：automation 会话被锁在门禁里但不知道如何正确操作 → 静默失败或行为异常。

**Fix**：在 `canUseTool` 中也检查 `automationContext`，若为 automation 会话且关联南大项目，应同样跳过门禁（或显式给出友好提示而非 deny）。

---

## 🟢 GREEN（建议 — 代码质量与防御加固）

### G1 · `nanju-router.ts:193-198` — `FORMAT_CHECKS` 为 Partial，新阶段静默通过

```typescript
const FORMAT_CHECKS: Partial<Record<PhaseId, (content: string) => boolean>> = { ... }
export function checkOutputFormat(phaseId: PhaseId, content: string): boolean {
  const check = FORMAT_CHECKS[phaseId]
  return check ? check(content) : true  // ← 未注册的阶段直接返回 true
}
```

如果未来新增 `PhaseId`（如 `'testing'`）但忘记注册格式检查，所有内容无条件通过验证。建议改为 `Record<PhaseId, ...>` 强制全覆盖，或用显式 default 函数。

---

### G2 · `nanju-router-prompt.ts:25-31` — 前序产出路径硬编码

```typescript
const priorFiles: Partial<Record<PhaseId, string[]>> = {
  prototype: ['01_PRD/prd.md'],
  architecture: ['01_PRD/prd.md', '02_UX_DESIGN/prototype.html'],
  planning: ['01_PRD/prd.md', '03_ARCHITECTURE/architecture.md'],
}
```

这些路径应与 `nanju-router.ts` 中的 `PhaseNode.outputPath` 一致，但硬编码了两份。如果路由节点改了 outputPath，这里不会同步更新。建议从路由定义中推导前序产出。

---

### G3 · `nanju-router-gate.ts:1 vs 109` — import 风格不一致

顶部用 `import { ... } from 'node:fs'`（ESM），函数体内用 `const { ... } = require('node:fs')`（CJS）。见 R1，统一为顶层 import。

---

## 汇总

| # | 严重度 | 位置 | 问题 |
|---|--------|------|------|
| R1 | 🔴 RED | `nanju-router-gate.ts:109` | `require('node:fs')` 在 ESM 下崩溃 |
| R2 | 🔴 RED | `nanju-router.ts:173` | AC 红牌检查无视 `requiresAC`，可被注入阻断 |
| Y1 | 🟡 YELLOW | `nanju-router.ts:168` | retryCount 异常 success 静默绕过 |
| Y2 | 🟡 YELLOW | `nanju-router-gate.ts:97` | 冗余 `listNanjuProjects` 查询 |
| Y3 | 🟡 YELLOW | `nanju-router-gate.ts:73` | 未知阶段回退到最宽松白名单 |
| Y4 | 🟡 YELLOW | `nanju-router-prompt.ts:101` | "回退"承诺无实现 |
| Y5 | 🟡 YELLOW | `agent-orchestrator.ts:1307` | automation 会话 prompt 注入绕过 |
| G1 | 🟢 GREEN | `nanju-router.ts:193` | `FORMAT_CHECKS` Partial 静默通过 |
| G2 | 🟢 GREEN | `nanju-router-prompt.ts:25` | 前序路径硬编码重复 |
| G3 | 🟢 GREEN | `nanju-router-gate.ts:1,109` | import/require 混用 |

**优先修复顺序**：R1 → R2 → Y3 → Y1 → Y4。

## Defender

现在我有了完整的证据链。让我撰写防御者回应。

---

# 防御者回应报告

我逐条核验了攻击者的 10 个发现，对照源码、构建配置和运行时产物进行判断。

---

## 🔴 RED 评判

### R1 · `require` 在 ESM 环境下崩溃 → **❌ REFUTE（降级为 GREEN）**

攻击者的核心论断是：项目 `package.json` 设 `"type": "module"`，所以 `require` 不存在。

**事实核验**：

| 检查项 | 实际值 |
|---|---|
| `package.json` `"main"` | `"dist/main.cjs"` |
| 构建命令 | `esbuild --bundle --platform=node --format=cjs --outfile=dist/main.cjs` |
| 构建产物首行 | `"use strict";` + CJS 模式（`var __defProp` 等） |
| 产物中 `verifyPhaseOutput` 函数体 | `const { readFileSync: readFileSync36 } = require("node:fs");` — 完好保留 |

构建产物 `main.cjs:450990` 中，`require("node:fs")` 在运行时**完全可用**。esbuild 在 CJS 打包模式下：
- 将顶层 ESM `import { existsSync } from 'node:fs'` 转换为 `import_node_fs27 = require("node:fs")`（第 451002 行）
- 函数体内的 `require('node:fs')` 原样保留，返回缓存的同一模块实例

`"type": "module"` 只影响 Node.js 对 `.js` 文件的模块解析。Electron 主进程通过 `main.cjs` 入口加载，`.cjs` 后缀强制 CJS 解析，`require` 始终可用。

**结论**：这不是运行时崩溃，是代码风格不一致（同一模块混用 import/require）。建议修复（将 `readFileSync` 提到顶部 import 以消除重复 require 调用），但严重级别应为 **GREEN**（代码整洁度），而非 RED。

---

### R2 · AC 红牌检查无视 `requiresAC` 门禁 → **🔄 CLARIFY（接受修复建议，降级为 YELLOW）**

攻击者提出的修复（`if (phase.requiresAC && result.acFindings?.some(...))`）在防御性编程层面是合理的。但严重级别被高估：

1. **`handlePhaseResult` 当前未被任何调用方使用**。全局搜索结果：该函数仅被 `export`，`agent-orchestrator.ts` 及其他文件均未引用。这是 API 表面层函数，尚未接入管道。
2. **攻击向量不成立**：攻击者称"L2 子会话注入 `acFindings`"。但 `PhaseResult` 由 orchestrator 构造（而非 L2 直接返回），L2 子会话无法直接向纯函数注入任意字段。
3. **`notify_user` 不是永久阻断**：用户收到通知后可以做出决定，不会被永久锁死。

**接受**：加 `phase.requiresAC` 守卫是好实践。**但这是 YELLOW 级别的防御性编程改进，不是 RED**。

---

## 🟡 YELLOW 评判

### Y1 · 重试超限在 success 状态下被静默绕过 → **❌ REFUTE**

攻击者声称 `{ status: 'success', retryCount: 99 }` 这种异常数据应被拦截，并提议增加 `if (result.retryCount > phase.retryLimit)` 检查。

**反驳**：

1. **现有逻辑是正确的**：`retryCount >= retryLimit && status !== 'success'` 的语义是"重试超限**且**仍未成功 → 通知用户"。如果 `status === 'success'`，说明阶段最终成功了，应当推进，不管重试了多少次。
2. **攻击者的修复会引入新 bug**：在 `status: 'success'` 且 `retryCount > retryLimit` 时返回 `notify_user`，意味着**成功的阶段被阻断**——用户做对了但被挡住，这比当前行为更差。
3. **`retryCount` 由 orchestrator 管理**：正常逻辑下 retryCount 仅在失败时递增。一旦成功，retryCount 不会再增长。场景 `{ success, retryCount: 99 }` 在实际调用链中不可能出现，除非 orchestrator 自身有严重 bug——而那应该在 orchestrator 层修复，不是在纯函数里加防御。

---

### Y2 · `verifyPhaseOutput` 冗余查询项目列表 → **✅ ACCEPT（降级为 GREEN）**

观察正确。`listNanjuProjects` 重复查询可以优化为传入 `mode` 参数。

但这是**效率优化**，不是 bug：
- 功能完全正确——查询结果一致
- `?? 'iterative'` 的 fallback 合理：如果项目查不到（数据损坏），iterative 是默认模式
- 对于 `prototype` 阶段（攻击者指出的"碰巧相同"案例），quick 和 iterative 的 outputPath 一致，所以 fallback 安全

**降级为 GREEN**：性能改进，不影响正确性。

---

### Y3 · 未知阶段回退到最宽松白名单 → **✅ ACCEPT（维持 YELLOW）**

完全同意。`PHASE_TOOL_WHITELIST[stage] ?? PHASE_TOOL_WHITELIST.requirements` 违反了**最小权限原则**。如果 `currentStage` 被意外覆写为无效值，应 fail-closed（回退到 `delivered`，仅允许 Read/LS），而非 fail-open。

`stage` 来源是 `project.currentStage as PhaseId`——一个类型断言，运行时不保证值在 union 范围内。修复简单且正确。

---

### Y4 · 承诺"回退"但无实现 → **✅ ACCEPT（维持 YELLOW）**

完全同意。Prompt 中告知用户"说回退 → 回到上一阶段"，但：
- `PhaseNode` 只有 `next`（单向链表），无 `prev`
- `nanju-router.ts` 无 `getPrevPhase` 导出
- orchestrator 无 `PHASE_ROLLBACK` 处理

用户跟着 prompt 指引说"回退"会得到调度员的困惑响应。建议移除 prompt 中的回退承诺（最小改动）。

---

### Y5 · Automation 会话注入绕过 → **✅ ACCEPT（维持 YELLOW）**

完全同意，且证据链完整：

```typescript
// orchestrator:1307 — automation 会话不注入 prompt
const nanjuRouterPrompt = workspaceSlug && !automationContext && !input.triggeredBy
  ? getNanjuRouterPrompt(workspaceSlug, sessionId) : undefined

// orchestrator:1094 — 但门禁不区分 automation
const nanjuGate = checkNanjuRouterGate(workspaceSlug, sessionId, toolName, input)
```

Automation 会话复用同一 sessionId，如果该 session 关联了南大项目，gate 会拦截 Write/Edit/Bash，但调度员不知道自己处于南大管道中，也不知道该用 `delegate_agent`。结果是静默拒绝 + 困惑。

---

## 🟢 GREEN 评判

### G1 · `FORMAT_CHECKS` 为 Partial → **✅ ACCEPT**

合理建议。`Partial<Record<PhaseId, ...>>` + fallback `true` 意味着新增 PhaseId 忘记注册时，所有内容无条件通过。建议改为 `Record<PhaseId, ...>` 强制全覆盖。

### G2 · 前序产出路径硬编码 → **✅ ACCEPT**

合理。`nanju-router-prompt.ts:25-31` 的路径与 `PhaseNode.outputPath` 重复维护。应从 `getPhaseNode` 动态读取或抽取共享常量。

---

## 汇总

| 编号 | 攻击者定级 | 防御者判定 | 理由摘要 |
|---|---|---|---|
| **R1** | 🔴 RED | ❌ **REFUTE → GREEN** | 构建为 CJS bundle，`require` 完全可用，产物已验证 |
| **R2** | 🔴 RED | 🔄 **CLARIFY → YELLOW** | 接受修复，但函数未被调用 + L2 无法注入 + notify 不阻断 |
| **Y1** | 🟡 YELLOW | ❌ **REFUTE** | 现有逻辑正确；修复反而阻断成功阶段 |
| **Y2** | 🟡 YELLOW | ✅ **→ GREEN** | 效率优化，非 bug |
| **Y3** | 🟡 YELLOW | ✅ **维持 YELLOW** | Fail-open 安全隐患 |
| **Y4** | 🟡 YELLOW | ✅ **维持 YELLOW** | Prompt 承诺无法兑现 |
| **Y5** | 🟡 YELLOW | ✅ **维持 YELLOW** | Automation 会话门禁/prompt 不对称 |
| **G1** | 🟢 GREEN | ✅ **维持 GREEN** | — |
| **G2** | 🟢 GREEN | ✅ **维持 GREEN** | — |

**RED 归零。有效 YELLOW 3 个（Y3/Y4/Y5）。有效 GREEN 4 个（R1降级/Y2降级/G1/G2）。Refute 2 个（R1/Y1）。**

## Arbiter


# 代码审计 Round 1 仲裁结论

## 裁决

| # | 攻击者 | 防御者 | 仲裁 | 最终 |
|---|--------|--------|------|------|
| R1 | red (require崩溃) | refute→green (CJS bundle可用) | **agree-defender** | 🟢 green |
| R2 | red (AC注入) | clarify→yellow (函数未调用) | **agree-defender** | 🟡 yellow |
| Y1 | yellow (retryCount异常) | refute (逻辑正确) | **agree-defender** | ❌ dismissed |
| Y2 | yellow (冗余查询) | →green (效率优化) | **agree-defender** | 🟢 green |
| Y3 | yellow (fail-open) | accept yellow | **consensus** | 🟡 yellow |
| Y4 | yellow (回退无实现) | accept yellow | **consensus** | 🟡 yellow |
| Y5 | yellow (automation不对称) | accept yellow | **consensus** | 🟡 yellow |
| G1 | green (Partial) | accept | **consensus** | 🟢 green |
| G2 | green (硬编码) | accept | **consensus** | 🟢 green |

## Red: 0 ✅（攻击者 2 red 被防御者反驳/降级，仲裁同意）

## 需修复的 Yellow（3 个）
- Y3: 未知阶段回退到 delivered（fail-closed）
- Y4: 移除 prompt 中"回退"承诺（或实现 getPrevPhase）
- Y5: automation 会话跳过南大门禁
- R2: handlePhaseResult 加 requiresAC 守卫

## 建议修复的 Green（4 个，不阻塞）
- R1: require→import 风格统一
- Y2: verifyPhaseOutput 传 mode 参数
- G1: FORMAT_CHECKS 改 Record
- G2: 前序路径从 PhaseNode 推导
