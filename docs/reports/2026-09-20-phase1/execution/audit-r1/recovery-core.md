# 恢复核心审计报告（audit-r1 · recovery-core）

> 独立只读审计。对象：父会话 cfce785b 未提交的恢复核心实现。
> 时间：2026-09-20T14:23 GMT+8 ｜ 基线：`34f72fbc` v0.17.131（p1-quick-engineering）。
> 范围：Task 2（回滚四层透传 + 文件/会话/阶段一致恢复）、Task 3（恢复事务中断后首次打开）。
> 方法：只读源码审查 + 2 个主动反例脚本（/dev/shm，已运行后清理）+ 63 项现有恢复测试复跑全绿 + 严格路径论证。
> 未 commit / 未 push / 未部署 / 未修改产品代码 / 未委派。

## 0. 结论速览

恢复核心在「正常路径 + 失败补偿 + 崩溃窗口 + 篡改/跨设备拒绝 + legacy/partial」上实现扎实，
63 项恢复测试全绿，fail-closed 设计贯穿（捕获失败不写 fileSnapshotId、恢复失败补偿、损坏快照拒绝）。
但发现 **2 个高危（red）** 问题：并发快照 ID 冲突导致检查点静默丢失（C1），
以及恢复入口绕过 `_restore.lock` 的跨实例并发防护（C2）。两者均已用实际反例脚本复现，非推断。

| 级别 | 数量 | 项 |
|---|---|---|
| red（高危） | 2 | C1 快照 ID 并发冲突、C2 恢复入口无锁 |
| yellow（中） | 4 | C3 补偿清授权、C4 IPC 路径穿越、C5 工作区级块过粗、C6 pre-modify 语义污染 |
| green（低/信息） | 3 | C7 读路径副作用、C8 损坏日志无自愈、C9 类型缺字段 |

## 1. 高危发现

### C1 — 快照 ID 并发冲突（snapshotId = length + 1）
- **位置** `nanju-snapshot.ts:117`：`snapshotId: snapshots.length + 1,`
- **触发** `agent-orchestrator.ts:730-731` 的 `captureCheckpoint` 是 fire-and-forget（`void (async()=>{})()`），
  阶段推进/交付成功后**后台并发**建检查点；与用户手动 `nanju:create-snapshot` 并发即触发。
- **反例** `/dev/shm/audit-cc.test.ts`：两个并发 `createSnapshot` 都读到 `length=1` 后各算 `snapshotId=2`，
  最终磁盘 `_snapshots.json` 只剩 `[1,2]` —— **一个检查点（fork 会话 + 文件快照 + 描述）被静默覆盖丢失**。
  在「以可靠恢复为立命之本」的模块里，静默丢失一个恢复点是不可接受的。
- **修复** 用持久化单调 ID（写前读 `max(snapshotId)+1` 且同项目加写锁），或改用 UUID/时间戳；
  对同项目 `createSnapshot` 串行化（模块级 promise 队列或文件写锁）。

### C2 — 恢复入口绕过 `_restore.lock`
- **位置** `nanju-project-snapshots.ts:355/359`：`recoverInterruptedProjectRestore` 直接调用引擎
  `recoverInterruptedRestore`（`nanju-file-snapshot.ts:1050`），该引擎函数全程**不 `acquireRestoreLock`**。
- **反例** `/dev/shm/audit-lock2.test.ts`：构造活跃 `_restore.lock`（pid=当前进程、token='other-owner'）
  + journal `current-moved` + projectDir 缺失，`recoverInterruptedRestore` 仍执行 rename 完成恢复
  （`action=completed-restore`、projectDir 落位），锁文件原样保留。
- **影响前提** 跨实例（dev/release）共享同一 workspace-files 时：一实例正在 `restoreFileSnapshot`
  （持锁），另一实例打开工程触发 `recoverInterruptedProjectRestore` → 无锁介入在途事务 → 状态错乱。
  单进程内由内存 `recoveryLocks` + 同步执行兜底，暂不触发。
- **修复** `recoverInterruptedProjectRestore` 调引擎 recover 前先获取引擎锁（复用 stale-takeover 语义），
  或让引擎 `recoverInterruptedRestore` 在破坏性操作前自行 acquire 锁。

## 2. 中危发现

