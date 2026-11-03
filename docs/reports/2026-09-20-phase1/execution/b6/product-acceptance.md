# B6 产品验收矩阵（当前快照 · v1.1 复验版）

> 截面时间：2026-09-23 GMT+8（v1.0 约 19:27，v1.1 独立复验 19:16–19:35）。只读审查，未启动 release/dev，未部署，未执行 Electron GUI；本文件不是产品验收通过声明。
> 版本：apps/electron 0.17.132（工作树未提交）/ shared 0.1.63；源码 HEAD 34f72fbc8114608b998eaf4e1f5e1937f3deeb59，工作树含 72 个未提交改动（46 modified + 26 untracked，B0–B5 交付物与 R3 修复轮）。
> v1.1 变更：由第二个独立只读会话对 v1.0 做复验与扩充——重跑定向测试、新增 11 项结构化反例验证、确认 dev 部署资源漂移、新增 4 条 findings（B6-F-05~08）。
> v1.2 变更（父会话修复轮，2026-09-23 21:20 GMT+8）：修复 B6-F-05（verdict 计数交叉核对）、B6-F-06（点选遥测 stage）、B6-F-08（.bak 残留与注释失准），部分修复 B6-F-07（品类等价入口说明）/B6-F-09（历史验收记录列表）；复验证据见下方「修复轮」。

## 结论

总判定：**BLOCKED / NOT ACCEPTED**。源码定向测试证明若干产品护栏和数据转换行为，但缺少运行中的 dev 产品、真实 GUI、真实工程入口和包内资源验证，因此 `coveredUs=[]`，不把源码绿外推为产品绿。typecheck 只作工程红线核对，不当产品绿。

## 能力矩阵

| 能力 | 源码/协议证据 | 当前产品结论 | 阻塞/边界 |
|---|---|---|---|
| 可试用 | DeliveryCard 只读入口模型；入口 `realpath` 防 `../`/symlink 逃逸（反例 R8 实测拒绝）；preview 走既有 IPC；启动说明纯文本不执行命令（反例 R5） | NOT-RUN | 未打开 Electron GUI；未证明真实入口可预览/运行。desktop/CLI 等可执行产物目前只有"预览/查看目录"，无"启动/安装说明"动作（Task12.2/12.3 差异，见 B6-F-07） |
| 可回看 | 读 `06_TESTS/report.json`；pass/fail/error/blocked/stale/not-tested 六态分层；入口指纹变化标 stale（反例 R6/R7 实测）；证据条目含 runId/覆盖US/重试 | PROTOCOL-PASS, PRODUCT-BLOCKED | 未在真实工程 GUI 回看。回看深度有限：视图只含最新一份 report.json + 每轮 evidence 归档（`06_TESTS/evidence/<runId>/index.json`，重启后可读），无跨 run 历史列表 UI（见 B6-F-09） |
| 可再打开 | 恢复事务 journal 全程落盘；崩溃后 recover 分支 74 项测试全过（rename1/rename2 窗口、补偿、锁接管、TTL、symlink/特殊文件 notRestored）；fail-closed 不虚报成功 | SOURCE-PASS, PRODUCT-BLOCKED | 未启动真实产品点击恢复；旧工程仍 coding/pending testing |
| testing 点选 | `clickToFixPolicy`：testing/delivered 点选目标 `08_APP/`、mustRetest；IPC 清 deliveryAck/challenge/advanceAuth（实测源码） | SOURCE-PASS | 未真实点击。旧 report.json 在测试完成后被修改时靠指纹转 stale，而非主动改写（语义正确但依赖用户点"重新测试"） |
| 交付结论 | 六态真实区分：反例 R9 实测 fail/error/blocked 不互相洗白；skip>0 由 GWT 生成端判 fail；not-tested 不冒充任何结论（反例 R1/R2/R3 fail-closed） | SOURCE-PASS, PRODUCT-BLOCKED | 未跑真实 GWT 交付与用户确认；不能宣称 delivered。信任边界缺口见 B6-F-05 |
| 六品类 | 契约 TARGET_KINDS 与交付 DELIVERY_TARGET_KINDS 同为 web/api/mobile/desktop/cli/ai；manifest 六品类模板 v2.0–v2.4（bundle 2.5.0）12 项 required 全部 sha256 校验一致 | PROTOCOL-PASS, PRODUCT-BLOCKED | 无六个代表工程从创建到交付；desktop 编排版为历史实测、mobile 为真机环境验证，均非本轮当前平台流程 |

## 结构化反例验证（本轮新增，11/11 pass）

夹具写入隔离 HOME（mktemp），`PROMA_DEV=1`，不触碰 `~/.proma` 真实工作区；脚本与日志归档于 `logs/b6-counterexample-delivery.*`。

