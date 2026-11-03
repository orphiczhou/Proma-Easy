# R3 独立审计 · 接线与遥测增量（wiring-semantics）

> 审计截面：2026-09-23 21:16–21:35 GMT+8（只读）。项目 `/home/orphic/proma-patches/p1-quick-engineering`，HEAD `34f72fbc8114608b998eaf4e1f5e1937f3deeb59`，工作树 72 个未提交改动（46 M + 26 untracked，含 B0–B5 与父会话修复轮）；apps/electron 0.17.132 / shared 0.1.63。
> 审计范围：本轮父会话新增/修改的接线与遥测增量（Task 10 接线、runEnvProbe 品类集、pick-other 遥测、b6 验收矩阵 v1.2）。
> 审计纪律：只读，未修改产品代码、未部署、未启动 release/dev、未委派；测试夹具一律隔离 mktemp/HOME 或 mock config-paths，未触碰 `~/.proma` 真实工作区（失败尝试误建的 `~/.proma/agent-workspaces/test-ws`、`ws`、`~/.proma-dev/agent-workspaces/test-ws` 空目录已清理）。
> 产物：本文 + `findings-wiring.json` + `negative-wiring/`（脚本与日志）。

---

## 结论摘要

- **architecture 品类解析（Task 10 接线）只读语义正确**：静态核对全调用链 + 官方单测复跑，未发现「未判定写入 L2」「影响 coding 元信息」「与推进钩子写入冲突」「iterative 注入品类指引」任一反例（W-01）。
- **runEnvProbe 探测失败不阻断 prompt**：失败/超时/脚本未落位均诚实退化为注入说明行（W-03）；check_env.sh 对未知品类 fail-safe 只跑通用集。
- **审计重点反例成立（red 级重点项，定级 yellow）**：env_probe.json 幂等判定**不比对 category**——同项目先 universal（或初判品类）探测，品类变更后 architecture 重入会复用旧结果，品类专用组件缺失（W-02，含可复跑反例脚本）。
- **pick-other 遥测**：合法枚举、事件表一致、接线测试更新，无全仓 `pick-color` 假设残留；历史数据口径存在不可逆的桶迁移（W-04）。
- **product-acceptance.md 逐条核对**：B6-F-05~10 修复声明与代码一致，未发现能力夸大；但 B6-F-06 证据「w-i-b-e-wiring 46/46」**不可复现**（实测 24 pass / 104 expect），按审计口径判 red（W-05）；头部工作树统计已过时（W-06）。

---

## W-01｜green｜architecture 品类解析只读、无语义错位反例

**Evidence**
- `apps/electron/src/main/lib/nanju-router-prompt.ts:896-912`：`stage==='coding' || stage==='architecture'` 才进入品类解析；写路径 `setProjectCategory`/`materializeEngineeringTemplate` 只在 `if (stage === 'coding')` 分支（903-908 行）；architecture 分支为 `categoryInfo = resolved ?? null`（910 行），零写操作。
- `buildL2TaskWithAC` 内 `categoryInfo` 仅被 `if (isCoding)` 块消费（`nanju-router-prompt.ts:479-490`，`buildCategoryGuideLines` 仅 coding 注入）；architecture 的 L2 任务书只消费 `envProbeLines`（`nanju-router-prompt.ts:1040-1048`），无品类指引注入。
- 推进钩子写入点唯一且在 coding 过渡时：`nanju-phase-advance-consumer.ts:1050-1056`（`newStage === 'coding'` 才 `setProjectCategory`）；与 architecture 只读分支无写入竞争。
- 官方单测复跑（本轮执行）：`nanju-router-prompt.test.ts:1962-1990`「Task 10 接线」1 pass，其中显式断言 architecture prompt 构建后 `getProjectCategory(...)` 仍为 `null`（只读不补写），且探测按品类参数执行（组件名回显 `desktop-app`）。
- iterative（长期迭代型）模式：architecture 首轮 `architecture.md` 未产出时 `resolveProjectCategoryForCoding` 落到 `prd.md`，iterative PRD 无品类标记 → null → 探测降级 `universal`（`nanju-router-prompt.ts:933-940` 的 `?? 'universal'` 兜底）；二轮后读 architecture.md 终判，属已判定事实，语义正确。

**Impact**：无。未判定不会以「已判定」形态进入任何 L2 指令或元信息。

**Repro**：`bun test src/main/lib/nanju-router-prompt.test.ts -t "Task 10 接线"` → 1 pass / 0 fail（审计复跑记录见正文；产物落 audit-r3/negative-wiring/）。

**建议**：无需改动。

## W-02｜yellow（审计重点反例，已实证）｜env_probe.json 幂等不比对 category，品类变更复用旧结果

