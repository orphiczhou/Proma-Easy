# PromaEasy 第一阶段完善与优化 Implementation Plan

> 执行交接：按当前环境可用的 executing-plans Skill 逐项实施与验收（流程要求已完整写在本计划中）；本文件是待执行方案，不表示下列改动已经完成。

**Goal:** 在现有 Phase 1 快消型主轴与提前实现的六品类工程模板范围内，修复验收/恢复正确性，完成可靠的需求→开发→测试→交付闭环，并降低误拦与环境误判。

**Architecture:** 保留当前 Electron + Pi runtime、JSON/JSONL 持久化、阶段机和工程契约。优先打通已有模块间的结果传递、状态恢复与资源分发，使用同一机器事实驱动门禁、UI与日志；正常业务阶段与 blocked/recovering 等执行状态分离，所有恢复重验原有门禁。

**Tech Stack:** Bun monorepo、TypeScript、Electron、React/Jotai、Bun test；Python/CJS 驱动、受控子进程与工程内证据文件。

---

## 0. 执行基线与约束

- 工作树：`/home/orphic/proma-patches/p1-quick-engineering`，盘点基线 `34f72fbc` / v0.17.131。
- 当前盘点：[项目盘点与问题台账](../reports/2026-09-20-phase1/项目盘点与问题台账-20260920.md)。事实、推断与历史实测在该文件分开标注。
- 开始实施先检查 HEAD 与用户改动；若有新提交，重算受影响部分。使用独立 worktree 或按仓库既有工作树策略执行，不 stash/覆盖未知改动。
- 本计划不扩到长期型、完整 PlantUML、多角色开发全量化、视觉框选或科研看板。
- 不把 AC 轮次当 GWT 轮次，不把环境blocked当产品fail，不把源码测试绿当产品验收通过。
- 不采用“重试达到上限自动放行”；不通过改状态文件跳过门禁完成演示。
- 正式部署保留可回滚版本；release实例和G3b旧工程不进入操作范围。外部发布/推送按当时用户授权执行。
- 已有源码文件修改后使用 `safe-file.ts` 原子写管理项目元数据。修改 IPC 同步 shared/preload/main/renderer 四层类型与错误语义，禁止继续用 `Promise<unknown>` 掩盖恢复结果。
- 每个可交付批次独立提交并按仓库规则递增版本；从当时 HEAD 确定下一版本，不预先抢占版本号。commit 唯一 trailer 为 `Made-with: Proma`。

## 1. 批次路线与关口

```mermaid
flowchart LR
  B0["B0 事实与测试基线"] --> B1["B1 验收/恢复正确性"]
  B0 --> B2["B2 v131补齐与资源分发"]
  B1 --> B3["B3 现有真流程闭环"]
  B2 --> B3
  B3 --> B4["B4 交接/门禁/调整闭环"]
  B3 --> B5["B5 环境/驱动/证据一致性"]
  B4 --> B6["B6 用户体验与六品类验收"]
  B5 --> B6
```

| 批次 | 优先级 / 主要结果 | 退出门槛 | 工作量判断 |
|---|---|---|---|
| B0 | 固定当前事实、测试分类与验收口径 | 有可复算基线、复现样本、证据路径 | 小 |
| B1 | 裁判不假通过，回滚不假成功且状态一致 | skip负例、恢复失败/中断/旧快照/继续会话均可验证 | 大；独立审查恢复状态一致性 |
| B2 | v131承诺兑现，资源与拒因真正到运行时 | 完整资源部署、拒因可见可恢复、专项用例通过 | 中至大 |
| B3 | 旧挂起工程恢复＋新工程从头走通 | testing机器报告与用户试用/交付确认闭环 | 受真实环境与模型耗时影响 |
| B4 | 降低误拦并修复原计划交接/点选调整 | 正常引用可过、越权仍拒；编码前验收；调整后重测 | 中至大 |
| B5 | 环境、驱动、证据协议一致 | blocked不扣产品预算；新鲜环境证据；故障可诊断重放 | 中至大 |
| B6 | 用户可直接试用、回看和恢复；逐品类实测 | Phase1范围验收清单通过；六品类按证据分级 | 按品类滚动交付 |