| # | 反例 | 结果 |
|---|---|---|
| R1 | 无 report.json | not-tested，hasHistory=false，不冒充结论 |
| R2 | report.json 损坏 JSON | fail-closed：not-tested，不抛错 |
| R3 | verdict='partial'（洗白尝试，非法枚举） | fail-closed：not-tested，schema 校验拒绝 |
| R4 | 探测：手工篡改 verdict=pass + skipped=5 | **观察值：仍显示 pass**（信任边界缺口，见 B6-F-05） |
| R5 | 正常 pass + 指纹一致 | pass + 启动说明含预览指引 |
| R6 | 产物内容修改 | stale + 提示重新运行验收测试 |
| R7 | 入口文件删除 + 原 verdict=pass | stale，entryAbsPath=null |
| R8 | 入口 `../../../outside/secret.html` 路径逃逸 | entryAbsPath=null，不解析工程外文件 |
| R9 | verdict=fail/error/blocked 三例 | 三者保持区分，不洗成统一值 |

## 当前样本事实

- 旧平台工程：`project-真流程e2e-剪贴板历史` 处于 `currentStage=coding`、`subStage=CODE`，pending target/expected=`testing`，`06_TESTS`为空，coding errorCount=2。不能当 testing 或产品验收通过。
- 对照工程：`project-剪贴板历史工具e2e` 有历史驱动报告，但 `_project-info.json` 明确为 release 侧编排样本、事后补档，不能替代平台 quick 流程。
- dev 实例未运行（2026-09-23 19:29 复核：无 Proma Electron 进程，19877/9224 无监听）；本轮不启动/不部署；release 不操作。

## 本轮独立复验（v1.1 会话）

| 波次 | 文件 | 结果 | 日志 |
|---|---|---|---|
| B6 核心机制 | delivery-view / advance-recovery / acceptance-baseline / click-to-fix-policy / engineering-evidence / evidence-reference / file-snapshot | 74 pass / 0 fail | focused-b6-core-tests.log |
| 门禁/交付/ack 链 | w17-phase-advance-chain / w18-delivery-gate / gwt-runner / delegate-guard / w-i-b-f-real-gate | 457 pass / 0 fail | focused-b6-gate-tests.log |
| 资源与模板 | engineering-resources / engineering-template | 128 pass / 0 fail | focused-b6-resources-tests.log |
| 执行套件 | engineering-suite / process-driver / model-settings / driver-skeleton / blocked-protocol | 99 pass / 0 fail | focused-b6-suite-tests.log |
| 结构化反例 | 交付视图 11 项 | 11 pass / 0 fail | b6-counterexample-delivery.log |

合计 641 定向 pass / 0 fail（源码层）。不含 GUI、pack、部署运行。

## 当前部署态事实（v1.1 新增复核）

- dev 安装 `/home/orphic/proma-easy/dev/app/`：外置 `resources/nanju-engineering-templates/` 的 desktop-app.md 仍为 **v1.0**（源码 v2.4，bundle 2.5.0），且无 manifest.json / driver-skeleton.* / check_env.sh —— 与源码资源集合漂移（印证台账问题#3，v1.0 结论仍有效）。
- 源码 `resources/nanju-engineering-templates/` 存在 `manifest.json.bak` 残留文件；electron-builder filter `!**/*.bak` 与 afterPack 意外文件检查已覆盖，不会进包，但建议清理（B6-F-08）。
- 打包排除与 afterPack 校验规则已核实（electron-builder.yml:97、scripts/after-pack-verify-resources.cjs）。

## 修复轮（v1.2，2026-09-23 21:20 GMT+8）

| Finding | 处理 | 证据 |
|---|---|---|
| B6-F-05 | 已修：`mapReportVerdict` 交叉核对计数不变量（`passed>0 && failed===0 && skipped===0 && passed===scenariosTotal`），不自洽一律按 `fail`，并向证据追加「计数不自洽」警告（DeliveryCard 已渲染 warnings[0]） | 7 项单测 + 隔离 HOME 端到端 **9/9**（`current-verification/b6f05-integrity-e2e.log`）；反例 R4 由「仍显示通过」变为「fail + 警告」 |
| B6-F-06 | 已修：裸元素点击 stage `pick-color` → `pick-other`（主进程点选收口 + 渲染端上报两处）；panel-action 仍按真实动作映射 | `w-i-b-e-wiring` 24 pass / 0 fail / 104 expect（R3 W-05 已校正：原记 46/46 系证据引用错误，修复本身真实） |
| B6-F-07 | 部分修：`buildDeliveryLaunchInstructions(entryPath, kind)` 按品类给等价入口（desktop/cli/api/ai/web/mobile 各指向 README 安装/启动说明，仍不代执行命令）；**缺真实「启动」动作的差异保留在本文档**，未偷偷降 DoD | 新增 5 项单测；差异记录见下表 |
| B6-F-08 | 已修：源码模板 `manifest.json.bak` 删除；delivery-view JSDoc 与实现对齐（缺失/损坏 → not-tested 视图） | `verify:resources:strict` exit 0 |
| B6-F-09 | 部分修：交付视图新增 `history`（读 `06_TESTS/evidence/<runId>/index.json`，倒序上限 10，坏索引跳过，runId 白名单防穿越），DeliveryCard 增「历史验收记录」列表 | 隔离 HOME 子进程端到端单测；**GUI 未开，视觉未验收** |
| B6-F-10 | 未修（属部署动作）：dev 外置模板 v1.0 漂移需重新部署，本轮不部署 | 保留 open |

