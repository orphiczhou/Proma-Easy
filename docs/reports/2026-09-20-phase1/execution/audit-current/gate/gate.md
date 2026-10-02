# 阶段门禁独立审计报告（gate）· 2026-09-23

> 审计角色：独立只读审计员。**未改代码、未 commit、未部署**。
> 审计对象：共享工作树 `/home/orphic/proma-patches/p1-quick-engineering`
> （分支 `p1-quick-engineering`，HEAD `34f72fbc8114608b998eaf4e1f5e1937f3deeb59`；
> 版本 electron 0.17.132 / shared 0.1.63）。
> 审计时间：2026-09-23 18:21 GMT+8。

## 1. 范围与快照

审计文件 sha256+mtime 快照见同目录 `file-hashes-20260923.md`（审计时刻生成）。核心文件：

| 文件 | mtime (GMT+8) | sha256（前8位） |
| --- | --- | --- |
| nanju-acceptance-baseline.ts | 2026-09-20 15:02:41 | 4cfe9bc2 |
| nanju-acceptance-baseline.test.ts | 2026-09-21 14:31:24 | 6430e5f8 |
| nanju-router.ts | 2026-09-20 15:02:41 | 2827ba6b |
| nanju-router-gate.ts | 2026-09-20 15:02:41 | abf2c08c |
| nanju-router-gate.test.ts | 2026-09-20 14:53:15 | 2a3d8c83 |
| nanju-router-prompt.ts | 2026-09-21 14:31:24 | 3bca46f8 |
| nanju-phase-advance-consumer.ts | 2026-09-20 15:02:41 | 36f9c1b1 |
| nanju-click-to-fix-policy.ts | 2026-09-20 15:02:59 | 7ab34f13 |
| nanju-click-to-fix-policy.test.ts | 2026-09-21 14:40:25 | 73f0edfd |
| nanju-delegate-guard.ts | 2026-09-20 14:55:49 | be6be568 |
| nanju-delegate-guard.test.ts | 2026-09-20 14:56:56 | 58f82b18 |
| nanju-gwt-runner.ts | 2026-09-20 13:48:27 | 62b00d49 |

测试源码副本持久化于 `test-sources/`（17 个 .ts，另含 nanju-user-stories.ts / nanju-advance-recovery.ts 两个门禁邻接依赖）。

**验证方式**：全部 findings 中标注「实机验证」的反例均以 bun 1.3.14 对 `src/main/lib` 源码直接复现（临时脚本位于 /tmp，未落产品目录）；其余为静态证据推演（明确标注）。

## 2. 分级汇总

**1 red / 6 yellow / 4 green（含 1 个 green 子项）**。机器可读版本见 `findings.json`。

| ID | 级别 | 类目 | 摘要 |
| --- | --- | --- | --- |
| F-01 | yellow | US三类覆盖/notApplicable | 6字符凑数理由即可豁免 boundary/exception |
| F-02 | **red** | 冻结基线后需求变更 | 基线文件可被同权限写者重写自证，重冻结无变更授权痕迹 |
| F-03 | yellow | contract id 冒充 steps | 绑定按名字匹配：契约 id / 单字段 scenario 文本即可顶替 |
| F-04 | yellow | testing点选跨阶段写 | mustRetest 仅文案注入，无程序化失效动作 |
| F-05 | yellow | GateCheck 一致性 | route 缺失时 fail-open：零 checks 静默放行 |
| F-05b | green | GateCheck 一致性 | testing 绑定错误的 path 标签失真（轻微） |
| F-06 | green | pending/取消/幂等 | 取消粘性与续接幂等正确；新指纹复活为待裁决边界 |
| F-07 | green | skip/error 洗通过 | 必测语义红线完整（size=0 边界待裁决） |
| F-08 | yellow | 暗语分词（绕过） | 零宽字符/全角括号拆散关键词绕过 deny（实锤） |
| F-09 | yellow | 暗语分词（绕过） | ±20 邻近窗口可拉距绕过（实锤） |
| F-10 | yellow | 门禁误拦 | testing 合法核验任务含裸词 coding 被拒（实锤） |
| F-11 | green | US编号归一 | 归一与覆盖对齐正确（回归钉） |
| F-12 | green | 冻结检测 | 检测本体有效：任何变更被拒（回归钉） |

## 3. Findings 详述

### F-02（red）验收基线可被重写自证 ——「冻结基线后需求变更」的实质绕过

**现状**：基线校验是哈希自证——
> `if (baseline?.version !== 1 || baseline.specHash !== spec.specHash || baseline.prdHash !== spec.prdHash) return '编码前验收基线缺失或已改变；…'`

基线文件 `_acceptance-baseline.json` 与被校验的 `acceptance.json`/`prd.md` 同处项目目录，而项目目录对 L2 委派子会话是写豁免域（router-gate 的 `isDelegationChildSession` 豁免、层三路径约束自述「提示性软约束（系统当前不强制拦截）」）。导出的 `freezeAcceptanceSpecification` 无条件重写基线：
> `/** 仅在已通过原授权门的进入coding事务中调用；读取规格不自动冻结。 */ export function freezeAcceptanceSpecification(...)`