B1与B2可由独立执行者并行，但 `nanju-ipc.ts` / `agent-orchestrator.ts` 由单一负责人集成，避免并发改大文件。B4/B5在B3验证暴露事实后并行。每批先小范围复现与修复、再定向测试、类型检查、必要构建；只有新失败或涉及跨层改动才扩展检查。

不按原文“~6周”机械顺延，也不在缺基线时承诺精确完成日。第一执行波是 **B0+B1+B2**；完成后应能展示“错误结果不误报、真实拒因可见、旧工程可恢复、新模板正确落位”四个具体结果。第二波B3–B5收流程与协议，第三波B6收产品体验和品类成熟度。

## 2. 公共验证命令与证据规范

命令均在仓库根执行，使用 Bun。当前会话 PATH 未含 Bun，显式加入：

```bash
export PATH=/home/orphic/.bun/bin:$PATH
bun test <下方指定测试文件>
bun run typecheck
bun run electron:build
git diff --check
```

预期：定向测试0失败，6包typecheck exit 0，涉及运行时/UI集成的build exit 0，diff-check无输出。文档/只读证据维护不重跑全构建。

打包批次额外运行：

```bash
cd /home/orphic/proma-patches/p1-quick-engineering/apps/electron
bun run pack
```

预期：当前平台pack exit 0，产物清单与模板manifest一致。只有pack成功仍不足以交付：需实际从产物启动隔离dev，在非仓库cwd创建新工程验证资源落位。

每批证据包含 `gitSha / appVersion / templateHash / projectId / runId / environment / startedAt / endedAt / commands / exitCodes / verdict / interventions`。工程证据放工程内 `06_TESTS/evidence/<runId>/`；平台验收证据放源码项目 `docs/reports/<执行日期>-phase1/evidence/`，不写共享 `/tmp` 作为最终链接。

指标分别记录：`acRounds`、`gwtRuns`、`productRepairAttempts`、`advanceRejects`、`environmentBlocks`、`manualInterventions`。失败历史保留，修复后新增结果，不用覆盖旧结论制造全绿。

## 3. B0：建立可复算基线

### Task 0 — 固定范围、已知失败与参考场景

**读取/产出：** 项目 `docs/reports/2026-09-20-phase1/evidence/inventory-snapshot.json`；仓库 `dispatch/reviews/`；项目 `docs/reports/<执行日期>-phase1/baseline/` 新建 `test-baseline.json`、`acceptance-matrix.md`（执行时创建）。

1. 重读本盘点与 HEAD，确认dev包/模板哈希/进程状态，保存新截面。
2. 汇总本轮已确认 P-01–P-21；为原计划各条建立“实现/测试/真流程/产品验收”四列，标记合理实现替代及依据。
3. 在隔离配置目录执行一次全量测试，记录每条失败；对失败文件单独运行，与批量运行对照，优先定位 mock.module/共享状态污染。不能只做两个总数相等的对照。
4. 分类为真实缺陷、环境依赖、测试隔离、规格变更；每个未解决项写责任模块与重现命令。已知失败清单使用测试ID和原因，不只写“92项环境性”。核心门禁/恢复/验收套件必须可稳定全绿。
5. 查找既有 O3、v131完整AC报告；能取得则对账，不能取得标 `incomplete`。不重派观察员仅为补一份形式终报；缺失报告不阻塞已确认P0修复。

**验收：** 相同SHA、相同环境、相同选择集结果可解释；任何新失败可定位，不被历史总数掩盖。

## 4. B1：先修验收与恢复正确性

### Task 1 — 必测场景skip不得判整体验收通过

**修改：** `apps/electron/src/main/lib/nanju-gwt-runner.ts`。

**测试：** `apps/electron/src/main/lib/nanju-gwt-runner.test.ts`；必要时 `__tests__/w18-delivery-gate.test.ts`。

