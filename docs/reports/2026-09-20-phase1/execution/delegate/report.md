# Task 8 执行报告 — 门禁按实际操作判断，避免暗语化

- 执行会话：父指挥官 cfce785b 授权的独立执行会话（直接执行，未委派）
- 日期：2026-09-20（GMT+8）
- 基线：34f72fbc（p1-quick-engineering）；文件独占遵守：仅改 `nanju-delegate-guard.ts/.test.ts`、`nanju-gwt-runner.test.ts`（后者为追加 GWT 集成用例）及本目录；未触碰 `nanju-router-gate.ts`/`nanju-router-prompt.ts`（父所有），未覆盖同工作树其他会话改动，未 commit/bump/部署。

## 1. 事件样本与人工标注

样本来源：`/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/_telemetry/events-2026-09.jsonl`，按精确 projectId=`真流程e2e-剪贴板历史` 复算：`delegate.guard.stage-deny` 19 条、`router.gate.unbound-write-deny` 27 条（与盘点台账 §3.2 一致）。原始事件已归档：`stage-deny-events.jsonl`、`unbound-write-deny-events.jsonl`。

### 1.1 stage-deny 19 条标注（SD-1..SD-19，见归档 jsonl）

| 类别 | 事件 | 依据 |
| --- | --- | --- |
| 误拦·上游产物引用 | SD-4、SD-5 | architecture 阶段「根据 PRD 和原型／与既有 UX 产出，产出精简架构文档」——prototype ROLE 词「原型/UX」被引用词触发 |
| 误拦·正文高频词 | SD-1 | requirements 阶段「Python 技术栈可用」命中 architecture 裸「技术」 |
| 误拦·ASCII 相对路径/文件名碰撞 | SD-6、SD-16 | 「02_UX_DESIGN/prototype.html」命中 prototype ROLE「prototype」（输入文件清单语境） |
| 误拦·引用/模板引文语境 | SD-2、SD-7、SD-8、SD-9、SD-10、SD-17、SD-18、SD-19 | PRD 编写指引/评审要点/auto-gate 诊断文本引用「测试用例」「实现」「架构」等，无他阶段施工意图 |
| 正确拦截（真实越界） | SD-11、SD-12、SD-13、SD-14、SD-15 | architecture 阶段委派「开发工程师—编码落地」（title+task 同为 coding，含 08_APP 产出声明）——阶段机口径下必须拒绝；根因在 verify-failed 推进链（归父 B1/续接修复），不在守卫松动 |

计数：误拦 14 / 正确拦截 5 / 不确定 0（引用类与文件名类已分类）。**不宣称全部为误拦**；SD-11..15 的正确拦截保持拒绝。

### 1.2 unbound-write-deny 27 条标注（UW-1..UW-27）

| 类别 | 事件 | 依据 |
| --- | --- | --- |
| 正确拦截（未绑定会话直写阶段产物） | UW-2、UW-5（Bash→01_PRD/prd.md）、UW-10、UW-13、UW-14（→02_UX_DESIGN/prototype.html）、UW-17、UW-18（→03_ARCHITECTURE）、UW-21（→08_APP/app/clipboard_history.py）、UW-23、UW-25（→08_APP）、UW-26（→architecture.md）、UW-6、UW-8（Write→09_IMPROVEMENTS，非阶段目录且未绑定） | W19 缺陷A 设计语义：未绑定会话直写导致阶段状态与产物脱节；L2 委派子会话豁免未生效说明这些写入本身就不在管线内 |
| 保守正确/不确定（Bash 触及项目根） | UW-1、3、4、9、11、12、15、16、19、20、22、24、27 | payload 不含命令文本，无法区分只读与写；「bash-project-path」保守不解析符合设计（拒绝文案已给只读替代：Read/LS/Grep/Glob 不受限） |

计数：正确拦截 15 / 保守不确定 12 / 误拦 0。**该守卫（router-gate 内）不在本任务文件范围，未改动**；分类结论供父侧复核。

## 2. 改动内容（nanju-delegate-guard.ts）

1. **引用语境豁免（出现级）**：新增 `REFERENCE_MARKERS`（根据/依据/基于/对照/比照/参考/参照/引用/按照/依循/遵循/沿用/来自/出自/既有/前序/上游）+ `isReferenceOccurrence` + `findKeywordExcludingReferences`。他阶段 ROLE 词扫描（第 2 步）改为出现级判定：同一词全部出现都处于紧邻标记语境 → 按「引用既有产物」放行（修复 SD-4/SD-5 实测误拦类）；存在任一非引用出现仍拒绝。标记词全为双字词且要求紧邻（仅 ≤6 字符无句读夹层 + 和/与/及/或、连接符），不收录「按/依/原」单字标记与长窗口——「直接按开发方案编写代码」仍拒（反样本测试固化），拒绝面不提示本表存在，不教暗语。
2. **标题降权**：拒绝面（AC 审计意图第 1 步、R2 修复路由第 1.5 步、他阶段扫描第 2 步、下游 OUTPUT 第 2.5 步、强动词第 4 步）统一改用工作文本 `buildWorkMatchText`（task + expectedOutput）——标题单独命中他阶段词不制造拒绝，也不为 task 的拒绝提供豁免（「标题需求分析师掩护按 PRD 生成代码」仍拒，测试固化）；放行面（本阶段词第 3 步）保留 title 参与既有宽匹配。`describeKeywordHit` 归因同步跳过引用语境出现（归因与拒绝面同口径）。
3. **CJK 分词硬化**：`compactCjkWhitespace` 删去相邻中文之间的空格/换行/制表符后再匹配——「开 发」「编\n写」与连续词同判，插空格/换行分词不能改变授权结果（两个方向：deny 侧漏放与豁免侧构造都被堵；「根据 PRD 和原 型」引用豁免同样抗分词）。
4. **词表复核（Task 8 延续 W19-C 惯例）**：architecture ROLE 去裸「技术」（SD-1 实测误拦「技术栈」），换精确复合词「技术选型」（本阶段匹配不削弱，护栏测试固化）。
5. **第 2.5 步（强动词+下游 OUTPUT）同样接入出现级引用豁免**——「引用既有代码…」类审查语境不再误判产出意图；真产出（如「根据原型生成界面稿」）仍被 ROLE 子串/OUTPUT 守卫拒绝（测试固化）。

