# GWT Task 1 执行报告 — 必测场景 skip 不得判整体验收通过

- 执行会话：父指挥官 cfce785b 授权的独立执行会话（直接执行，未委派）
- 日期：2026-09-20（GMT+8）
- 基线 HEAD：34f72fbc（v0.17.131，p1-quick-engineering 分支）
- 文件独占遵守：仅改动 `apps/electron/src/main/lib/nanju-gwt-runner.ts`、`nanju-gwt-runner.test.ts` 及本目录；未触碰 agent-orchestrator 等公共文件，未 reset/stash，未覆盖同工作树其他会话改动（git status 中模板/execution/resources 等改动属于并行会话）。

## 1. 问题描述（错误规格复现证据）

`judgeGwtResult` 旧 pass 条件为 `failed === 0 && uncoveredUs.length === 0 && passed > 0`，skip 既不计入通过性也不阻断：
- 既有测试用例 `skip 场景不计入通过性但保持透明统计` 曾断言 `pass+skip → verdict=pass`（本任务已将该用例改为必测语义要求测试，作为错误规格复现证据保留注释）；
- 同 US 一场景 pass、边界场景 skip（skipReason 声明）时整体仍判 pass → 用户摘要显示「全部通过」，交付门（verdict=pass 才放行）被绕过。

## 2. 改动内容

### `nanju-gwt-runner.ts`

1. **裁判收紧（核心）**：pass 条件增加 `skipped === 0`，即
   `failed === 0 && skipped === 0 && uncoveredUs.length === 0 && passed > 0`（等价于 `passed === scenariosTotal` 且无 skip）。所有声明验收场景默认必测，不新增隐式 skip 豁免；确需不适用须显式分类与原因单独展示（分类 schema 属后续任务，本轮以 fail 诚实呈现）。模块头注释同步更新为三条硬约束。
2. **摘要诚实（`buildSummaryText`）**：新增 `failed === 0 && skipped > 0` 分支——「N 个声明的验收场景被跳过，跳过不得视为通过（所有声明场景均为必测）」，缺 US 时并列呈现；不再出现「全部执行成功」冒充；原覆盖分支内的死代码 skip 行移除。pass 分支语义现隐含无 skip，文案保持不变。
3. **报告 md 判定行（`buildReportMarkdown`）**：`failed === 0 && skipped > 0` 时单独句式「未通过（必测场景跳过…）」，不再误用「覆盖不全」错判；场景明细表照常显示 ⏭️ skip 行与跳过原因。
4. **回炉缺陷清单（`runNanjuGwtAcceptanceInner` failLines）**：skip 阻断验收时逐条透明列出每个跳过场景及其 skipReason，并给出补齐/显式分类指引。
5. **工程 suite 兼容（未改 verdict 优先级）**：`engineeringSuite.verdict` 优先级逻辑逐字保留；口径一致性由既有链路保证——工程浏览器驱动的 checks 以 `expected='pass'/actual=status` 判定，skip 状态 → check 失败 → 测试 fail → suite fail，与浏览器路径必测语义一致。

### `nanju-gwt-runner.test.ts`（先红后绿）

- 红：5 个新要求测试先失败（judge pass+skip、摘要句式 ×2、报告 md 句式、编排集成 pass+skip），109 既有用例无意外破坏。
- 绿后共 114 用例全过；改写的错误规格用例更名为「pass+skip：同 US 正常通过但边界场景跳过 = fail（必测语义，错误规格复现已更正）」。
- 计划要求的五组边界覆盖：零场景（既有）、缺 US（既有+新增并存句式）、pass+skip（新增单测+集成）、全 pass（既有+新增多场景边界）、旧报告（既有 legacy-schema/入口缺失用例 + 新增旧 pass 报告不豁免本轮 skip 用例）。

## 2. 测试证据

| 项 | 结果 | 证据文件（本目录） |
| --- | --- | --- |
| 红轮（修复前） | 5 fail / 109 pass（要求的 5 个行为失败） | 本报告 §1 记录；红轮输出未落盘（运行摘要见上），规则见测试注释 |
| 绿轮（修复后） | `bun test src/main/lib/nanju-gwt-runner.test.ts` → 114 pass / 0 fail / 503 expect | `gwt-runner-test-green.log` |
| 邻接回归 | w18-delivery-gate + engineering-browser-driver + engineering-suite + w17-phase-advance-chain → 163 pass / 0 fail | `gwt-regression-neighbors.log` |
| 类型检查 | `bun run typecheck` exit 0 | `gwt-typecheck.log` |

## 3. 自审结论（dod 对照）

- ✅ 必测场景 skip 不能 pass：`judgeGwtResult` skipped>0 → fail；集成用例验证 report.json verdict=fail，交付门（orchestrator 侧 `report.verdict !== 'pass'` 拦截 + 本文件 provenance `record.verdict !== 'pass'`）不会被 skip 报告绕过。
- ✅ 全 pass 仍 pass；零场景 fail；缺 US fail（US 覆盖齐全但 skip 仍 fail 已单独验证）。
- ✅ 失败与工程 suite 独立 verdict 兼容：suite verdict 优先级代码未动，163 个邻接用例无回归；两条路径对 skip 的口径一致（均不得 pass）。
- ✅ 摘要诚实：skip-only 失败专用句式，不出现「全部通过/全部执行成功」；跳过原因逐条透明列出。
- ✅ 仅改允许文件；未 commit、未 bump 版本、未装依赖、未 build/pack、未写 release 配置、未触碰产品数据。

## 4. 未覆盖事项（诚实声明）

- 未在真实受管浏览器/E2E 环境跑全流程（本任务为裁判纯函数 + mock controller 集成层验证；真流程闭环归 B3）。
- 「显式不适用分类」schema（steps.json 增加非 skip 的不适用标注）未实现——当前 skip 一律 fail，是诚实缺省；分类机制需改 steps.json schema 与 L2 词表，超出 Task 1 文件范围，建议后续任务处理。
- `GwtProgressCard` 等 renderer 对 fail+skip 报告的展示沿用既有 report.json 字段（skipped/scenarios），未新增 UI 断言测试。
- 工程契约路径下 scenario 级 skip 的端到端集成未单测（由 driver check 机制与 suite 用例间接覆盖）。

## 5. 父集成建议

1. 版本号由父统一 bump（本会话未动 package.json / SKILL.md）。
2. orchestrator 交付门无需改动：`checkNanjuGwtDeliveryGate` 已按 `report.verdict !== 'pass'` 拦截，skip 假通过修复后自动生效。
3. skip-fail 轮按既有 fail 口径计入 retryPending/回炉预算，`failureKind='coverage'` 分流（补场景/回 requirements，不烧 coding 修复预算）已由既有 `classifyGwtFailure` 承接；若父希望「跳过轮」与「缺陷轮」在遥测中细分，可在 `judge.verdict` 埋点补 `skip_block` 标记（属公共文件，留给父处理）。
4. 后续建议：在 B4/B6 中实现「显式不适用分类 + 单独展示」schema，替换当前的「skip 一律 fail」缺省，避免 L2 用真实场景凑 pass 或滥用 skipReason。

## 5'. 未测不称通过声明

本轮所有结论均来自上述定向测试与类型检查的实际运行输出；无真实浏览器 E2E、无产品级验收运行，相关结论不外推。