**Evidence**
- `nanju-env-probe.ts:180-220`（`isEnvProbeFresh`）：新鲜度仅由 `probedAt` 年龄（默认 24h）与模板落地时间（template-manifest.json.copiedAt）决定，**不读取/不比对 `result.category` 与本次请求 category**。
- `nanju-env-probe.ts:246-266`（`runEnvProbe` 步骤 1）：`fresh → 直接读取沿用`，无论存量 `category` 是否等于本次 `opts.category`。
- 实测反例（脚本与日志：`negative-wiring/__r3-audit-repro-envprobe.test.ts` + `repro-env-probe-category-reuse.log`，运行时临时置于 `apps/electron/src/main/lib/` 执行后移回，夹具隔离 mktemp + mock config-paths）：
  - 第一次 `runEnvProbe`（无 category）→ `env_probe.json` `{category:"universal", components:[node]}`；
  - 第二次 `runEnvProbe({category:'desktop-app'})` → **复用旧文件**：`[R3] second.ok= true written.category= universal desktop-item-present= false`，desktop 专用组件（webkit2gtk-4.1）不在「已知环境事实」摘要行 `["探测时间：…","- node：可用（v22）"]` 中。
- 现实触发链：quick 流程 architecture 首轮以 prd 初判（或 universal）探测落盘 → 架构师终判为另一品类 → architecture 回炉/多轮重入时 `resolveProjectCategoryForCoding` 读到 architecture.md 终判，请求新品类，但 fresh 窗口内（24h，快消项目远小于此）复用旧品类探测结果 → 品类专用组件缺失注入。单测覆盖缺口佐证：`nanju-env-probe.test.ts:333-393` 只覆盖「同 category 写入/扩展」，无「category 变更重跑」用例。

**Impact**：architecture 环境事实段缺品类专用组件（如 desktop 的 webkit2gtk/pynput），架构师可能基于不完整探测结论写环境清单；`projectEnv: ready/missing` 门禁输入受污染。缓解项：注入行明示「品类专用探测项按品类模版 §2.3 自行补测」+ 架构师任务书硬性要求「按品类对本机工具链逐组件探测」（`nanju-router-prompt.ts:1044-1052`），且有 envPrecheck/gate 第二道校验——故定级 yellow 而非 red。

**Repro**：见 `negative-wiring/README.md` 运行说明；反例断言 `expect(hasDesktop).toBe(true)` 失败即复现。

**建议**：`isEnvProbeFresh` 或 `runEnvProbe` 沿用分支增加 `existing.category !== category → 视为不新鲜（删除重跑）`；补一条「universal→desktop-app 重跑」单测。

## W-03｜green｜runEnvProbe 失败诚实退化，不阻断 prompt；品类不致「探测失败」误报

**Evidence**
- `nanju-router-prompt.ts:934-941`：`runEnvProbe` 外层 `try/catch`，异常时零注入（注释「探测异常不阻断 prompt 构建」）；探测失败时返回 `buildEnvProbeFailureLines`（`nanju-env-probe.ts:133-137`：失败说明 + 「请架构师自行逐组件探测，不得因本段缺失跳过探测」），任务书仍完整生成。
- 品类传参失败面：真实脚本 `resources/nanju-engineering-templates/check_env.sh:19,70,141`——CATEGORY 不在六枚举时 fail-safe 只跑通用集（不报错）；本轮实测 `bash check_env.sh desktop-app` 正常输出 JSON 行。
- 老项目脚本未落位 → `runEnvProbe` 返回失败说明行（`nanju-env-probe.ts:269-272`），prompt 不被阻断。

**Impact**：无阻断路径。

## W-04｜green（含口径提示）｜pick-other 在合法枚举与事件表内，无全仓假设残留

**Evidence**
- 枚举：`nanju-quick-events.ts:34-39` `ClickToFixStage` 五值含 `'pick-other'`；payload 构建白名单 `isClickToFixStage`（121-127 行）合法。
- 事件表：PRD §12.4 #7「点选纠错」仅要求「点击目标类型 + 是否成功修改」（`docs/DesignDoc/01_PRD/prd.md:820`），不枚举 stage 字面值 → 无文档假设冲突；`PrdTelemetryEventSpec` 表（nanju-quick-events.ts）同样不含 stage 假设。
- 改动一致性：主进程 `nanju-ipc.ts:597-601`（element-click → `pick-other`；panel-action 仍按 592-596 行真实动作映射）与渲染端 `useGlobalAgentListeners.ts:649`（`stage: 'pick-other'`）两处同步；全仓 grep `pick-color` 仅存于：动作映射两处、单测（panel-action 正/反例断言）、b6 报告文本——无测试/文档假设 element-click 恒为 pick-color。
- 接线断言复跑：`w-i-b-e-wiring.test.ts:137-141` 显式断言 element-click 发 `pick-other` 且不出现 `applied: false, stage: 'pick-color'`；审计复跑 24 pass / 0 fail（`negative-wiring/w-i-b-e-wiring-rerun.log`）。
- 口径影响：element-click 事件桶从 `pick-color` 迁至 `pick-other` 是**不可逆的数据口径变更**——修复前落库的 element-click 误标为 `pick-color`，与真实颜色动作混在同一桶；修复后 `pick-color` 桶变纯。跨修复期做时间序列对比会出现 `pick-color` 断崖式下降。仓库内无按 stage 分桶的分析代码/仪表盘（grep 无命中），当前影响限于遥测原始数据语义。

