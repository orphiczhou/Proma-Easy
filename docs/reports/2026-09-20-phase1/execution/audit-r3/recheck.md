# R3 审计处置与复核（recheck）

> 父会话 2026-09-23 22:20 GMT+8 处置两路异构只读审计的 finding。不修改审计原报告，本文件记录逐条处置与复验。

## delivery-integrity（deepseek-v4-pro）处置

| ID | 级别 | 处置 | 修复位置 | 复验 |
|---|---|---|---|---|
| D-1 | yellow | 已修 | `nanju-delivery-view.ts` stale 分支：同步 `evidence[].verdict='stale'` + 完整性告警并入 `staleMessage` | 新增子进程端到端单测：篡改 skipped>0 + 指纹不符 → verdict=stale、evidence[0].verdict=stale、staleMessage 含「计数不自洽」✅ |
| D-2 | yellow | 已修 | `DeliveryCard.tsx` 空态条件改为 `(viewModel.history ?? []).length === 0` 时才显「暂无测试运行记录」 | typecheck exit 0 ✅ |
| D-3 | yellow | 已修 | `resolveEntryAbsPath` 前缀校验加 `sep`（`resolved===root || startsWith(root+sep)`），导出供测试 | 新增单测：`../project-test-evil/08_APP/index.html` → null ✅ |
| D-4 | green | 暂不处理（记录在案） | shared `GwtReportJson` 手工镜像漂移风险，当前无现实漂移 | — |

## wiring-semantics（glm-5.3-flash）处置

| ID | 级别 | 处置 | 修复位置 | 复验 |
|---|---|---|---|---|
| W-01 | green | 无需改动 | — | — |
| W-02 | yellow | 已修 | `isEnvProbeFresh` 增 `category-mismatch`；`runEnvProbe` 传 `category` 进新鲜度 | 新增「universal→desktop-app 重跑」集成单测 + 纯函数 mismatch 单测 ✅ |
| W-03 | green | 无需改动 | — | — |
| W-04 | green | 无需改动（历史桶口径迁移记录在案） | — | — |
| W-05 | red | 已修（文档更正） | b6 `product-acceptance.md` / `findings.json` 将「46/46」更正为实测「24 pass / 0 fail / 104 expect」 | 实测 `w-i-b-e-wiring` 24 tests / 0 fail / 104 expect ✅ |
| W-06 | yellow | 已修（文档更正） | b6 两处工作树统计改为 46 M + 26 ?? = 72 | `git status --porcelain` 实测 46 M + 26 ?? ✅ |
| W-07 | green | 无需改动 | — | — |
| W-08 | info | 已修 | `buildEnvProbeSummaryLines` 摘要首行附 `探测品类：xxx` | env-probe 测试更新后 34 pass ✅ |

## 验证波

- 4 文件合跑（delivery-view / env-probe / router-prompt / advance-recovery）：**216 pass / 0 fail / 758 expect**。
- Electron typecheck：**exit 0**。
- `git diff --check`：通过。

## 说明

- D-4（shared 类型手工镜像）与 W-04（遥测历史桶口径不可逆迁移）为低危/信息级，非本轮阻断；已在 decisions.md 记录，留待后续。
- symlink 逃逸结论：目录 symlink 由 `isDirectory()===false` 天然跳过；文件级 `index.json` symlink 与 >1MB 由 `lstatSync` 拒绝（审计复验 41/41）。