修复轮复验：typecheck exit 0；`verify:resources:strict` exit 0；9 文件定向波 **428 pass / 0 fail / 1413 expect**（`current-verification/wave-20260923-b6fixes.log`）。

### 本轮仍未满足的 DoD（诚实记录，不降级）

- **desktop「可双击/可直接启动」**：交付页目前只提供入口定位与 README 说明 + 预览，没有产品内真实启动动作（需 GUI + 外部副作用批准机制，本轮无法验证）。原计划 Task 12.3「desktop 实测可直接启动」**未完成**。
- **跨 run 历史列表**：已提供数据与列表渲染代码，但真实工程里 `06_TESTS/evidence/` 尚未有第二轮记录，且 GUI 未开，故「切会话/重启后仍可查看」的产品断言未实测。
- 六品类代表工程产品验收、旧工程恢复入口、pack 后资源校验：均未执行。

## 必须解阻后再验收

1. 在隔离 dev 实例（非 release）部署包含 manifest、check_env、骨架和 afterPack 验证的成套产物；消除外置模板 v1.0↔v2.4 漂移。
2. 从正常平台 quick 入口创建全新工程，走需求→原型→架构→编码→testing→试用→交付确认。
3. 旧工程通过产品恢复入口消费 pending，验证 `06_TESTS` 真实生成并重新测试，而不是直接改阶段。
4. 对至少 desktop + web/api/cli/mobile/AI 代表工程记录真实环境、runId、entry fingerprint、coveredUs；缺环境项明确 blocked。
5. pack 后实际运行 `after-pack-verify-resources.cjs`，再从非源码 cwd 启动并验证资源来源。

## Findings 汇总（v1.1）

| ID | 严重度 | 内容 | 状态 |
|---|---|---|---|
| B6-F-01 | red | 真实 GUI 产品流程未执行（dev 未运行/9224 无监听） | blocked |
| B6-F-02 | red | 六品类无本轮代表工程产品验收（coveredUs=[]） | blocked |
| B6-F-03 | yellow | 旧工程仍停在 coding pending testing，06_TESTS 空 | open |
| B6-F-04 | green | 源码状态分层与恢复护栏有定向证据（源码层） | verified-source-only |
| B6-F-05 | yellow（已修 v1.2） | 交付视图信任 report.json 的 verdict 字段，不按 counts 二次推导，也无报告完整性摘要校验：手工篡改"pass+skipped>0"的报告仍显示"验收通过"（R4 实测）。GWT 生成端有约束，属篡改面/纵深防御缺口 | open |
| B6-F-06 | yellow（已修 v1.2） | element-click 埋点 stage 固定发射 'pick-color'（nanju-ipc.ts 点选收口分支），与实际动作类型不符，影响点选遥测的阶段归因 | open |
| B6-F-07 | yellow（部分修 v1.2） | 交付页对 desktop/CLI 等可执行产物只提供"预览/查看测试目录"，缺"启动/安装说明"动作与品类等价入口说明，与计划 Task 12.2/12.3 有差距 | open |
| B6-F-08 | green（已修 v1.2） | 源码模板目录残留 manifest.json.bak（不进包，afterPack 已拦截，建议清理）；delivery-view JSDoc 称损坏/缺失报告返回 null，实际返回 not-tested 视图（行为 fail-closed 正确，注释失准） | open |
| B6-F-09 | yellow（部分修 v1.2） | 交付回看仅含最新 report.json 一条证据；跨 run 历史（evidence/<runId>/index.json）可经“查看测试目录”到达但无产品 UI 列表 | open |
| B6-F-10 | yellow（open，待部署） | dev 部署资源漂移仍存在：外置 desktop-app.md=v1.0（源码 v2.4/bundle 2.5.0），无 manifest/skeleton/check_env；印证台账问题#3 | open |

## 可复跑源码证据

- `bun run --cwd apps/electron typecheck`：exit 0（v1.0 会话执行）。
- 资源 CLI：exit 0，manifest required=12、bundleSha256 自洽（v1.0 会话）。
- v1.0 会话定向波：delivery/resources/env 270 pass；恢复 65 pass；门禁/GWT 485 pass；focused 15 pass。
- v1.1 会话定向波与反例：见上表，641 pass / 0 fail。
- 这些数字仅是源码/协议层证据；真实 GUI、包内资源、用户故事 coveredUs 均未因此变为通过。
