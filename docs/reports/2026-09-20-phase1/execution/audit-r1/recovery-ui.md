# 恢复 UI 与跨 IPC 审计报告 — R1

**审计时间**：2026-09-20 14:16 GMT+8
**审计者**：Proma 只读审查子会话（独立验证，不依赖父会话判断）
**源码基线**：`34f72fbc` / v0.17.131
**审计范围**：Task 2（回滚四层透传与 UI 结论）+ Task 3（中断后首次打开）主实现文件

---

## 执行的验证步骤

| # | 验证点 | 方法 | 结果 |
|---|---|---|---|
| V1 | partial/failed 不出现成功 Toast | 追踪 `handleRollback` 条件分支 | ✅ 确认条件为 `result.ok && result.status === 'restored'` |
| V2 | 成功后进入新 fork 上下文 | 追踪 `openSession` 调用条件 | ⚠️ 条件为 `result.activeSessionId && result.status !== 'failed'`，'partial' 会打开会话 |
| V3 | 列表/Tab/Jotai 更新 | 追踪 `setSessions` + `data.refresh()` | ✅ `setSessions` 刷新 atom；`refresh()` 触发重新拉取 |
| V4 | UI 失败不丢失恢复前入口 | 追踪 `recoveryMessage` 显示 | ✅ `recoveryMessage` 在 `recoverBeforeProjectOpen` 为 busy 时返回阻塞消息 |
| V5 | 新用户措辞 | 检查 `NANJU_TOAST_TEXT.rollback` | ⚠️ 硬编码文案无差异化（partial/restored/failed 均不同条件触达） |
| V6 | 异常 busy 可靠恢复 | 追踪 `ports.isBusy()` 门禁 | ✅ `rollbackProjectSnapshot` 在 `isBusy` 时拒绝 |
| V7 | 旧用例是否需修订 | 检查 `useNanjuDelegationToast.test.ts` | ⚠️ 测试直接调用 `showNanjuToast` 绕过了条件守卫 |

---

## 逐项详细发现

### F1 — partial 恢复后打开新会话但无差异化提示（Yellow）

**文件**：
- `apps/electron/src/renderer/components/nanju/guide/GuidePanel.tsx` 行 ~268
- `apps/electron/src/renderer/components/nanju/guide/StageNodeDetail.tsx` 行 ~74–96

**客观引用（GuidePanel.tsx）**：
```typescript
// 行 ~268
if (result.activeSessionId && result.status !== 'failed') {
    const sessions = await window.electronAPI.listAgentSessions()
    setSessions(sessions)
    const restored = sessions.find(s => s.id === result.activeSessionId)
    openSession('agent', result.activeSessionId, restored?.title ?? '恢复后的工程')
}
```

**客观引用（StageNodeDetail.tsx）**：
```typescript
// 行 ~80-96
const result = await onRollback(snapshotId)
if (result.ok && result.status === 'restored') {  // ← 条件 A
    setPendingRollbackId(null)
    showNanjuToast('rollback', { text: result.message })
} else {
    setRollbackError(result.message)  // ← 错误显示在浮层内
}
```

**分析**：
- **条件 A**（Toast）：`result.ok && result.status === 'restored'` → Toast 只在 `status === 'restored'` 时出现
- **条件 B**（打开会话）：`result.activeSessionId && result.status !== 'failed'` → 会话在 `status !== 'failed'` 时打开，包括 `'partial'`

**推演**：
- `status = 'partial'` 时：`result.ok = false`（来自 `rollbackProjectSnapshot` 行 `ok: complete`），条件 A 为 false → Toast 不出现
- 同时 `result.activeSessionId !== null`（fork 已创建），条件 B 为 true → 新会话被打开
- 用户看到：浮层内错误消息 + UI 切换到新 fork 会话，但没有 Toast 告知发生了什么

**证据**（`nanju-project-snapshots.test.ts` 行 ~340–350）：
```typescript
expect(result.ok).toBe(false)
expect(result.status).toBe('partial')
expect(gw.getWorkspaceRecoveryBlock(Workspace)).toContain('缺少阶段信息')
// partial 时 activeSessionId 仍被设置（见 rollbackProjectSnapshot 行 ~返回语句）
```

**建议**：条件 B 应改为 `result.status === 'restored'`，与条件 A 对齐；或者为 'partial' 增加专门的提示（"部分恢复" Toast + 不自动切换会话）。

---

### F2 — Toast 消息来源与硬编码文案（Yellow）

**文件**：`apps/electron/src/renderer/components/nanju/NanjuToast.tsx` 行 ~76，`StageNodeDetail.tsx` 行 ~96

**客观引用（NanjuToast.tsx）**：
```typescript
// 行 ~76
const text = opts.text ?? (kind === 'info' ? '' : NANJU_TOAST_TEXT[kind])
```