1. 将既有 `pass+skip` 用例作为错误规格的复现证据，新增“同US正常通过但边界skip，整体不得pass”的要求测试。
2. 默认所有声明验收场景必测；不为快速放行新增隐式skip豁免。若现存场景确需不适用，必须有显式分类与原因，单独展示，不能伪装成通过。
3. 修改规则裁判和摘要，使 `passed===requiredScenarioTotal`、无fail/error/blocked、US覆盖齐全才通过。工程suite已有独立verdict，保持它的优先级，并检查两条路径口径一致。
4. 增加零场景、缺US、pass+skip、全pass、旧报告五组边界；交付门不得被skip报告绕过。

```bash
bun test apps/electron/src/main/lib/nanju-gwt-runner.test.ts
```

**验收：** 本轮复现的既有“pass+skip仍pass”行为被更正；所有用户摘要诚实显示跳过/阻塞，而非“全部通过”。

### Task 2 — 回滚结果四层透传，文件/会话/阶段一致恢复

**修改：**
- `apps/electron/src/main/lib/nanju-project-snapshots.ts`
- `apps/electron/src/main/lib/nanju-snapshot.ts`
- `apps/electron/src/main/lib/nanju-ipc.ts`
- `apps/electron/src/preload/index.ts`
- `apps/electron/src/renderer/components/nanju/guide/GuidePanel.tsx`
- `apps/electron/src/renderer/components/nanju/guide/StageNodeDetail.tsx`
- 共享类型新增 `packages/shared/src/types/nanju-recovery.ts`，由现有类型出口导出。

**测试：** 现有 `nanju-project-snapshots.test.ts`、`nanju-snapshot.test.ts`；新增renderer `guide/rollback-result.test.ts`（以行为与结果分流为中心，不做实现镜像测试）。

1. 建立完整成功、文件失败、会话失败、legacy无文件、补偿失败五类fixture。首先证明“非空snapshot不代表恢复成功”。
2. 透传结构化 `ok/status/message/fileRestore/sessionId`；UI使用实际结论展示“已恢复/部分恢复/恢复失败”，不再把所有失败概括成“快照不存在”。
3. `rollbackToSnapshot`当前只标isCurrent：实施真正的会话恢复或上下文回填，并使项目sessionId、当前阶段、文件版本、界面选择一致。仅在状态真正提交后更新isCurrent。
4. 恢复前保存并索引当前版本，使用户能再返回；保留已有恢复备份，避免将散落备份冒充时间轴条目。
5. 恢复中暂停同工程写入，处理事务失败与补偿；重新计算验收指纹，旧pass/ack不得直接复用。
6. 在真实UI验证失败时没有成功Toast，成功后下一次消息确实进入目标上下文并操作恢复后的文件。

**建议响应契约（实施时复用已有类型，避免重复定义）：**

```typescript
interface ProjectRecoveryResult {
  status: 'restored' | 'partial' | 'failed';
  message: string;
  activeSessionId: string | null;
  restoredSnapshotId: number | null;
  preRestoreSnapshotId: number | null;
}
```

```bash
bun test apps/electron/src/main/lib/nanju-project-snapshots.test.ts apps/electron/src/main/lib/nanju-snapshot.test.ts
bun test apps/electron/src/renderer/components/nanju/guide/rollback-result.test.ts
```

**验收：** 失败不报成功；legacy只切上下文时明确未恢复文件；成功后会话/文件/阶段一致；回滚前版本可重新选择；旧验收结果失效。

### Task 3 — 恢复事务中断后的首次打开

**修改：** `nanju-file-snapshot.ts`、`nanju-project-snapshots.ts`、`nanju-ipc.ts` 中项目打开/恢复入口；必要时应用启动接线。

**测试：** `apps/electron/src/main/lib/__tests__/nanju-file-snapshot.test.ts`，新增中断→打开→恢复行为用例。

1. 复用 `recoverInterruptedRestore`，在打开工程前检查未完成事务。
2. 故障注入到备份后、部分文件替换后、提交前；验证第一次打开先恢复或明确blocked，不能继续写半恢复工程。
3. 恢复点创建失败必须可见；不宣称“内容没有丢失”直到备份/补偿结果可证。

