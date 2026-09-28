# 核实论证与修改方案 · E2E 桌面便签（2026-09-28 23:00–23:40 GMT+8）

> 会话：a405ddeb（本会话）｜复核范围：P0' 根因定案（4b33a135）+ 本轮新发现 + 修改方案
> 结论先行：**P0' 定案成立**（证据链五重闭合）；**新发现问题 A**（GWT 交付门禁拦截不续接，当前停摆的直接原因）；修改方案 4 项（本文 §三）。

## 一、P0' 核实结论：channelId 缺失根因定案成立

### 1.1 证据链（五重独立闭合）

| # | 证据 | 内容 | 结论 |
|---|---|---|---|
| 1 | 遥测时序 | 拒因 12:41:18.993Z → giveup 12:41:29Z，间隔 **11 秒** | 走 `!meta?.channelId` **立即放弃**分支；非 60s 快速重试耗尽（应 +60s）、非 600s 空闲巡检耗尽（应 +600s） |
| 2 | dev 日志 | `续接跳过（会话元数据缺失 channelId）：sessionId=ff681335`（p1fix2.log:1121） | 直接日志证据，与代码分支一一对应 |
| 3 | 同日志 | `result 到达: subtype=success`（拦截前） | run 正常结束、isActive 已释放——**推翻上轮「isActive 不释放」初判** |
| 4 | 会话索引 | ff681335 的 keys 无 channelId/modelId；**全部 25 个无 channelId 会话均为南大工程调度员会话**（番茄钟E2E/倒计时器/输入法/桌面便签…） | 系统性缺口，非个例 |
| 5 | 对照组 | 脚本/API 创建的工程会话（e2e-验收-倒计时小组件、e2e-r3-番茄钟…）**有** channelId | 缺口精确锁定 **TabContent UI 创建链**（`TabContent.tsx:104`：`createAgentSession(name, undefined, ws.id)`） |

### 1.2 机制论证（为何 100% 失效）

- 护栏续接唯一执行函数 `runNanjuGuardContinuation` → `runRegisteredHeadlessAgent({channelId: meta.channelId, ...})`，`AgentSendInput.channelId` 为必填 string；meta 缺失即提前 return（onGiveUp）。
- 三个消费方全部经此函数：① `nanju-phase-advance-consumer:132`（advance 拒因续接，F5①）② `agent-orchestrator:1379`（delegation watcher 护栏）③ 内部重试链。→ **单点缺口，三路全断**。
- 对照：阶段推进自动续接（orchestrator:3395）成功，因其复用**本次 run 闭包变量** channelId（来自 UI 消息参数），不依赖 meta。这解释了「推进链正常、拒因续接链断」的分裂现象。

### 1.3 修复 4b33a135 自查（通过）

- 回填条件 `!session.channelId && input.channelId`：不覆盖已有渠道、防空串（truthy）；modelId 条件展开不写 undefined ✓
- 吞错不阻塞发送 ✓；回填先于 runAgent（同 handler 内后续可见）✓
- 入口矩阵核查：SEND_MESSAGE（真 UI 唯一入口，修复点）✓；队列消息不经过该 handler 但排队前提是会话忙碌、必有更早的直接消息 → 盲区极小；automation（scheduler:168 传 channelId）✓；协作子会话（collaboration-tools:1079 传 effectiveChannelId）✓；角色会话（nanju-orchestrator createRoleSession 传 config.channel）✓
- 已知设计边界（记录不阻塞）：用户中途换渠道发消息，meta 保持首渠道 → 续接仍用旧渠道。若需「跟随最新使用渠道」可后续调整。
- 验证：9 项源码断言测试 + typecheck exit 0 ✓

## 二、新发现问题 A：GWT 交付门禁拦截缺续接（当前停摆直接原因）

### 2.1 事实链（2026-09-28 21:53 起）

1. 21:52 testing 委派（测试工程师 d5ac4988）完成，产出 `06_TESTS/test-report.md` + 10 evidence。
2. 21:53 调度员输出 `<!-- PHASE_ADVANCE: delivered -->`；run 正常结束。
3. 消费走 `isDeliverFromTesting` 分支 → `checkGwtDeliveryGate` → **拦截**：`测试尚未执行（06_TESTS/report.json 不存在）。请先声明 <!-- PHASE_ADVANCE: testing --> 触发自动验收测试…`（p1fix2.log:1380-1382）。
4. 拦截处理仅 `injectAssistantMessage`（appendSDKMessages 写 JSONL + eventBus 推 UI）——**不启动 run**（核实：agent-orchestrator `injectNanjuAssistantMessage` 实现）。
5. 调度员 run 已结束 → 拦截指引（含关键行动项）无 Agent 消费 → **停摆至今**（subStage=TEST，correction 无）。