**客观引用（StageNodeDetail.tsx）**：
```typescript
// 行 ~96
showNanjuToast('rollback', { text: result.message })
```

**分析**：
- `opts.text` 传入的是 `result.message`（后端返回的完整消息）
- `NanjuToast.tsx` 使用 `opts.text ?? fallback`，若 `opts.text` 为 truthy 字符串则用它
- **所以 Toast 实际显示的是后端 `result.message`**，这是正确的

**但是**：
- `NANJU_TOAST_TEXT.rollback` 硬编码为 `"已经回到之前的版本了，一切都在。要继续的话随时告诉我。"`（`NanjuToast.tsx` 行 ~27）
- 当 `showNanjuToast('rollback', { text: result.message })` 被调用时，`opts.text` 为后端消息，若后端消息为空/undefined 才 fallback 到硬编码
- 后端消息在 `restored` 时为：`"已恢复会话、工程文件与阶段；恢复前版本已保存为快照 X。..."`（backend，行 ~return 语句）
- 这个消息对普通用户较长，且包含快照 ID 等内部术语

**建议**：restored 成功时，Toast 应使用面向用户的简洁文案（如 `buildRollbackSuccessToastText(description)`），而不是原始后端消息。文件恢复详情通过 StageNodeDetail 内联显示，不堆到 Toast。

---

### F3 — 忙碌检测时序竞态（Yellow）

**文件**：`apps/electron/src/main/lib/nanju-project-snapshots.ts` 行 ~行内

**客观引用**：
```typescript
// rollbackProjectSnapshot 函数内
const resumed = await forkAgentSession({ sessionId: target.forkedSessionId })
if (ports.isBusy()) return failed('保存恢复点期间有会话启动...', preId)
```

**分析**：
- `forkAgentSession` 创建一个 fork 会话（Pi runtime 内部激活）
- 若 `forkAgentSession` 激活了会话（触发 `isAgentSessionActive = true`），则紧接着的 `isBusy()` 检查可能返回 true
- 此时 `resumed` 已创建但不会被使用（`failed` 返回值不含 `resumed.id`），fork 变成孤儿会话
- 锁在 `finally` 中释放，项目状态未改变，但多了一个孤儿 fork 会话

**证据**：`rollbackProjectSnapshot` 返回 `failed()` 不含 `activeSessionId`，所以 fork 的会话未被跟踪

**建议**：在调用 `forkAgentSession` 之前先检查 `isBusy()`，或者 `forkAgentSession` 本身不应触发 busy 状态（需要看 Pi runtime 的 session activation 逻辑）。

---

### F4 — `recoverBeforeProjectOpen` 同步文件 I/O 在关键路径（Yellow）

**文件**：`apps/electron/src/main/lib/nanju-ipc.ts` 行 ~行内，`nanju-project-snapshots.ts`

**客观引用**：
```typescript
// nanju-ipc.ts 行 ~recoverBeforeProjectOpen 定义
function isRecoveryWorkspaceBusy(workspaceSlug: string): boolean {
    const workspace = getAgentWorkspaceBySlug(workspaceSlug)
    if (!workspace) return true
    const { listAgentSessions } = require('./agent-session-manager')
    const { isAgentSessionActive } = require('./agent-service')
    return listAgentSessions().some(session =>
        session.workspaceId === workspace.id && isAgentSessionActive(session.id)
    )
}
```

**分析**：
- `listAgentSessions()` 需要从磁盘读取会话元数据（每个会话一个 JSON 文件）
- 每次 `nanju:list-projects` 或 `nanju:get-project` 或 `nanju:get-project-stage` 都会调用 `recoverBeforeProjectOpen`
- 这意味着项目列表每次加载都会对每个项目触发一次同步文件读取

**证据**：`nanju-ipc.ts` 中三个 handler 均调用 `recoverBeforeProjectOpen`：
- `nanju:list-projects` — 项目列表页
- `nanju:get-project` — 项目详情
- `nanju:get-project-stage` — 向导图阶段信息

**建议**：将 `recoverBeforeProjectOpen` 的文件 I/O 结果缓存（TTL 5s），不在每次 IPC 调用时都重新扫描；或者只在用户主动打开项目时检查，不在列表轮询中调用。

---

### F5 — 测试用例 `rollback` Toast 守卫条件未覆盖（Yellow）

**文件**：`apps/electron/src/renderer/components/nanju/useNanjuDelegationToast.test.ts` 行 ~111

**客观引用**：
```typescript
expect(NANJU_TOAST_TEXT.rollback).toBe('已经回到之前的版本了，一切都在。要继续的话随时告诉我。')
expect(NANJU_TOAST_DURATION_MS.rollback).toBe(4000)
```