**验收：** 进程重启后无需再次手动点击回滚即可识别并处理未完成事务；失败保留原始备份与诊断。

## 5. B2：补齐 v131，打通真实运行边界

### Task 4 — 统一模板发布来源和依赖分发

**修改：** `apps/electron/electron-builder.yml`、`apps/electron/src/main/lib/nanju-engineering-template.ts`；新增构建脚本 `apps/electron/scripts/verify-engineering-resources.ts`；使用现有dev部署入口补整包资源同步，不继续只换asar。

**资源：** `apps/electron/resources/nanju-engineering-templates/`；新增 `manifest.json`，统一正文/CHANGELOG/README版本，包含六模板、通用脚本、两个骨架、`02-Spike实验协议.md`及必要本地依赖的哈希。

**测试：** `nanju-engineering-template.test.ts`；新增 `nanju-engineering-resources.test.ts`。

1. 用当前“app.asar无模板、外置v1.0、源码v2.4”构造部署复现。
2. 推荐沿用现有extraResources作为打包后权威来源；开发源另有明确模式。若保留asar兜底，必须校验manifest，不依赖“先exists者赢”。
3. materialize复制所有必要引用，补当前缺失的Spike协议；记录项目实际采用的模板版本与内容哈希。可选依赖可降级，必需资源缺失必须给明确诊断。
4. 资源校验脚本在pack产物和部署目标执行，失败即阻止宣布部署成功。
5. 备份同批asar、unpacked、extraResources；部署后从非源码cwd启动隔离dev，创建全新quick工程验证模板与依赖落位。保留旧工程作为兼容恢复样本，不悄悄改写其历史基线。

**验收：** 源码→pack→部署→项目落位哈希可追溯；正常新工程拿到desktop v2.4及完整依赖；旧外置资源不再被静默使用；部署失败可回滚成套产物。

### Task 5 — 结构化拒因、持久化恢复与阶段续接

**修改：** `nanju-router-gate.ts`、`nanju-phase-advance-consumer.ts`、`nanju-project.ts`、`agent-orchestrator.ts`、`nanju-router-prompt.ts`；UI复用 `GuardAlertCard.tsx` / guide 数据链。

**测试：** `nanju-router-gate.test.ts`、`nanju-confirm-advance.test.ts`、`__tests__/w17-phase-advance-chain.test.ts`；新增 `nanju-advance-recovery.test.ts`。

1. 给失败校验生成同源条目，不从错误字符串反向猜测；兼容旧 `verifyPhaseOutput` 调用方。
2. 同一结构写telemetry、项目pending、用户摘要和模型纠偏上下文。保留错误位置/期望/实际/下一步，脱敏并限长。
3. 在无活动run、会话忙、续接giveup、loop-limit四种情况下落盘；下一次合法打开/用户继续/既有授权续接时可消费。
4. 幂等键绑定project、fromStage、target、产物指纹；同一事件只消费一次；成功后清理，过期/版本变化后重验。
5. 保留业务阶段CODE等不变，正交记录executionState=blocked/correcting；UI显示“卡在哪里、做什么、怎样继续”。不需要为了兑现旧方案盲目新增 `CODE_PENDING_TEST_CORRECTION` 枚举。
6. 验证已有quick自动确认条件与收口续接接线。用户确认后的后台架构→coding→testing不应依赖操作者手工“点火”；用户确认、安装授权、最终交付挑战仍保留。

```typescript
interface GateCheck {
  id: string;
  path?: string;
  expected: string;
  actual: string;
  pass: boolean;
  nextAction?: string;
}
```

**验收：** 真正缺产物/AC红项仍拒绝；重复失败达限显示完整原因；重启后可恢复且不重复委派；取消后不再自动续接；模型下轮能看到纠偏，而非只在UI闪过。

### Task 6 — file证据、Task白名单与error诊断专项补验

**修改/测试：** `nanju-router-gate.ts/.test.ts`、`nanju-delegation-watch.ts/.test.ts`、`nanju-engineering-driver-io.ts/.test.ts`、`nanju-gwt-runner.ts/.test.ts`。