### 2.2 定性

- 与 P0' 同类：**「拦截有信息、无驱动」**。F5①（2026-09-26 修复）只覆盖了 advance 拒因路径（claimAdvanceCorrectionContinuation + sendContinuation）；GWT 交付拦截路径（consumer isDeliverFromTesting gateError 分支）**没有对应续接机制**。
- 注：即使有续接，未部署 P0' 修复前也会撞 channelId 缺失（11 秒放弃）。**两者叠加**才是完整根因图景。

### 2.3 GWT 对 desktop-app 的适配核实（恢复路径可行性）

- 桌面便签契约 tests：unit/integration = `cli-driver`，acceptance×2 = `native-driver`（非 browser-file）→ `prepareEngineeringBrowserRun` 必 blocked → `useEngineeringDrivers=true` → 走工程 suite 分支。
- 宿主 `createEngineeringProcessDrivers` 已注册 **cli/api/native/mobile 四种**驱动（agent-orchestrator:865）→ `runEngineeringSuite` 逐项真实执行（preflight + runRegisteredEngineeringTest）→ 产出 report.json。
- 结论：**恢复路径可行**——调度员声明 `PHASE_ADVANCE: testing`（self-advance）→ GWT 跑工程 suite → report.json → 全 pass 后再声明 delivered。

## 三、修改方案

### 方案 1（P0''·建议本轮实施）：GWT 交付拦截后追加 systemInitiated 续接

- **位置**：`nanju-phase-advance-consumer.ts` isDeliverFromTesting 的 gateError 分支（injectAssistantMessage 之后）。
- **改法**：`hooks.sendContinuation(sessionId, '交付被拦截：<gateError><authStateNote>；请按上述指引处理后重新声明推进。')`。不消费 claim（此为指引非拒因，无需防重放）；复用 runNanjuGuardContinuation 的 busy 重试/空闲巡检/epoch 机制。
- **测试**：源码断言——拦截分支在 injectAssistantMessage 之后存在 sendContinuation 调用。
- **依赖**：需与 P0'（4b33a135）一同部署才闭环（否则续接仍撞 channelId 缺口）。

### 方案 2（P1·建议下轮实施，含权衡需用户确认）：stage-deny 按 phase.role 豁免

- **现状**：`checkDelegationAgainstStage` 判定序 ②「他阶段角色词扫描**无条件**先于本阶段词」（W18 v0.17.81 重排）→ 正常引用他阶段词（「按架构测试规范」「托盘菜单视觉」）必拦。E2E 实测 **14/14 误拦**（本轮 +2，均带 `phase.role: tester` 标记）。
- **方案 2a（观察员建议方向）**：workText 显式含 `phase.role: <role>` 且 role 属于 currentStage 角色集 → ② 降级为「记录观测事件（新遥测 delegate.guard.role-exempt）+ 放行」。
- **方案 2b（保守）**：不做标记豁免；② 命中时若同文本存在本阶段角色词共现（coPresentStageKeyword 非空）→ 放行但记录。
- **权衡**：2a 简单直接但 L1 可伪造标记绕过（现状本无防伪装能力，2a 不更差）；2b 无伪造面但「共现放行」会重开 W18 之前关闭的「引用词掩护越权」敞口（见判定序注释）。**倾向 2a + 观测事件**，需用户拍板。
- **附带**：SD 词表复审（「视觉」「架构」作为角色词过宽——「视觉」更像 prototype 产出词却进了角色词表）。

### 方案 3（P2·建议本轮顺手）：DELIVERY 门禁正则放宽

- **现状**：`/^##\s+测试状态\s*$/m` 要求标题独占一行；`## 测试状态（2026-09-26 实测）` 被判「缺少章节」（本次卡死 2 天的直接诱因之一，且拒因文案误导）。
- **改法**：`/^##\s+测试状态(?![^\s（(])/m`（负向前瞻：允许行尾/空白/全半角括号后缀；「测试状态与xxx」等新章节名仍拦）。「构建与运行」对称放宽。
- **测试**：正则单测覆盖通过/后缀/变体拒绝三种形态。

### 方案 4：部署与验证（子会话执行中）