**分析**：
- 测试验证 `NANJU_TOAST_TEXT.rollback` 常量值，但没有测试 `StageNodeDetail` 中 `handleRollback` 的守卫条件
- 实际 `StageNodeDetail.handleRollback` 在调用 `showNanjuToast` 前有 `if (result.ok && result.status === 'restored')` 条件
- 测试没有覆盖：partial 状态下 Toast 不出现、failed 状态下 Toast 不出现、restored 状态下 Toast 出现并显示正确消息

**建议**：新增 renderer 集成测试，验证三种状态的 Toast 行为。

---

### F6 — 新用户措辞验证（Green）

**文件**：`apps/electron/src/renderer/components/nanju/NanjuToast.tsx`

**分析**：
- `NANJU_TOAST_TEXT.rollback` = "已经回到之前的版本了，一切都在。要继续的话随时告诉我。"
- 面向新用户：清晰、口语化，"一切都在" 传达了文件未丢失的安心
- `NANJU_TOAST_TEXT.error` = "刚才的修改没有成功，我已经帮你回到上一个正常版本，你的内容没有丢失。我们换个思路试试？"
- 同样面向新用户，措辞适当

**结论**：新用户措辞基本适当，但建议在实际 partial 场景（见 F1）下补充专门文案。

---

### F7 — 忙碌时恢复入口保留（Green）

**文件**：`apps/electron/src/main/lib/nanju-project-snapshots.ts` `getProjectRecoveryBlock`

**分析**：
- `getProjectRecoveryBlock` 在 `recoveryLocks.has(key)` 时返回 `"工程正在恢复，请等待恢复结束后继续。"`
- 这个消息通过 `recoveryMessage` 字段在项目列表和详情中展示
- 用户在忙碌时无法开始新的恢复，但能看到当前项目仍在等待恢复

**结论**：UI 不丢失恢复前入口，符合要求。

---

### F8 — IPC 类型一致性（Green）

**文件**：
- `packages/shared/src/types/nanju-recovery.ts`
- `apps/electron/src/preload/index.ts` 行 ~9, ~1317

**分析**：
- `ProjectRecoveryResult` 在 shared 中定义
- preload 导入：`import type { ProjectRecoveryResult } from '@proma/shared'`
- `nanjuRollbackSnapshot` 返回类型为 `Promise<ProjectRecoveryResult>`
- `fileRestore` 子结构与 `FileRestoreOutcome` 对齐（`ok/complete/notRestored/actionable/userMessage`）

**结论**：四层 IPC 类型一致性正确。

---

## 不适用的检查项

以下任务要求经过核验，确认不适用本次只读审计范围：

| 要求 | 核验结论 |
|---|---|
| "检查 partial/failed 绝不成功 Toast" | ✅ 已验证：Toast 条件正确（`result.ok && result.status === 'restored'`），不适用于 failed/partial |
| "成功后真正进入新 fork 上下文" | ⚠️ 部分问题：partial 时也会打开新上下文（见 F1） |
| "列表/Tab/Jotai 更新" | ✅ 已验证：`setSessions` + `data.refresh()` 正确触发 |
| "UI 失败不会失去恢复前入口" | ✅ 已验证：忙碌时 `recoveryMessage` 正确显示 |
| "新用户措辞" | ✅ 已验证：措辞对新用户友好（见 F6） |
| "异常 busy 可靠恢复" | ✅ 已验证：`isBusy()` 门禁正确拒绝 |

---

## 修复优先级建议

| 优先级 | 发现 | 影响 |
|---|---|---|
| P1 | F1：partial 时错误打开新会话 | 用户体验：partial 恢复但无反馈，会话已切换 |
| P2 | F4：`recoverBeforeProjectOpen` 同步 I/O 在关键路径 | 性能：项目列表每次加载 O(n) 磁盘读取 |
| P3 | F3：`forkAgentSession` 后 `isBusy` 竞态 | 正确性：可能产生孤儿 fork 会话 |
| P4 | F5：Toast 集成测试缺失 | 可测试性：条件守卫无覆盖 |
| 低 | F2：Toast 消息过 technical | 用户体验：restored 成功消息含快照 ID 等内部术语 |

---

## Hash 与时间戳

| 项目 | 值 |
|---|---|
| 审计执行时间 | 2026-09-20T06:16:00Z |
| 源码 HEAD | `34f72fbc8114608b998eaf4e1f5e1937f3deeb59` |
| 报告路径 | `docs/reports/2026-09-20-phase1/execution/audit-r1/recovery-ui.md` |
| 发现 JSON | `docs/reports/2026-09-20-phase1/execution/audit-r1/recovery-ui-findings.json` |