1. file证据用URL解析与普通文件检查；明确项目内或已授权证据目录，处理URL编码、空格、中文标点、不存在文件、目录、符号链接边界；说明只是引用检查，不声称内容真实性已验证。
2. 修测试fixture：先创建fixture根，再写evidence，结束清理；不得在仓库根留下local-evidence.md。
3. `[实证]`与`[文证]`来源政策、日期要求、错误文案对齐；补正例与拒绝例。
4. TaskCreate/Update/List/Get在合规角色可用；跨项目、未授权角色仍受原有门禁。
5. 分别注入“coding委派异常”和“契约driver异常”；验证错误摘要、stderr尾部、报告和纠偏消息完整、限长、脱敏，无密钥值落盘。

**验收：** 每条v131 R1–R5承诺均有针对性证据；不会用161个既有测试总数代替专项用例。

## 6. B3：用真流程证明首轮修复

### Task 7 — 恢复旧工程与创建干净对照工程

**工程：** 保留 `project-真流程e2e-剪贴板历史`；新工程另建唯一名称与独立数据目录。旧G3b工程不改动。

**执行前：** 读当前浏览器Skill，使用当时受支持的受管浏览器/本地E2E接口；历史CDP脚本仅作已有方法参考。不要因为交接含脚本就绕过当前运行时的浏览器边界。

1. 确认运行包、extraResources、模板manifest、dev配置目录与端口隔离，再恢复旧工程。
2. 用产品恢复入口解决原pending；不直接把stage改成testing。记录原错因、修复动作、重跑次数。
3. 在新quick工程从正常入口发送同类自然语言需求；走需求、原型、后台开发、测试、试用与确认。
4. 保存06_TESTS报告与工程内证据，核对PRD/契约/代码指纹及runId；展示产物实际启动，不以README或AC通过代替。
5. 加入一个确定性负向样本：使一个必测行为失败，验证阻止交付、自动修复/重测；再注入环境blocked，验证不误修代码、不扣产品预算（若B5尚未落地，此项必须记失败并转B5，不能假通过）。
6. 必要观察员只读，配原设计、具体修改点、期待/反例样本；报告结论由机器证据核对，不照单全收。

**验收：** 旧工程恢复成功与新工程干净闭环分别有结果；testing真实执行；手工干预次数公开；不再把3轮AC算3轮验收。B3只确认首轮闭环，不代表B4–B6已完成。

## 7. B4：门禁与第一阶段交接/修改闭环

### Task 8 — 门禁按实际操作判断，避免暗语化

**修改：** `nanju-delegate-guard.ts`、`nanju-router-gate.ts`、`nanju-router-prompt.ts`；测试使用对应 `.test.ts`。

1. 从19次stage-deny与27次unbound-write-deny取事件样本，人工标注合法引用/真实越界/不确定，不直接宣称全是误拦。
2. 委派优先基于角色、目标阶段、允许产出目录和操作类型；“根据PRD和原型”引用不得当新原型工作。标题仅作描述，不与实际任务同权重。
3. 真跨阶段写入、借审计名义改代码、路径越界必须继续拒绝；文本分词/插空格不能改变授权结果。
4. Read/Grep/Glob等已有只读能力优先。复杂Bash保持保守，不凭cat/grep前缀放开重定向、命令替换、find -exec或带副作用管道。
5. 拒绝消息附实际能力边界与合规下一步，不教模型用暗语绕规则。

**验收：** 固定正反样本集合法任务误拦为0、非法任务漏放为0；未知情况明确blocked。真实项目再测事件级误拦率，不只比总deny数量。

### Task 9 — 验收前置与testing点选修复

**修改：** `nanju-router.ts`、`nanju-router-prompt.ts`、`nanju-test-architecture.ts`、`nanju-router-gate.ts`、`nanju-ipc.ts`、对应点选/路由测试。

