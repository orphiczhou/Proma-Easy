# Task5 推进拒因持久化与恢复审计（audit-r2 · advance-recovery）

> 独立只读审计。对象：父新 Task5 片 `nanju-advance-recovery.ts/.test.ts`、
> `nanju-router-gate.ts`（结构化 checks）、`nanju-phase-advance-consumer.ts`（持久拒因）、
> `nanju-router-prompt.ts`（重读重验）、`agent-orchestrator.ts`（injected 消息 appendSDKMessages）。
> 时间：2026-09-20T14:40 GMT+8 ｜ 基线 HEAD `34f72fbc`。
> 方法：源码审查 + 复跑 `nanju-advance-recovery.test.ts`(3) + `w17-phase-advance-chain.test.ts`(117) = 120 pass / 0 fail。
> 本轮只读，未改产品代码。

## 0. 结论

四项关键诉求中，「重启不丢拒因」「同key不重复推进」**成立**；「取消不自动续接」「脱敏」**部分成立**，
各有一处需父关注的低危缺口（A1、A2）。整体 fail-closed 方向正确，无错误放行。

## 1. 重启不丢拒因 ✅
- `persistAdvanceCorrection` → `setProjectPendingAdvanceCorrection` → `writeProjectInfo`
  （`nanju-project.ts:1048` 落盘 `_project-info.json`）；`buildPendingAdvanceRecoveryPrompt` 经
  `getProjectPendingAdvanceCorrection`（`readProjectInfo`，:1041）每轮从磁盘重读。
- 计数跨重启单调：`rejectWithEducationLoop`（consumer:102）用
  `Math.max(bumpAdvanceRejectCount(...), persistedCount + 1)`，内存计数重启归零后不倒退。
- 引用 `nanju-project.ts:1063`：`base.pendingAdvanceCorrection = correction` 后 `writeProjectInfo(...)`。

## 2. 同key不重复推进 ✅
- 幂等键 `eventKey = sha256([projectId, currentStage, target, fingerprint, checks])`（advance-recovery:52），
  同键时保留 `at`（:56）不重置。
- 推进本身不靠持久键：`buildPendingAdvanceRecoveryPrompt` 每次**重验** `evaluatePhaseOutput`
  （:68）并只注入未通过项；文案显式「非推进授权」。故同一产物指纹永远不可能触发重复推进——推进仍走
  `verifyPhaseOutput` 通过 + 授权。
- 说明（非缺陷）：`eventKey` 只用于 `at` 保留，未用于跳过重计数；拒收次数按设计递增（熔断需要）。

## 3. 取消不自动续接 △（低危，A1）
- 已有三重保障：`buildPendingAdvanceRecoveryPrompt` 在 `fromStage !== currentStage` 时返回 null（:67）；
  loop-limit（`count > 2`）停止 `sendContinuation`（consumer:109）；prompt 文案指令「用户取消或改变目标时停止自动续接」。
- **A1 缺口**：无硬编码「取消」旗标。`clearProjectPendingAdvanceCorrection` 仅在**推进成功**时调用
  （consumer:659/1076）；用户「取消但不换阶段」时，持久拒因仍会在下轮注入 prompt（仅文案，不自动推进，
  故不构成错误放行，但无显式取消清除入口）。
- 结论：持久态不会自动续接（`buildPendingAdvanceRecoveryPrompt` 只注入文案、不调 `sendContinuation`），
  方向安全；缺的仅是「取消即清除持久拒因」的显式入口。

## 4. 脱敏与污染 △（低危，A2/A3）

脱敏 `safeText`（advance-recovery:37）：
```
text.replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]')
     .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]').slice(0, 3000)
```
- 覆盖 `api_key=…`、`token: …`、`password=…`、`secret=…`、`Bearer …`，并截断 3000 字符；测试已断言
  `api_key=secret-value` 与 `Bearer abc.def.ghi` 均被隐藏。
- **A2 缺口**：复合名密钥不匹配。`AWS_SECRET_ACCESS_KEY=foo` 中 `secret` 后是 `_ACCESS_KEY` 而非 `[:=]`，
  正则不命中 → 值未隐藏；同理 `PRIVATE_KEY=…`、`DB_PASSWORD`（`password` 后跟 `_` 或直接 `=` 才命中）。
  实际 `=foo` 紧跟 `password=` 可命中，但 `AWS_SECRET_ACCESS_KEY=` 这种 `secret` 非紧邻 `=` 的会漏。
- **A3 污染**：仓库根存在未跟踪 `local-evidence.md`（内容 `local evidence`），源自 `nanju-router-gate.test.ts:1165`
  evidence 检查 fixture 未落 temp 根（Task 6 明令「不得在仓库根留下 local-evidence.md」）。非 Task5 引入，
  但属当前工作树污染，应随 Task6 一并清理。
- `check.path`（相对路径）未脱敏但非密钥；`fingerprint` 为内容哈希非原文，无泄漏。

## 5. 其它观察（非阻断）

- **性能**：`rejectWithEducationLoop` 三处分支（consumer:107/111/155）各调 `persistAdvanceCorrection`，
  每次内部 `phaseArtifactFingerprint` 走树哈希（上限 5000 文件）；单次拒收最多 3 次指纹计算。
  loop-limit 分支更是连续调用两次（:107 与 :111），幂等但冗余。建议合并为一次并复用指纹。
- **injected 消息持久化**：`injectNanjuAssistantMessage`（orchestrator:605）现额外
  `appendSDKMessages(sessionId, [message])`（同步 `appendFileSync`，agent-session-manager:493）+
  `eventBus.emit`；持久失败仅 `console.error` 不阻断。消息结构含自定义 `_createdAt` 字段，经
  `serializeSDKMessageForStorage` 原样 JSON 保留——下一轮 `getAgentSessionSDKMessages` 可读回，
  满足「UI 与下一轮上下文同一持久消息」。建议核对消费侧是否忽略未知 `_createdAt`（不影响，但避免歧义）。
- **旧 schema 兼容**：`buildPendingAdvanceRecoveryPrompt` 对缺 `fromStage` 的旧记录不早退（:67 条件含 `&&`），
  会向当前阶段注入旧拒因（文案带当前阶段与先前 target）；测试「旧schema同样可恢复」已覆盖，方向可接受。

## 6. 指纹截面

| 文件 | sha256 |
|---|---|
| nanju-advance-recovery.ts | 3c5869e9026b90ca8e34442ecabc65553773c98ea396ee4473917f89f557aeb8 |
| nanju-phase-advance-consumer.ts | 6ac2d8c03f1ea99b46e69dda3b52e34bdd9740d08adc926c10a350495d344517 |
| nanju-router-gate.ts | a3bb8a9b6d4b66643137040dc9e19507d76fce83c3dd5bcad86f98e29e2fee92 |
| nanju-router-prompt.ts | 12af1a6146bb10f60e45cd58269dbe01565b33b1adeb1a45c1782bf6ac47bd93 |
| agent-orchestrator.ts | f5ac65d28b5c9f06c3733367e079b239cc1e5588d532bbdb081bf7a25dd41b3b |
| nanju-project.ts | 6982f3bc2b422c2ffd5cc167e93532164ad75765d37dded37d4f2f81675c935c |
