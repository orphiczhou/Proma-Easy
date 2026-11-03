# 门禁审计修复复核（recheck）· 2026-09-23 18:55 GMT+8

> 复核角色：独立只读审计员（延续 2026-09-23 18:21 审计）。**未改代码、未 commit、未部署**。
> 对象：父会话声称已修复 F-01/F-02/F-03/F-04/F-05/F-08。全部结论基于对当前工作树的实机复现（bun 1.3.14，/tmp 临时脚本）与静态 diff（对照审计快照 `test-sources/`）。
> HEAD 未变：`34f72fbc`（修复以工作树未提交改动形态存在）。

## 1. 自上次审计的实际改动面

对照快照 sha256，仅 3 个门禁文件被修改（mtime 2026-09-23 18:39–18:40）：

| 文件 | 快照 sha256(前8) | 当前 sha256(前8) | 变更 |
| --- | --- | --- | --- |
| nanju-acceptance-baseline.ts | 4cfe9bc2 | 40460eb8 | F-01/F-02/F-03 修复 |
| nanju-router-gate.ts | abf2c08c | 48679a9a | F-05 修复 |
| nanju-delegate-guard.ts | be6be568 | b0bbe80e | F-08 修复（单行正则） |

nanju-click-to-fix-policy.ts / nanju-phase-advance-consumer.ts / nanju-gwt-runner.ts 未变（哈希与快照一致）。

## 2. 逐项复核结论

### F-01 notApplicable 豁免 —— ✅ 已修复（加强），残余降级

**修复证据**（acceptance-baseline.ts）：
> `if (row.kind === 'normal' || typeof row.notApplicable !== 'string' || row.notApplicable.trim().length < 20 || !/[，。；;,.]/.test(row.notApplicable)) throw new Error(\`${row.id}豁免需具体理由，普通路径不得豁免\`)`

实机验证：6 字凑数 `'理由理由理由'` → 拒绝（`AC-002豁免需具体理由`）✓。
**残余（R-01，低）**：形式检查而非语义判定——20 字符 + 含任一标点的凑数文本仍通过（实机验证：`'理由…×20，凑数'` → `null`）。边界/异常豁免的语义判定仍缺（建议：豁免清单在架构收口确认时单独列出供用户/AC 审视）。

### F-02 冻结基线 —— ⚠️ 部分修复：freeze 函数内已加授权门，validate 自证面仍开放

**已修复部分（实机验证全部通过）**：
> `if (previous && (previous.specHash !== spec.specHash || previous.prdHash !== spec.prdHash) && !authorizationId) throw new Error('验收规格已改变；需求变更必须经过显式回退/用户确认授权后才能重冻结。')`

- 变更检测 ✓（改规格后 validate 拒绝「基线缺失」）
- 无授权重冻结 THROW ✓（`freezeAcceptanceSpecification(dir)` 单参调用抛错）
- 授权重冻结写入变更链 ✓：`previous:{specHash, prdHash, changedAt, authorizationId:"user-confirm-001"}` 落盘可查
- 授权后重冻结 validate 恢复 null ✓

**残余一（R-02a，原 red 主面未闭合）**：校验仍是自证式——基线守卫只存在于 freeze 函数内，`validateAcceptanceSpecification` 对基线文件本身无任何防篡改。实机验证：绕过 freeze、直接手写 `_acceptance-baseline.json`（specHash/prdHash 与改后规格匹配）→ validate 返回 `null`。有项目目录写权限的 L2（写豁免域不变）仍可「改规格+直写基线」洗过。建议：基线写入经受控通道（如仅主进程可写的路径/注册表），或 validate 交叉校验 baseline.previous 链与独立审计日志。
**残余二（R-02b，新增误拦/断头路，yellow）**：消费侧未接线授权——`nanju-phase-advance-consumer.ts:1065` 仍为单参调用 `freezeAcceptanceSpecification(getNanjuProjectDir(...))`，无任何调用方传 `authorizationId`。后果：合法「回退确认 → 变更规格 → 重进 coding」路径会命中 THROW，被消费侧 catch 为「无法冻结编码前验收规格：…」并拦截推进，且无获得授权的程序化入口。fail-closed 方向正确但合法通道断头，需接线（如把回退/用户确认事件 ID 作为 authorizationId 传入）。

### F-03 contract id 冒充 steps —— ⚠️ 部分修复：契约 id 已除名，按名匹配面反而更宽

**已修复部分**：契约不再构成绑定证据：
> `// 工程契约是设计登记，不构成真实步骤绑定；只接受可读取的 steps/feature 场景证据。`

实机验证：契约 id=AC-001 + 零 steps/feature → 正确报 `可执行测试缺少冻结验收编号：AC-001` ✓。
**残余（R-03，yellow）**：绑定仍是「AC 编号出现在 06_TESTS/features 任意文件全文」的按名匹配，且新扫描把目录下**任意 `.feature`/`.json` 文件全文**入池（含 `.steps.json` 自身内容）。实机验证：
- 双字段空壳 `{feature:'占位 AC-001', scenario:'占位场景 AC-001'}` → `null`（单字段空壳被堵 ✓，但双字段占位即可过）
- 一个无关 `杂项.feature` 文本提及 AC-001/AC-002/AC-003 → 三项绑定全部满足（`null`）

未收敛到审计建议的「AC 编号出现在场景名/成对 us-XX 命名 + feature/scenario 语义一致」。