1. 对照S2原目标明确quick后台工程经理职责是否并入架构，写等价产物清单；无需为凑角色数量增设会话。
2. 编码前冻结可追溯验收清单：每US正常路径、适用的边界/异常；确实不适用要说明。测试阶段将清单绑定真实驱动执行，不临时删掉难测场景求全绿。
3. coding门检查前置验收规格存在及关联；避免形成“要求可执行测试先于应用”的循环依赖，前置的是规格/feature，不是执行成功报告。
4. 点选按当前预览产物与修改意图路由；testing期间“需要调整”进入08_APP修复与重测，不错误改prototype/PRD。真正需求变更使用已有回退机制。
5. 用prototype、coding、testing三态验证点选目标与PRD修改政策，修改应用后旧报告/ack失效。

**验收：** 验收标准在代码前已确定；调整目标正确；重测覆盖旧行为，未引入S9视觉/框选新范围。

## 8. B5：环境、驱动与证据一致性

### Task 10 — 通用探测＋品类扩展，同一机器事实判ready

**修改：** `nanju-env-probe.ts/.test.ts`、`nanju-engineering-template.ts/.test.ts`、`nanju-router-prompt.ts`、`resources/nanju-engineering-templates/check_env.sh`及品类探测定义。

1. 统一探测schema与执行入口，通用脚本和正文内联脚本不再各自维护。desktop扩展OS/虚拟化/图形会话/剪贴板；密钥仅允许记录名称或布尔，不输出值。
2. env声明、机器probe、最终ready分层。必需组件missing阻塞；可选未装/不适用明确记录，不因无云密钥就误判失败。
3. 增加脚本版本/哈希、探测时间、环境身份；新会话、DISPLAY变化、组件安装后或证据过期时刷新，不能“文件已有components就永久复用”。
4. 对新工程缺探测不能沿用历史缺字段豁免；旧工程兼容显式标unknown并给补测入口。
5. 每个probe独立timeout，整体时间盒能终止和清理；Spike超时事件必须由实际执行超时触发，不能只有枚举。

**验收：** ready由所需组件有效机器证据推导；变更环境后旧ready失效；脚本与模板同源、结果可追溯。

### Task 11 — 驱动blocked协议、断言有效性、执行限制与归档

**修改：** `nanju-engineering-execution.ts/.test.ts`、`nanju-engineering-process-driver.ts`、`nanju-engineering-suite.ts/.test.ts`、`nanju-driver-skeleton.test.ts`、两个skeleton、`nanju-pit-reflow.ts/.test.ts`、`nanju-gwt-runner.ts`。

1. 添加结构化环境阻塞结果与宿主识别。exit2本身不足以证明blocked；校验来源、诊断和场景未执行，异常exit2不得被“洗成环境问题”。
2. 骨架→process driver→interpret→suite→GWT→repair预算整条链测试：缺DISPLAY/设备不可达→blocked；产品断言失败→fail；崩溃/协议坏→error；成功→pass。
3. 自定义驱动可保留，但须通过统一行为合规集：US绑定、独立expected、真实probe、schema、异常/超时、入口黑盒启动、关键断言变异体。拒绝以行数、文件名、非空evidence证明质量。
4. 证据归档 `06_TESTS/evidence/<runId>/<testId>/`，写索引、时间、哈希、来源；会话目录仅作临时产地。重启后可审阅历史，需新鲜宿主票据的交付仍重新验证，不盲目持久化可重放授权。
5. 补原计划基础子进程数限制及逃逸/资源回收验证；只承诺实测支持平台，Windows当前blocked如实展示。完整网络沙箱不偷扩范围。
6. 分别记录AC轮、GWT轮、修复轮、环境阻塞；复盘触发保持来源明确，不混加达到阈值。

**验收：** 环境问题不消耗产品修复次数；stdout/stderr真实错误可达纠偏；产物入口黑盒可运行；坏断言会被变异体打穿；证据迁移后可读且不过期冒用。

## 9. B6：第一阶段用户体验与六品类收口

### Task 12 — 可试用、可回看、可再打开

**修改：** `GwtProgressCard.tsx`、`guide/GuidePanel.tsx`、`guide/StageNodeDetail.tsx`、`NanjuWorkspaceView.tsx`、对应IPC/共享类型、`nanju-model-settings-service.ts`（只修实测发现的问题）。

