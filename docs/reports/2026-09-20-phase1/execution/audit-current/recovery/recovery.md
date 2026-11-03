# 恢复核心审计报告（audit-current · recovery）

> 独立只读审计。未改产品代码、未 commit/push/部署、未委派。
> 时间：2026-09-23T18:30 GMT+8 ｜ 基线 HEAD `34f72fbc8114608b998eaf4e1f5e1937f3deeb59`（p1-quick-engineering）。
> 版本：electron `0.17.132` / shared `0.1.63`（不沿用 9/20 旧 hash；本轮截面见 §5）。

## 0. 结论（TL;DR）

- **无 red/high 缺陷。** 相对 audit-r2（2026-09-20）变更的代码（`nanju-ipc.ts`、`nanju-project-snapshots.ts`
  跨项目归属/符号链接/损坏 journal 处理，以及新增 `nanju-advance-recovery.ts`）主体 fail-closed、保护面完整。
- **4 项 yellow**：F1（指纹失败下 eventKey=undefined 幂等碰撞）、F2（target.recoveryState 形状损坏假 restored）、
  F3（取消语义边界）、F4（IPC 四层类型侵蚀）。均仅报证据，待父会话决定是否修复。
- **7 项 green**：跨项目/会话归属、写路径符号链接逃逸、只读自救、损坏 journal 完整检查点、锁与并发、
  恢复前授权失效语义、取消旧续接，全部复核通过并固化可复跑测试。

## 1. 方法

- 记录 7 个被测文件 sha256 + mtime（见 §5）。
- 编写 3 组主动反例测试，持久化于
  `docs/reports/2026-09-20-phase1/execution/audit-current/recovery/negative/`（未放 /dev/shm 后删）：
  - `advance-recovery-eventkey-collision.test.ts`（F1 演示 + 对照组）
  - `recovery-state-corruption.test.ts`（F2 演示 + 对照组）
  - `recovery-boundary-green.test.ts`（G1–G4 保护复核）
- 全部用绝对路径 mock（agent-session-manager / config-paths），落盘仅在 `mkdtempSync` 临时目录。

## 2. 逐项发现

### F1（yellow）— 指纹失败时 eventKey=undefined 的幂等键碰撞

`nanju-advance-recovery.ts`：`persistAdvanceCorrection` 以 `previous?.eventKey === eventKey` 判定「同事件」。
当 `phaseArtifactFingerprint` 抛错（阶段产物 >20MB、>5000 文件、或读取错误）时 `eventKey` 为 `undefined`，
`undefined === undefined` 恒真，于是：

- 用户取消一次（`executionState='cancelled'`）后，**任何后续拒收**（即使目标/内容不同）都被判为同一事件，
  继承 `'cancelled'`（line 60）；
- `buildPendingAdvanceRecoveryPrompt` 见到 `'cancelled'` 直接返回 `null`（line 70-71），新拒因对模型与跨重启
  恢复均不可见。

这与 line 54 注释「无指纹仍记录 blocked，绝不视为已消费」的意图相悖。对照组（指纹可用 + 产物变化 → 新
eventKey）恢复 `'blocked'` 且可领取续接，证明判定只在 eventKey 退化时失效。

### F2（yellow）— target.recoveryState 形状损坏导致假 restored

`nanju-project-snapshots.ts`：`complete = Boolean(fileRestore?.ok && fileRestore.complete && state)`（line 533）
只对 `state`（`target.recoveryState`）做 truthy 判定，未校验 `currentStage`/`status` 真实存在。若 `_snapshots.json`
被部分损坏为 `recoveryState: {}` 或 `currentStage` 非法：

- `{}` → `state` 为 truthy → `complete=true` → `status='restored'` 且文案「已恢复会话、工程文件与阶段」，
  但 `restoredStage = state?.currentStage ?? project.currentStage` 退化为当前阶段，**阶段实际未回退**（line 523）；
- `currentStage='garbage-stage'` → 直接 `updateNanjuProject` 写入非法 stage 串仍报 restored。

反例测试固化两者行为；对照确认 recoveryState 完整时阶段正确回退到 `coding`。

### F3（yellow · 设计分歧）— cancel 不停止运行中续接

`nanju:cancel-advance-correction`（`nanju-ipc.ts:260`）只调 `cancelAdvanceCorrection`（置持久态
`executionState='cancelled'`），不增 `nanjuContinuationEpoch`、不 `stop()/abort()`。已发出的续接（L1 正在运行）
不受影响。排队中续接会被 epoch/executionState 重查拦截，故取消对「未发出」有效、对「已发出」无效。
属 fail-safe 方向（多跑一段纠偏无错误放行风险），记录为语义边界而非缺陷。