**NOT VERIFIED**（遥测部分）：遥测存储/聚合的既有历史数据无法核验（产品未运行，未读取真实 telemetry 存储）；外部（仓库外）消费方未排查。

## W-05｜red（文档证据夸大）｜b6 验收矩阵 B6-F-06 证据「w-i-b-e-wiring 46/46」不可复现

**Evidence**
- `b6/product-acceptance.md` 修复轮表（69 行）与 `b6/findings.json` B6-F-06.fix 均写「w-i-b-e-wiring 46/46 pass」。
- 审计实测：`bun test src/main/lib/__tests__/w-i-b-e-wiring.test.ts` → **24 pass / 0 fail / 104 expect**（日志 `negative-wiring/w-i-b-e-wiring-rerun.log`）；文件内 `test(` 计数 24（HEAD 与工作树均无历史 46 版本，`git log -p` 该文件仅 +5/-1 行断言更新）；与 `nanju-quick-events.test.ts` 合跑合计 42 pass，仍非 46。
- 该数字仅是证据引用错误；**修复本身真实**（pick-other 两处代码 + 断言更新 + 本轮复跑全绿），不推翻 B6-F-06 已修结论。

**Impact**：验收矩阵证据可信度受损（数字来源不明且偏大）；按「发现夸大必须报 red」口径定级。

**Repro**：`cd apps/electron && bun test src/main/lib/__tests__/w-i-b-e-wiring.test.ts`（对照 46/46）。

**建议**：将两处「46/46」更正为实测值（如「24 pass / 0 fail / 104 expect」，或注明原始统计口径）。

## W-06｜yellow（文档证据漂移）｜product-acceptance.md 头部工作树统计过时

**Evidence**
- 文档头部：「工作树含 68 个未提交改动（42 modified + 26 untracked）」；findings.json `worktree: {modified: 42, untracked: 26}`。
- 审计实测：`git status --porcelain` → **46 M + 26 ?? = 72**。差异 4 个 M 文件与 v1.2 修复轮改动相符（nanju-ipc.ts、useGlobalAgentListeners.ts、w-i-b-e-wiring.test.ts 等），但头部截面仍标 21:20 v1.2 且未更新计数。
- 版本声明本身核实无误：apps/electron 0.17.132、shared 0.1.63（package.json）；HEAD 34f72fbc ✓。

**Impact**：截面统计失真（低危）；「26 untracked」以目录计数口径仍准确。

**建议**：v1.3 时刷新头部统计，或标注「统计时点早于修复轮改动」。

## W-07｜green｜product-acceptance.md「已修/部分修」声明逐条核对（未发现能力夸大）

**逐条核对结果**

| 声明 | 代码/证据核对 | 结论 |
|---|---|---|
| B6-F-05 已修：mapReportVerdict 交叉核对计数不变量 + 计数不自洽警告 + DeliveryCard 渲染 warnings[0] | `nanju-delivery-view.ts:236-250`（pass 需 `passed>0 && failed===0 && skipped===0 && passed===scenariosTotal`，否则 fail）；`reportIntegrityWarnings` 275-283；`buildEvidence` 291 行合并 warnings；`DeliveryCard.tsx:294-297` 渲染 warnings[0]；7 项单测（nanju-delivery-view.test.ts:322-375 交叉核对 describe）+ 隔离 HOME 端到端 9/9（`current-verification/b6f05-integrity-e2e.log` 尾行「9 pass / 0 fail」） | 一致 |
| B6-F-06 已修：两处 pick-other；panel-action 按真实动作映射 | `nanju-ipc.ts:597-601`、`useGlobalAgentListeners.ts:649`、映射保留 `nanju-ipc.ts:592-596` / `useGlobalAgentListeners.ts:722-726`；wiring 测试断言更新（137-141 行） | 一致（唯证据数 46/46 失真，见 W-05） |
| B6-F-07 部分修：buildDeliveryLaunchInstructions 按品类等价入口，缺真实启动动作差异保留 | `packages/shared/src/types/nanju-delivery.ts:165-200`（desktop/cli/api/ai/web/mobile 六分支 + default 兜底，均不代执行命令）；5 项单测（nanju-delivery-view.test.ts:378-413）；文档仍明示 Task 12.3 未完成、未降 DoD | 一致 |
| B6-F-08 已修：manifest.json.bak 删除；JSDoc 对齐 | `ls apps/electron/resources/nanju-engineering-templates/manifest.json.bak` → 不存在；`nanju-delivery-view.ts:24` 注释「损坏/类型错误/缺失的报告不抛错：返回 not-tested 视图」与实现一致；`verify:resources:strict` 日志尾「✓ 校验通过」（resources-strict-20260923.log） | 一致 |
| B6-F-09 部分修：history 字段（倒序上限 10、坏索引跳过、runId 白名单防穿越）+ DeliveryCard 历史列表；GUI 未开视觉未验收 | `nanju-delivery-view.ts:46-97`（readDeliveryHistory：白名单正则、HISTORY_LIMIT=10、坏索引 continue、倒序 sort）；`buildDeliveryViewModel` 挂载 history（366 行）；`DeliveryCard.tsx:315-319`「历史验收记录（最近 N 次）」；隔离 HOME 子进程端到端单测在场（nanju-delivery-view.test.ts:418-495） | 一致 |
| 修复轮复验数字：typecheck exit 0；verify:resources:strict exit 0；9 文件定向波 428 pass / 0 fail / 1413 expect | 三份日志均在 `current-verification/`（typecheck-20260923-b6fixes.log 仅 `$ tsc --noEmit` 无错误输出；wave-20260923-b6fixes.log 尾行 428/0/1413，与文档一致） | 一致 |
| 「工作树 68 个未提交改动」 | 实测 72（见 W-06） | 失真（统计过时） |