### 2.1 明确未做（边界与父侧建议）

- 未改 `nanju-router-gate.ts`/`nanju-router-prompt.ts`（父所有）。stage-deny 通用 deny 文案（含「当前阶段允许委派的角色关键词」列表）在父文件内，本轮未触碰；现有文案已给合规下一步（补角色声明/PHASE_ADVANCE 推进）且未教暗语。
- 未将「修复/修改/重构」加入 STRONG_ACTION_VERBS——P0#7 用户裁决（testing 合法回炉高频词，需 verbs 分布数据裁决）未变，仅在反样本测试中固化「review/审计+实现/开发/构建/生成/编写」拒绝语义；「修复」不在表内属设计内边界（测试锁定）。
- ASCII 项目名/文件名碰撞（SD-6/16 形态、`project-e2e-test-2` 类）为既有已知残余面，本轮未扩（需文件名白名单/路径语义升级，建议后续与父侧 router-gate 一并处理）。
- 引号内引文语境（SD-7/8/9/10/17/18 的模板引文类）未做自动豁免——引号检测可被暗语利用（「帮我「开发」应用」），宁拒勿放；记为残余误拦面，待 B3 真流程实测后按事件分布裁决。

## 3. GWT 后补集成用例（nanju-gwt-runner.test.ts，本会话原文件）

两个真实 process-driver 集成用例（对接 driver worker 完成的结构化 blocked/exit-2 协议，零浏览器、不真实 spawn——预检即阻塞）：

- **Node 运行时缺失**：工程契约（cli-driver + driver.runtime=node）+ `createEngineeringProcessDrivers({})`（无 nodePath/pythonPath）→ 真实 process driver 预检抛「缺少可用运行时：node」→ suite blocked → `runNanjuGwtAcceptance` verdict=**blocked**；prevReport fail(retryCount=1) 原样保留（**retryCount 不 +1**）、errorCount=0；重复 blocked 轮次仍不累计；浏览器零参与（createLocalFileTab 一触即抛）；report.json verdict=blocked 且 engineeringSuite.verdict=blocked 结构化事实落盘。
- **Python 运行时缺失**：runtime=python3 同链路，retryCount=2 / errorCount=1 原样保留，blockedReason 含「python3」。

## 4. 测试证据（本目录）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 红轮（8 个要求行为失败：SD-4/5/1 重放、护栏、引用不豁免真产出、分词 ×2、标题降权） | 8 fail / 147 pass | 本报告 §3 流程记录（先红） |
| 绿轮定向 | `delegate-guard + w18-delegate-intent + gwt-runner` → 298 pass / 0 fail | `task8-tests-green.log` |
| 邻接回归 | router-gate / router / driver-blocked-protocol / process-driver / engineering-suite → 188 pass / 0 fail | `task8-neighbors-green.log` |
| 类型检查 | exit 0 | `task8-typecheck.log` |
| 事件台账 | 46 条原始事件 | `stage-deny-events.jsonl` / `unbound-write-deny-events.jsonl` |

## 5. 自审结论

- ✅ 正常引用（根据 PRD/原型、既有 UX 产出）放行，SD-4/5 类误拦归零（固化测试）。
- ✅ 真跨阶段写（SD-11..15：architecture 委派 coding author）、借审计名义产出（review+强动词）、路径越权（A3 index.html 产出声明）仍拒绝。
- ✅ 标题与任务不同权重：title 不制造拒绝、不能豁免 task 拒绝；task 为权威工作文本。
- ✅ 插空格/换行分词不能改变授权结果（CJK 归一，双向测试）。
- ✅ 引用豁免不可构造绕过：「按开发方案」「直接按开发…」等构造仍拒（出现级判定 + 紧邻约束 + 单字标记不收录）。
- ✅ skip 规则未回退、未加隐式豁免（gwt-runner.ts 本轮未动，Task1 语义保持）。
- ✅ 仅改允许文件；未复跑无关全量；未测不称通过（无真实项目重测——事件级误拦率复测归 B3 真流程）。

## 6. 未覆盖事项（诚实声明）

- 19 stage-deny 中引文语境类（SD-2/7/8/9/10/17/18/19）与 ASCII 文件名碰撞类（SD-6/16）未修复，保持拒绝（不确定/残余误拦面，已逐条标注）；「合法任务误拦为 0」验收针对**固定正反样本集**（已固化并通过），不外推到未修复残余面。
- unbound-write-deny 守卫本体在父文件，27 条事件的分类建议未落地为代码改动。
- 未跑 build/pack/GUI E2E（按权限约束，且本轮改动不涉及运行时打包面）。
