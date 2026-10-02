# 恢复核心复核报告（audit-r2 · recovery-core）

> 独立只读复核。对象：父会话对 r1 审计 C1/C2/C4/C6 的修复 + C3/C5/C8 的处理决定。
> 时间：2026-09-20T14:40 GMT+8 ｜ 基线 HEAD `34f72fbc`（p1-quick-engineering，未 commit）。
> 方法：源码 diff 复核 + 固化为可复跑回归（`negative/recovery-core-negative.test.ts`，7 项全绿）+ 复跑既有 63 项恢复测试。
> 本轮只读，未改产品代码，未 commit/push/部署/委派。

## 0. 结论

四项修复（C1/C2/C4/C6）**均正确落地**，回归测试锁住不退化。C3 保留判定分歧（父不采纳，见 §4）；
C5、C8 父明确待办，本报告**不将其标记为解决**。

## 1. 逐项复核

### C1 — 快照 ID 并发冲突 ✅ 已修复
- 改动 `nanju-snapshot.ts`：`forkAgentSession` 移到 `readSnapshots` 之前（`await` 后再同步重读时间轴，
  读-改-写之间无 `await`），ID 由 `snapshots.length + 1` 改为
  `Math.max(0, ...snapshots.map(s => s.snapshotId)) + 1`。
- 关键前提成立：`safe-file.writeJsonFileAtomic` 全程同步（`writeFileSync`+`renameSync`），
  故 fork 完成后的 read-modify-write 对事件循环原子，两个并发 `createSnapshot` 不再交错。
- 回归 `C1 回归`：两个并发 createSnapshot 交错在 fork gate 后得到**互不相同** id，且都落盘、无重复。

### C2 — 恢复入口绕过 `_restore.lock` ✅ 已修复
- 改动 `nanju-file-snapshot.ts`：`recoverInterruptedRestore` 现在先 `acquireRestoreLock`
  （`stale` → 接管后重取；`locked` → 返回新 `RecoverResult.action='locked'`），
  再调私有 `recoverInterruptedRestoreUnlocked`；`restoreFileSnapshot` 的 stale-takeover 分支改调
  `recoverInterruptedRestoreUnlocked`（已持锁，避免二次加锁死锁）。
- 校正 r1 反例：r1 反例的锁写的是 `procStart:'0'`——该值使 `isPidAlive` 判为 pid 复用（陈旧），
  故在修复后会被**正确接管**而非 blocked。本次回归改用**真正活跃锁**（不写 `procStart`，`kill(pid,0)=true`）：
  活跃锁在场时 `recoverInterruptedRestore` 返回 `{ok:false, action:'locked'}` 且不把 staging 搬成 projectDir；
  无锁时 `nothing-to-recover` 正常（不误伤）。

### C4 — snapshot IPC 路径穿越 ✅ 已修复
- 双层防护：① `nanju-snapshot.getSnapshotsPath` / `nanju-project-snapshots.getProjectFileSnapshotStorageDir`
  拒绝非串/空/`.`/`..`/含 `\` `/` NUL 的 workspaceSlug/projectId；② IPC `nanju:create-snapshot` 先
  `getNanjuProject` + `project.sessionId===input.sessionId` + `isRecoveryWorkspaceBusy` 校验，
  `nanju:list-snapshots` 先 `getNanjuProject` 校验。
- 回归 `C4 回归`：`listSnapshots`/`getProjectFileSnapshotStorageDir` 对 `../../etc`、`..`、`a/b`、`a\b`、`x\0y` 均抛「标识非法」；合法 `p1` 正常返回。

### C6 — pre-restore 语义污染 ✅ 已修复
- `triggerType` 联合类型新增 `'pre-restore'`；`rollbackProjectSnapshot` 的恢复前检查点改传 `'pre-restore'`；
  `resolveRepairRollbackSnapshot` 过滤 `.filter(s => hasFileSnapshot(s) && s.triggerType !== 'pre-restore')`。
- 回归 `C6 回归`：同时存在 pre-modify(file-1) 与 pre-restore(file-2) 时，repair 回滚目标选 `file-1`，不选 pre-restore。

## 2. 复跑结果

- 既有恢复测试：`nanju-snapshot`(6) + `nanju-project-snapshots`(26) + `nanju-file-snapshot`(31) = **63 pass / 0 fail**。
- 新增回归：`negative/recovery-core-negative.test.ts` = **7 pass / 0 fail**（C1/C2×2/C4×3/C6）。

## 3. 遗留与风险提示（非本轮修复项）

- **C2 残余**：公开 `recoverInterruptedRestore` 现在每次调用会 `mkdirSync(storageDir)` + 创建/删除锁文件；
  经 `recoverBeforeProjectOpen`（项目列表/详情/向导图每次）触发时存在无谓的锁文件 churn，属低危，不阻塞。
- **C5 仍待办（父已认领）**：`getWorkspaceRecoveryBlock` 仍为工作区级，任一项目 partial/未提交即拦整 workspace
  全工具（含 Read），跨项目干扰 + partial 项目无法自救。**本报告不将其标记为解决。**

## 4. C3 判定分歧（保留，不视为缺陷）

- 父决定：文件在恢复/补偿中**真实经历过替换**，旧 `deliveryAck/deliveryChallenge` 失效是有意的安全语义，
  文案已明确要求重新验收；不采纳「补偿路径原样恢复旧 ack」。
- 审计保留原判：失败回滚被补偿后，补偿态与真实回滚前态在「授权态」上不一致（用户失败回滚也丢既有验收）。
  因 fail-closed 方向无错误放行风险，且父已声明为有意语义，**降级为设计分歧记录，不再要求修改**。

## 5. C8 状态（父已认领，未解决）

- 损坏 `_project-recovery.json` 仍走保守 blocked（`getProjectRecoveryBlock` 非空 + `recoverInterruptedProjectRestore`
  返回 `ok:false`），无程序内恢复入口，需产品级「隔离归档+重建」入口。**本报告不将其标记为解决。**

## 6. 指纹截面（audit-r2，代码仍会迭代）

| 文件 | sha256 |
|---|---|
| nanju-snapshot.ts | faa9332322d9a04bec98ed93076cac782bc21c207303330b63175e7a795e4647 |
| nanju-file-snapshot.ts | 4b30c2dec727bf1ecd562d1ceccf06027c7335e29991e1293d979a4c758b892e |
| nanju-ipc.ts | 3ea6447e7ec81b48caf39ca77096cb21137e86537e4abf510ae5706b2967e5e1 |
| nanju-project-snapshots.ts | 5596dcd47b1a6ce5401d55a57932458ece14483937f9dfe39c58bcbe6d2ae5ce |