- 磁盘清理（flash 子会话 c002ca12）目标 ≥2.5G；部署准备（flash 子会话 004eb66a）产出 deploy-plan-20260928.md。
- **部署窗口判断**：工程当前停摆中（21:53 起，无活跃 run）→ **重启实际损失为零**，窗口即现在。
- 部署后验证清单：
  1. CDP 9224 可用、主窗口正常；
  2. 向调度员会话发一条 UI 消息 → `agent-sessions.json` 中 ff681335 的 meta 出现 channelId/modelId（P0' 回填生效）；
  3. 消息内容 = GWT 拦截恢复指引 → 调度员声明 testing → GWT suite 启动（cli+native 驱动真实执行）→ report.json 产出（方案 1 生效路径）；
  4. 遥测出现 `continuation.channel-missing` = 0（无存量会话再撞）；
  5. stage-deny 若再触发，观察 dispatch 行为（方案 2 未部署前仍会误拦，预期内）。

## 四、遗留边界（记录，不阻塞）

1. 空闲巡检 10 分钟窗口 vs delegation 硬超时 35 分钟：run 活跃 >10min 时巡检耗尽（p1fix2.log:517/701 两次）。P0' 修复后概率大降（多数拒因场景 run 已结束）；如仍出现，再议「blocked 态 pendingAdvanceCorrection 定时巡检」兜底。
2. DELIVERY 拒因文案「缺少」vs「格式不合规」不精确（方案 3 后基本消除）。
3. 用户中途换渠道，meta 不跟随（1.3 设计边界）。

## 五、执行状态

- 方案 1 + 方案 3：本文档落档后实施（本轮）。
- 方案 2：待用户确认 2a/2b 后实施（下轮）。
- 方案 4：子会话运行中；部署等磁盘与 deploy-plan 就绪 + 用户点头执行。

---

## 六、部署与 GWT 六轮实战记录（2026-09-29 01:20–02:35 GMT+8）

### 部署
- 提交 e97bb2b6（2a）后 pack（删 out 腾 706M；electron zip 重下 12 分钟）；afterPack 门禁一次通过（12 required）。
- asar 备份 `app.asar.bak-v0.17.132-20260929-0141` → 替换 + 重启（PID 3940018）。CDP 5s 就绪。

### 三修复验证
- **P0'（channelId 回填）✓**：CDP 发首条 UI 消息后，ff681335 meta 立即出现 channelId/modelId。
- **P0''（GWT 交付拦截续接）✓（间接）**：调度员对恢复消息响应、声明 testing；本轮拦截消费链通畅（拦截注入均在会话内可见）。
- **2a（phase.role 豁免）**：部署后未再触发 stage-deny（调度员本轮委派未再被拦；role-exempt 遥测待后续样本观察）。
- 差错记录：CDP 会话切换正则过时（4/4→5/5）导致两次消息误发 AC 审计子会话（无害，已修正正则）。

### GWT 六轮迭代（驱动协议修复实战——每轮均由 GWT 严格校验抓出真问题）
| 轮 | 结果 | 根因 → 修复 |
|---|---|---|
| r1 | error | 契约 unit-core 绑非协议驱动（tests/test_core.py 输出 unittest 文本）→ 新增协议包装驱动 drv_unit_core.py |
| r2 | blocked | 新驱动未声明进契约 artifacts → 补 artifacts |
| r3 | error | 驱动协议字段：evidence 须非空数组、exitCode 须 number、passed 按 expected===actual 等值 → 修 drv_unit_core |
| r4 | error | integration 契约 target 误填驱动自身路径 + 老驱动缺 exitCode/evidence 空/描述性 expected → 修契约 target + 三老驱动补 exitCode |
| r5 | error | core 驱动 US-01 越界（acceptance 层 storyId 不得为 null 且须在 covers）+ 多处描述性 expected → 对齐等值 |
| r6 | **29/29 checks 全过** | suite 终态 blocked：真实证据门禁（requiresReal=true 的 core/tray 两项需宿主观察器实测或同会话真人见证，项目驱动不能自证——**设计内**） |

### 新发现（待产品侧跟进）
1. **契约/驱动协议编写指引缺失**（P1）：架构师写契约、测试工程师写驱动均未得到协议约束反馈，六轮才收敛。建议：契约 schema 校验前置（编辑时）+ driver-skeleton 模板对齐 interpret 全字段（exitCode/evidence 数组/等值语义）。
2. **真实证据门禁交互面**（观察）：requiresReal 项的「真人见证」收据入口在当前流程中未呈现给用户（无可见的见证询问横幅）——门禁正确拦截但用户不知道怎么解除。建议补可见指引。
3. CDP 驱动 UI 的会话切换宜按 sessionId 定位（当前按标题正则，脆弱）。

### 当前状态
- 工程 subStage=TEST；report.json verdict=blocked（真实证据门禁）；29/29 驱动检查通过。
- 交付（delivered）需用户以「同会话真人见证」方式解除 requiresReal 门禁——这是 E2E 剩余的自然停点，需用户亲自参与。