**补充核对**：b6 反例 R4 修复后行为（篡改报告按 fail + 警告）由 mapReportVerdict 单测与 b6f05 e2e 日志支撑（源码层）；「dev 未运行/9224 无监听」「外置模板 v1.0 漂移」本轮未复核进程与部署目录（见 NOT VERIFIED），v1.1 事实未发现矛盾。

## W-08｜info｜探测注入措辞与品类参数的轻微不一致（保守无害）

**Evidence**：`nanju-router-prompt.ts:1043` 静态注入「探测为跨品类通用集（脚本 …）…品类专用探测项按品类模版 §2.3 自行补测」；当传了 category（如 desktop-app）时，探测实际已含品类扩展项，但摘要行（`buildEnvProbeSummaryLines`：探测时间 + 组件逐行，`nanju-env-probe.ts:141-149`）与该措辞不标注品类。指令保守（仍要求自行补测），不会误导为「已全量」。

**建议**：摘要首行附 `（探测品类：xxx）`，与 env_probe.json 的 category 字段对齐；可与 W-02 一并处理。

---

## NOT VERIFIED（本轮明确未核验项）

1. **遥测历史数据口径**：telemetry 存储/聚合中修复前 element-click 误标 `pick-color` 的存量数据、跨口径时间序列影响——需运行中产品读取真实遥测库，本轮未运行任何实例。
2. **wiring 的 GUI/真机链路**：element-click 渲染端上报、panel-action→主进程映射未在真实 Electron 会话中实测（沿用 B6-F-01 阻塞口径）。
3. **iterative（长期迭代型）项目 architecture 全链路 prompt 实测**：仅静态核对 + quick 夹具单测；iterative 真实工程的多轮 architecture 重入与终判品类探测未跑真实项目。
4. **「46/46」来源**：无法定位该数字的原始统计口径（24/42 均不匹配），父会话未留存该次运行的日志文件名。
5. **dev 部署漂移与进程态现状**：未复核 `/home/orphic/proma-easy/dev/app` 与端口监听（B6 v1.1 事实照录，未重测）。
6. **仓库外遥测消费方**（若有外部看板/导出工具按 stage 分桶）未排查。
7. **envPrecheck 兜底 web-fullstack 的边界情形**（architecture.md 有 env 标记但无品类标记时按 web-fullstack 白名单校验，可能误报「未通过」）：M7 既有逻辑非本轮增量，静态推理未做实况复现。

## 修复轮声明核对总表（供 findings-wiring.json 消费）

| 审计对象 | 结论 | Finding |
|---|---|---|
| architecture 品类解析只读 | 正确，无副作用反例 | W-01 green |
| runEnvProbe(category) 失败路径 | 诚实退化不阻断 | W-03 green |
| env_probe.json 幂等 × 品类变更 | **复用旧结果，品类专用组件缺失（反例实证）** | W-02 yellow |
| pick-other 遥测 | 枚举/事件表/断言一致；历史桶口径不可逆迁移 | W-04 green |
| b6/product-acceptance.md 声明 | 与代码一致；B6-F-06 证据数夸大；头部统计过时 | W-05 red / W-06 yellow |
| 探测注入措辞 | 与品类参数轻微不一致（保守） | W-08 info |