**实机验证**：冻结后把规格弱化（then 改 `'ok'`、exception 转 6 字豁免）→ 门禁拒绝「基线缺失」✓；重写基线后再验 → 恢复 `null`，且 `frozenAt` 被静默刷新，无 prevHash/变更记录。首次冻结与变更重冻结在数据上不可区分；引导语「需求变更需先走回退确认」仅为提示词。

**建议**：重冻结前发现旧基线存在且 hash 不匹配时要求显式回退授权；冻结记录含变更链并落独立审计日志。

### F-01（yellow）notApplicable 豁免强度不足 ——「三类覆盖与 notApplicable 绕过」

豁免门槛仅长度：
> `if (row.kind === 'normal' || typeof row.notApplicable !== 'string' || row.notApplicable.trim().length < 6) throw new Error(`${row.id}豁免需具体理由，普通路径不得豁免`)`

实机验证：boundary/exception 双条目均填 `'理由理由理由'`（6字）→ 校验 `null`。normal 红线有效（「普通路径不得豁免」已由既有测试与本次复核确认），但三类覆盖的 boundary/exception 两翼可被无语义文本批量豁免；且豁免条目在绑定检查被过滤（`!row.notApplicable`），testing 阶段不再要求任何对应场景。建议结构化豁免（分类枚举+相关性复核），或在架构收口确认时单独列出豁免清单。

### F-03（yellow）contract.test id 冒充 steps —— 绑定证据按名字匹配

绑定名池有两处弱证据源：
> `for (const test of contract?.tests ?? []) if (test.layer === 'acceptance') names.push(test.id)`（契约 id 直接入池，不要求该 test 绑定 scenarioFiles 或任何可执行步骤）

> `if (typeof value?.scenario === 'string') names.push(value.scenario)`（steps JSON 只读一个字符串字段）

实机验证三形态：①契约 id=AC-001、零 steps 文件 → `null`；②三个 `{scenario:'占位 AC-00x'}` 空壳 → `null`；③单个场景文本同时提及 AC-001/AC-002/AC-003 → `null`（`\bAC-00x\b` 按名匹配、不看场景归属）。深度防线在 GwtRunner 执行期 schema/覆盖判定，但 testing 推进门（`verifyPhaseOutput` 的 `acceptance.baseline` 分支）在进门处即放行。建议绑定证据要求 AC 编号出现在 `.feature` 场景名或成对 us-XX 命名。

### F-04（yellow）testing 点选跨阶段写 —— 失效声明无程序化兑底

策略面正确（`mustRetest: stage === 'testing' || stage === 'delivered'`、目标 `08_APP/`、不回写 PRD），但消费点（nanju-ipc.ts）只做文案注入：
> `'旧测试报告与交付确认已失效，修复后必须重新测试。'`

未见 `clearProjectDeliveryAck`/challenge 清除或报告 stale 标记。程序化兑底仅剩 GwtRunner 交付门的 `entryFingerprint` 重算比对——用户不发起交付时，旧 pass 报告与 ack 在 UI 维持有效显示。建议 testing/delivered 点选受理同拍置失效事实。

### F-05（yellow）GateCheck fail-open —— route 缺失零 checks 静默放行

> `if (!phase || !phase.outputPath) return null`

getPhaseNode 查不到节点（mode/currentStage 数据异常）时整个文件门静默失效；`evaluatePhaseOutput` 随后把「零 checks + error=null」兜底成 `pass: true` 的合成 check（`checks.push({ id: 'phase.output', pass: !error, … })`）。这与 `validateAdvanceTarget` 的防御性放行同源，但那是目标校验（非承重）；本函数是承重文件门，数据异常应显式化而非伪装通过。附带一致性缺陷（F-05b, green）：testing 绑定错误的 GateCheck.path 仍标 `'03_ARCHITECTURE/acceptance.json'`，实际域在 `06_TESTS/steps`。

### F-06（green）旧 schema pending 与取消/幂等续接

核验通过的红线：
> `if (!pending?.eventKey || pending.executionState === 'cancelled' || pending.consumedEventKey === pending.eventKey) return false`

- 旧 schema pending（无 eventKey）→ claim=false（fail-closed，不自动续接）✓
- claim 领取后 `consumedEventKey` 去重，同事件不重复启动 ✓
- 取消粘性：`executionState: previous?.eventKey === eventKey && previous?.executionState === 'cancelled' ? 'cancelled' : 'blocked'`——取消后同事件再拒不复活 ✓
- 阶段前进后 `buildPendingAdvanceRecoveryPrompt` 返回 null ✓

待裁决边界：产物指纹变化产生新 eventKey 时，被取消的 pending 以 blocked 复活并可再次自动续接（新失败=新事件设计）；建议复活时向用户提示「此前的取消针对旧版本产物」。