### C3 — 补偿路径无条件清除用户既有授权
- **位置** `nanju-project-snapshots.ts:363`：补偿写回 `invalidateRecoveryAuthorization(journal.beforeInfo)`。
- 回滚失败→补偿→删除 `deliveryAck/deliveryChallenge/confirmPendingStage/pendingAdvanceCorrection/codingDelegationId`。
  真实回滚前这些字段存在（如 testing 已 deliveryAck），故**补偿态 ≠ 回滚前态**：用户失败回滚反而丢验收授权。
- **修复** 补偿路径原样写回 `journal.beforeInfo`；仅成功恢复才 invalidate。

### C4 — snapshot IPC 未校验 projectId（路径穿越）
- **位置** `nanju-ipc.ts:656`（list-snapshots）、`645`（create-snapshot）；拼接在 `nanju-snapshot.ts:84`、
  `nanju-project.ts:267`（`join(workspaceFilesDir, project-${projectId}, ...)`）。
- 实测 `projectId='../../../x'` → normalize 得 `workspace/x/_snapshots.json`（逃离 workspace-files）；
  `create-snapshot` 经 `captureFileSnapshot` 可快照任意目录。`rollback-snapshot` 因 `getNanjuProject` 早退相对安全。
- **修复** 所有 snapshot handler 先 `getNanjuProject` 校验归属（或白名单 `^[A-Za-z0-9][A-Za-z0-9_-]*$`）。

### C5 — 工作区级恢复块过粗（跨项目干扰 + 无法自救）
- **位置** `nanju-project-snapshots.ts:337`（`getWorkspaceRecoveryBlock`）→ `agent-orchestrator.ts:2335-2337`（canUseTool）。
- 任一项目 partial/未提交 → 对**整个 workspace 的全部工具（含 Read/Grep）** deny；项目 A 的 partial 阻断无关项目 B；
  partial 项目自身连 Read 都被禁，无法用 agent 自救。
- **修复** 块降为 project 级；partial 态至少放行只读工具。

### C6 — pre-modify 语义污染（repair 回滚目标错乱）
- **位置** `nanju-project-snapshots.ts:429`：恢复前检查点 `triggerType='pre-modify'`。
- `resolveRepairRollbackSnapshot`（:532）优先取最近 `pre-modify`；回滚后恢复前检查点成为最晚 `pre-modify`，
  使下次 repair（`agent-orchestrator.ts:960`）把「被回滚掉的当前态」当成健康态。
- **修复** 恢复前检查点用独立 `triggerType`（如 `pre-restore`），`resolveRepairRollbackSnapshot` 排除之。

## 3. 低危 / 信息

- **C7** `getWorkspaceRecoveryBlock` 每工具调用 O(n) 读盘，且读路径经 `getWorkspaceFilesDir` 带 `mkdirSync` 副作用。
- **C8** 损坏的 `_project-recovery.json` 永久硬阻塞、无程序内自愈（只能手工删文件，误删丢补偿依据）。
- **C9** preload 类型 `ProjectRecoveryResult` 缺运行时返回的 `snapshot` 字段（当前 renderer 未消费，无运行期错误）。

## 4. 正向确认（非橡皮章）

- **G1** 63 项恢复测试复跑全绿，覆盖失败与正常双路径：捕获中变更拒绝、篡改/路径逃逸/跨设备拒绝、
  恢复后校验失败补偿、rename1/rename2 崩溃窗口 recover、陈旧锁接管、legacy 只切分支、partial、损坏日志、
  状态提交失败补偿后保持硬阻塞。
- **G2** fail-closed 贯穿：S4 唯一写入路径、S8 完整性不夸大、S9 跨设备可行动、S10 备份不自动删、S11 contentHash 自洽、布局守卫。
- **G3** 成功路径会话/阶段/文件一致 + 旧授权失效（测试「完整恢复…旧交付授权失效」通过）。

## 5. 审计边界与未覆盖

- 未做 GUI 实测（UI 结论由 `recovery-ui.md` 姊妹审计覆盖）；未 build/pack（系统盘 66MB 受限）。
- 未验证 `forkAgentSession` 真实跨进程语义（测试为 stub），C1 的并发触发在真实 fork 耗时下更易复现。
- 未覆盖「恢复中用户再次点回滚」的极端时序（由 `recoveryLocks` + `_restore.lock` 双锁部分兜底，但 C2 暴露的锁缺口使该时序在跨实例下仍可疑）。

## 6. 建议处理顺序

1. **立即**：C1、C2（高危，且均有可复现反例，修复成本小——ID 单调化 / 补锁）。
2. **本轮收口前**：C3、C4、C5、C6（C4 涉及 IPC 安全边界，建议随 C1/C2 同批）。
3. **可延后**：C7、C8、C9。