### F4（yellow · 类型侵蚀）— IPC 四层类型不收敛

四层（shared 类型 → preload 接口 → preload invoke → main handler）存在侵蚀：

- `nanjuListProjects/CreateProject/UpdateProject/GetProject/GetProjectStage/GetAutoClarify` 在 preload 返回
  `Promise<unknown>`（preload:1284-1303）；
- `nanjuRollbackSnapshot` 返回 `ProjectRecoveryResult`，丢弃 `ProjectSnapshotRollbackResult.snapshot`
  （nanju-project-snapshots.ts:456-457）与 `FileRestoreOutcome.reason`（:152）；
- 渲染端 `useNanjuGuideData.ts` 手动重声明 `advanceCorrection` 类型。

非运行时缺陷（对象字段仍在，结构兼容），但 main 返回的结构化失败原因（`cross-device`/`locked`/`hash-mismatch`）
在类型上不可分支，只能读 `userMessage` 文案。

## 3. green 保护复核（已固化测试）

| ID | 主题 | 结果 |
|---|---|---|
| G1 | 跨项目/会话归属 | `findRecoveryProjectForSession` 沿 parentSessionId 上溯（≤64 跳防环），无关会话写自身文件放行、写被阻塞工程文件被拒 |
| G2 | 写路径符号链接逃逸 | `resolveWithExistingParents` 对最近存在祖先 realpath 归位；项目外符号链接指向阻塞工程文件仍被拒 |
| G3 | 只读自救 | `RECOVERY_READ_TOOLS` 白名单恒放行，写工具与 shell/MCP 保守阻止 |
| G4 | 损坏 journal 完整检查点 | damagedJournal 分支要求 target 同时具备 recoveryState + 合法 fileSnapshotId + verifyFileSnapshotDir.ok 才放行并归档原日志 |
| G5 | 锁与并发 | `_restore.lock`（wx 独占 + pid/procStart/TTL 陈旧接管 + token 匹配才释放）+ 内存 recoveryLocks；r2 C2 已修复无锁绕过 |
| G6 | 恢复前授权失效语义 | `invalidateRecoveryAuthorization` 删 5 个盘上字段 + `clearNanjuAdvanceAuthState` 清 5 个内存 store，双层覆盖（r2 C3 确认为有意 fail-closed） |
| G7 | 持久消息/取消旧续接 | `nanjuContinuationEpoch` 在 stop()/非 systemInitiated 消息时递增；`runNanjuGuardContinuation` 每次重查 epoch + stoppedByUser + cancelled；stop() 同步调 cancelAdvanceCorrection |

## 4. 测试运行结果

```
advance-recovery-eventkey-collision.test.ts   2 pass / 0 fail
recovery-state-corruption.test.ts             3 pass / 0 fail
recovery-boundary-green.test.ts               5 pass / 0 fail
```

## 5. 文件指纹截面（audit-current）

| 文件 | sha256 | mtime | 状态 | 相对 r2 变更 |
|---|---|---|---|---|
| nanju-project-snapshots.ts | 2f3ce00e0678c020433e8f8cf7bfaa75a8189928d15e200912054cb1c9cc2809 | 2026-09-20 14:51 | M | ✅ 变更 |
| nanju-file-snapshot.ts | 4b30c2dec727bf1ecd562d1ceccf06027c7335e29991e1293d979a4c758b892e | 2026-09-20 14:28 | M | 未变 |
| nanju-snapshot.ts | faa9332322d9a04bec98ed93076cac782bc21c207303330b63175e7a795e4647 | 2026-09-20 14:28 | M | 未变 |
| nanju-ipc.ts | 4d537e57e349a71c827718a384311b7deb0fdca4a66579b4c271191b1a4f97c5 | 2026-09-21 14:35 | M | ✅ 变更 |
| preload/index.ts | ca5e167e813396682744e3e3cbb335567f3ae4b6d25c160b7c747f6f6ae59601 | 2026-09-21 14:35 | M | — |
| agent-orchestrator.ts | 2c45de2238538131991ec125d143559f55b90c40fe41ecef6419349afa8e314b | 2026-09-20 14:58 | M | — |
| nanju-advance-recovery.ts | c581fbc164249cd1df98b89ee4f61b5f37b703ed17105fa9b95e880afb179050 | 2026-09-20 15:00 | ?? 新增 | ✅ 新增 |

## 6. 交付物

- `recovery.md`（本文件）
- `findings.json`（结构化发现）
- `negative/advance-recovery-eventkey-collision.test.ts`
- `negative/recovery-state-corruption.test.ts`
- `negative/recovery-boundary-green.test.ts`