### F-07（green）skip/error/blocked 不能洗通过 —— 必测语义红线完整

> `const verdict = failed === 0 && skipped === 0 && uncoveredUs.length === 0 && passed > 0 ? 'pass' : 'fail'`

实机验证：任一 skip → 整体 fail（`skipped:1, verdict:'fail'`）；skip 场景不计覆盖（`coveredUs` 排除 skip）；空结果集 fail；交付 ack 双事实（`report?.verdict === 'pass' && hasGwtDeliverySchemaFields(report)`）对旧 schema、空 runId、null 均 false。边界确认项：`entryFingerprint.size = 0` 仍通过 schema（`typeof size === 'number'`），建议增加 `size > 0`。

### F-08 / F-09 / F-10（yellow）门禁误拦与暗语分词

Task 8（2026-09-20）已完成「插空格/换行拆词不改判」硬化（`compactCjkWhitespace`），但归一集合只含空白：
> `text.replace(/([\u3400-\u9fff])[ \t\u00a0\u3000\r\n]+(?=[\u3400-\u9fff])/g, '$1')`

**F-08（实机验证）**：`task='开\u200b发一个工具'` → `{allowed:true, matchKind:'unmatched'}`（零宽字符拆散「开发」，强动词与 coding ROLE 词双 miss）；`'开(发)一个工具'` 同样放行。建议剥除 Unicode Cf/Cc 不可见字符后再匹配。

**F-09（实机验证）**：邻近窗口 `OUTPUT_VERB_PROXIMITY = 20` 可用填充文本拉距：requirements 阶段「根据 PRD 梳理需求，请在充分理解上下文与用户预期的前提下，完成高质量的最终代码产物」→ `{allowed:true, matchKind:'stage', matchedKeyword:'需求'}`——本阶段词掩护下游产出意图。对照样例「根据 PRD 生成应用代码」正确 deny。属设计容忍度的可构造绕过，建议纳入埋点观察或句级共现判定。

**F-10（实机验证）**：testing 阶段合法核验任务「核验 coding 阶段产出的 driver 与被测产物一致性，并记录审查结论」→ `{allowed:false, violatedStage:'coding'}`——与 testing 节点自身约束语风（「读取coding已产出的driver」）同构，属结构性误拦面；W19-C 清理了「需求/PRD」侧但未覆盖 testing↔coding 核验语境。「对」不在引用标记表（REFERENCE_MARKERS）内。

### F-11 / F-12（green）回归钉

- **US 编号归一**（F-11）：`row.us = \`US-${String(Number(row.us.slice(3))).padStart(2, '0')}\`` 与 `parseUserStories` 的 `padStart(2,'0')` 归一一致；无连字符形态 fail-closed。
- **冻结检测本体**（F-12）：PRD/规格任何变更被拒；testing 绑定先报基线拒因（变更优先于绑定噪声）；哈希按原文，等价格式化差异也判变更——保守方向正确（设计确认，非缺陷）。

## 4. 反例测试索引（negative/）

运行方式与断言语义标记见 `negative/README.md`。文件未合入产品测试套件（审计只读）；`AUDIT-RED（现状）` 用例为缺陷证据固化，`AUDIT-EXPECT` 为期望行为记录。

| 文件 | 覆盖 findings |
| --- | --- |
| neg-01-us-coverage-not-applicable.test.ts | F-01, F-11, F-12 |
| neg-02-frozen-baseline-change.test.ts | F-02, F-12 |
| neg-03-contract-id-steps.test.ts | F-03 |
| neg-04-click-to-fix-cross-stage.test.ts | F-04 |
| neg-05-gatecheck-consistency.test.ts | F-05, F-05b |
| neg-06-pending-cancel-idempotent.test.ts | F-06 |
| neg-07-skip-error-wash.test.ts | F-07 |
| neg-08-delegate-guard-adversarial.test.ts | F-08, F-09, F-10 |

> 夹具口径说明：neg-05/neg-06 依赖 nanju-project 注册表 fixture（`_nanju-projects.json` schema 以运行环境为准），作为断言意图规范先行固化；其余 6 个文件为纯函数/临时目录夹具，实机复现所依据的行为已直接由源码验证。

## 5. 审计边界

- 本报告与 `findings.json`、`negative/*.test.ts`、`test-sources/` 为审计交付物，写入本审计目录不构成对产品代码的修改；产品代码与既有测试零改动。
- 实机验证脚本（/tmp）仅 import 只读函数并构造 tmpdir 夹具，未触发任何产品写路径；运行时输出中的模型多样性告警为源码模块加载期的既有启动告警，与本次审计无关。
- nanju-router-prompt.ts / nanju-router.test.ts 等文件的快照已持久化，本轮未发现需单列 findings 的问题（router-prompt 家族多样性断言、testing 收口果断性等由既有测试覆盖）。
- 版本基线：electron 0.17.132 / shared 0.1.63（2026-09-23）。后续会话复核时应先比对 `file-hashes-20260923.md` 与当前 sha256。
