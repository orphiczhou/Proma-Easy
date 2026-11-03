# 恢复审计复核（recheck · F1/F2 修复）

> 独立只读复核。未改产品代码、未 commit/push/部署/委派。
> 时间：2026-09-23T18:50 GMT+8 ｜ 基线 HEAD `34f72fbc8114608b998eaf4e1f5e1937f3deeb59`（p1-quick-engineering）。
> 范围：仅复核父对 F1/F2 两处修复；其余报告与反例原样保留。

## 0. 结论

F1、F2 两处修复**均已正确落地**，行为与修复说明一致；既有恢复测试单独复跑全绿，无回归。

## 1. F1 — eventKey=undefined 不再继承 cancelled/consumed ✅ 已修复

- 文件：`apps/electron/src/main/lib/nanju-advance-recovery.ts`（line 60/62）。
- 改动：`executionState` 与 `consumedEventKey` 的「同事件」判定前置 `eventKey &&` 守卫。
  - 修复前：`previous?.eventKey === eventKey && previous?.executionState === 'cancelled' ? 'cancelled' : 'blocked'`
  - 修复后：`eventKey && previous?.eventKey === eventKey && previous?.executionState === 'cancelled' ? 'cancelled' : 'blocked'`
  - 修复后：`consumedEventKey: eventKey && previous?.eventKey === eventKey ? previous?.consumedEventKey : undefined`
- 效果：eventKey 为 undefined（指纹失败）时，不再进入 cancelled/consumed 继承分支 → 新拒因恢复 `'blocked'`，
  `buildPendingAdvanceRecoveryPrompt` 不再返回 null（拒因对模型与跨重启恢复重新可见）。
- 证据：
  - 旧反例 `advance-recovery-eventkey-collision.test.ts` 第 1 项现翻转失败（`Expected "cancelled" / Received "blocked"`），证明行为已变；
  - 新复核 `negative/recheck-f1-f2.test.ts`「F1 复核」通过：取消后新拒因 `executionState='blocked'`、`consumedEventKey=undefined`、prompt 非 null。

## 2. F2 — recoveryState 必须合法 stage/status 才 restored，否则 partial ✅ 已修复

- 文件：`apps/electron/src/main/lib/nanju-project-snapshots.ts`（line 522-536）。
- 改动：
  - 新增合法 stage 集合与形状校验：
    `validStages = new Set(['mode-select','requirements','prototype','architecture','planning','coding','testing','delivered'])`
    `validRecoveryState = Boolean(state && validStages.has(state.currentStage) && state.status)`
  - 非法时降级 `safeState = null`，`restoredStage` 退回当前阶段（不写非法值），`complete` 置 false → `status='partial'`；
  - 文案新增「旧快照缺少合法阶段信息，未恢复阶段。」（诚实声明不恢复阶段）。
- 效果：
  - `recoveryState={}` → `status='partial'`，阶段保持不回退，不再假称「已恢复…阶段」；
  - `recoveryState.currentStage='garbage-stage'` → `status='partial'`，**不写入**非法 currentStage；
  - 完整合法 → 仍 `status='restored'` 且阶段正确回退（对照）。
- 证据：
  - 旧反例 `recovery-state-corruption.test.ts` 第 1/2 项现翻转失败（`Expected "restored" / Received "partial"`），证明行为已变；
  - 新复核 `negative/recheck-f1-f2.test.ts`「F2 复核」3 项全绿：`{}`→partial、非法串→partial 且不写 garbage-stage、完整→restored 且回退 requirements。

## 3. 回归检查

- `nanju-advance-recovery.test.ts`：4 pass / 0 fail（单独跑）。
- `nanju-project-snapshots.test.ts`：28 pass / 0 fail（单独跑）。
- 注：两文件**合并**跑会出现 1 error（`getConfigDirName is not a function`），为相对路径 `mock.module('./config-paths')`
  跨文件泄漏的既有测试隔离问题，与本次修复无关；单跑均全绿。

## 4. 文件指纹截面（recheck 时点）

| 文件 | sha256（修复后） | mtime |
|---|---|---|
| nanju-advance-recovery.ts | 99451ad8f2dd8814fe3e3e76edb8af2d9ac023280e0c5cf135a50cfeab62b25a | 2026-09-23 18:44:07 |
| nanju-project-snapshots.ts | 288388630acdf82aa1e123316042211e9e294d0485dafaa774c5e4f89a6e53cd | 2026-09-23 18:46:11 |

（对照 audit-current 初版截面：nanju-advance-recovery.ts 原 `c581fbc1…`、nanju-project-snapshots.ts 原 `2f3ce00e…`，均已变更。）

## 5. 交付物

- `recheck.md`（本文件）
- `negative/recheck-f1-f2.test.ts`（4 项，锁定修复后正确行为，可复跑）