1. 历史验收从项目报告读取，区分实时运行与最近结果，切会话/重启后仍可查看。
2. 交付页根据契约入口提供“打开/启动/安装说明/查看测试”，普通用户无需进入源码目录；运行有外部副作用时沿用既有批准机制。
3. desktop应实测可直接启动；Web/API/CLI/mobile按品类定义等价可使用入口，若不符合原计划“可双击可执行”必须在产品验收中显式记录差异，不能偷偷降低DoD。
4. 普通状态用“分析需求/设计样子/开发/测试/可试用”等清楚措辞，技术明细保留在展开区；修复“4步”与实际阶段数量不一致。
5. 验证模型设置保存→下一委派生效→重启保持；创建埋点在autoClarify确定后记真实状态。
6. 执行一名零基础用户视角的脚本：创建、确认、试用、查看结果、提出修改、重测、回滚、再打开。

**验收：** 不需要手改代码/目录/元数据完成主链；没有失败成功误报；结果和恢复入口可回看；新手主链不暴露不必要实现术语。

### Task 13 — 六品类代表工程与总验收

按“已有证据先闭环、低成本再扩展”顺序：desktop→CLI/API→Web→mobile→AI。每类只选一个最小代表工程，不扩展模板支持的技术栈数量。

| 品类 | 最小验收内容 | 明确边界 |
|---|---|---|
| desktop | 剪贴板历史：真实监听、去重、搜索/热键、重启持久化、入口启动 | 仅声明实测OS/显示协议；不外推Tauri/Wayland/macOS/Windows |
| CLI | 文件或文本处理：参数、输出、退出码、非法输入、路径空格 | 不依赖交互终端才能判定的样例先做 |
| API | 最小记录服务：启动、健康、正常/异常请求、数据持久化、进程清理 | 数据库/容器条件明示，不把可选Docker强制化 |
| Web | 最小记录工具：创建/编辑/空态/刷新保存、浏览器真实操作 | 点选纠错与应用GWT分别留证 |
| mobile | 真机业务动作及独立UI/数据断言；安装/打开/交互/退出 | 既有OPPO环境证据可复用背景，不能复用为新业务通过；iOS/EAS未测如实标注 |
| AI | 固定录制回放验证协议；具备授权服务条件时补真实调用、失败分流、费用/密钥处理 | 无可用服务条件则真实集成BLOCKED，不自建付费或伪造调用 |

每类记录平台/模板/代码指纹、环境、用例、结果、人工介入、已知限制；模板只回填已证实结论。版本索引从manifest生成，保证头部、CHANGELOG、README同步。

最终验收清单：

- [ ] S1–S3逐项有证据，明确实现替代及未满足项；不以计划勾选代替测试。
- [ ] 新quick工程完整正常链通过；旧工程兼容恢复通过。
- [ ] 必测skip/产品fail/error/环境blocked/产物修改均不能假交付。
- [ ] 自动修复3次预算、熔断、真实回滚与失败通知通过。
- [ ] 回滚中断后重启可恢复；无文件、会话、阶段错配。
- [ ] 收口后自动后台衔接可靠，必要授权不被绕过。
- [ ] 用户可试用、看历史结果、调整、回滚与再次打开。
- [ ] 六品类完成代表样例或明确BLOCKED及外部条件；未验证品类不标全绿。
- [ ] 核心回归套件稳定全绿；全量剩余失败逐条解释、无新增未分类失败。
- [ ] 当前产物与部署资源一致，可回滚；交付报告保留失败历史和人工干预。

## 10. 本轮交接说明

本轮已完成盘点、123项机制测试、1项现有skip行为复现与6包类型检查；未实施上述修复。两个独立只读子会话分别核对原计划覆盖和模板机制；父会话独立核验P0裁判/回滚、资源清单、dev状态、真实项目元数据与遥测。

**下一执行动作：B0建立隔离全量基线，同时用Task1/Task2的负例建立红测试，再并行推进B1正确性修复与B2资源/续接修复。** 不先在旧v130部署上盲目继续长耗时E2E，也不以自动放行压低耗时指标。