### F-04 testing 点选跨阶段写 —— ✅ 程序化失效已存在（更正审计记录），残余缩小

**更正**：清 ack/challenge/auth 的程序化动作在 `nanju-ipc.ts:602-608` 已存在（写入时间 09-21，早于原审计；原审计读窗 500-590 行未覆盖该段，F-04 证据不完整——更正原报告的「无程序化调用」表述）：
> `clearProjectDeliveryAck(input.workspaceSlug, project.projectId)` + `clearProjectDeliveryChallenge(...)` + `clearNanjuAdvanceAuthState(...)`

`clearNanjuAdvanceAuthState`（nanju-project.ts:1317）同批清 confirmAuthorization/activeConfirmAsk/systemAdvance/installAsk/防环计数。
**残余（R-04，低）**：`06_TESTS/report.json` 本身未标记 stale（UI 仍可显示旧 pass 报告）；点选清掉 `activeConfirmAsk` 属偏保守副作用（10min TTL 内的收口问句登记一并失效，用户确认词需重新弹问）。

### F-05 GateCheck fail-open —— ✅ 已修复（含 F-05b 路径标签）

实机验证（mock workspace 夹具）：
> `{"id":"route.missing","path":"planning","expected":"有效阶段路由与产出路径","actual":"阶段路由节点或产出路径缺失：planning","pass":false,"nextAction":"修正 planning 后重新校验；不得跳过门禁。"}`

- `if (!phase || !phase.outputPath) return reject('route.missing', …)` —— fail-closed 且 checks 显式 ✓
- F-05b 同批修复：testing 绑定错误的 path 标签改为 `phaseId === 'testing' ? '06_TESTS/features' : '03_ARCHITECTURE/acceptance.json'` ✓

### F-08 不可见字符归一 —— ⚠️ 部分修复：零宽字符已封，非空白标点夹层仍开放

**已修复**（delegate-guard.ts 单行）：
> `const CJK_GAP_WS_RE = /([\u3400-\u9fff])[ \t\u00a0\u3000\r\n\u200b-\u200f\u2060\ufeff]+(?=[\u3400-\u9fff])/g`

实机验证：`'开\u200b发一个工具'` → **deny**（`violatedKeyword:'开发', violatedStage:'coding'`）✓；`'开\u2060发…'` 同拒 ✓。
**残余（R-08，低）**：非空白非不可见字符夹层仍绕过——实机验证 `'开(发)一个工具'` → `{allowed:true, matchKind:'unmatched'}`（与原 F-08 第二形态一致，未处理）。

## 3. 仍开放的残余（汇总）

| 残余 ID | 来源 | 级别 | 状态（实机复验 18:55） |
| --- | --- | --- | --- |
| R-02a | F-02（原 red） | **red** | 直接重写基线文件仍自证通过（`validateAcceptanceSpecification` 对手写匹配基线返回 null）——原 red 主面未闭合 |
| R-02b | F-02 修复引入 | yellow | 消费侧单参调用无 authorizationId 入口，合法回退后重冻结被拦成断头路 |
| R-03 | F-03 | yellow | 按名匹配仍在：双字段占位 steps / 无关 feature 全文提及 AC 编号均可顶替绑定（features 扫描含 .json 全文，面更宽） |
| R-01 | F-01 | low/yellow | 20字+标点凑数豁免仍可过（形式检查非语义判定） |
| R-04 | F-04 | low | report.json 未标 stale；activeConfirmAsk 被点选一并清除的保守副作用 |
| R-08 | F-08 | low | `'开(发)'` 型非空白标点夹层仍绕过（实机验证 allowed:true） |
| **F-09** | 原审计 | yellow | **未修复**：邻近窗口拉距仍放行——`'根据 PRD 梳理需求…（>20字）…代码产物'` → `{allowed:true, matchKind:'stage', matchedKeyword:'需求'}`（实机复验与审计时一致） |
| **F-10** | 原审计 | yellow | **未修复**：testing 合法核验任务含裸词 `coding` 仍被拒 `{allowed:false, violatedStage:'coding'}`（实机复验与审计时一致） |

## 4. 修复判定矩阵

| Finding | 原级 | 复核判定 | 说明 |
| --- | --- | --- | --- |
| F-01 | yellow | fixed-with-residual（R-01 low） | 长度 6→20+标点；语义判定仍缺 |
| F-02 | **red** | partial-fix | 授权门+变更链 ✓；validate 自证面（red 主面）与消费侧授权接线（新误拦）开放 |
| F-03 | yellow | fixed-with-residual（R-03 yellow） | 契约 id 除名 ✓；按名匹配未收敛且 features 全文扫描面更宽 |
| F-04 | yellow | fixed（更正原审计证据） | 清失效动作已存在；report stale 残余缩小为 low |
| F-05 | yellow | fixed | route.missing fail-closed 显式化（实机验证）+ path 标签修复 |
| F-08 | yellow | fixed-with-residual（R-08 low） | 零宽/Cf 字符归一 ✓；括号夹层开放 |
| F-09 | yellow | open（未动） | delegate-guard 本轮仅改 1 行正则，邻近窗口未变 |
| F-10 | yellow | open（未动） | 同上 |

机器可读 delta 见 `findings-delta.json`。反例测试（negative/neg-0*.test.ts）未改动；R-02a/R-02b/R-03/R-08 的实机复现脚本要点已摘录于本文各节（复验时间 2026-09-23 18:40–18:55，HEAD 34f72fbc + 工作树未提交修复）。
