# macp2 树形任务独立验收评估报告

> **评估对象**:macp2 树(`tree_id=macp2`),根指挥官 session=`03cce210-11dd-471e-8761-9ce147080fbe`(GLM-5.2 / ZLM-CodingPlan / pro 实例)
> **执行时间**:2026-07-25 12:30 → 13:39 GMT+8(约 70 分钟)
> **任务目标**:推进 multi-agent-collab-platform 实现 + **核心考核:多层指挥官主动性(P0-1 W_STAR_DEGRADATION 协议,不重蹈上次 macp 星形退化)**
> **评估方**:Pro 实例独立观察员(session=`cbaca811`),用 **2 层观察树 `oeval-macp2`**(root 观察 → 4 个评估 worker)执行,自身亦遵循 P0-1 不越级
> **评估方法**:4 个 ZLM/GLM-5.2 评估 worker 各独立查证一维度(树结构 / 多层主动性 / 项目推进 / P1 使用)+ 观察员 root 一手数据(tree_dump / list_messages / 文件核验)交叉,**不轻信根指挥官自述**
> **报告日期**:2026-07-25

---

## 〇、执行摘要(Executive Summary)

| 维度 | 初版(4×GLM-5.2) | 对抗修正后(+W5 DeepSeek + W6 MiniMax) |
|------|------------------|------------------------------------------|
| 1. 树结构 | **PASS** | **PASS**(12 leaf、真 4 层、0 issues,无争议) |
| 2. 多层指挥官主动性(**核心**) | PASS | **形式达标 / 实质部分达标**(0 越级铁证;但门禁全回流 root + L3→L2 链路断裂 + commander 仅执行委派) |
| 3. 项目推进 | 条件 PASS(C1 58-65) | **条件 PASS(保守,C1 47/100)**;coder/judge=不可运行空壳;sandbox=降级实现 |
| 4. P1-1/P1-2 使用 | 条件 PASS | 条件 PASS(progress 37 / comm 32 / drift 14 vs macp 全 0;~10% comm 漏记) |

### 总裁定(Verdict,经多模型对抗修正):**条件 PASS(保守)——核心仅形式达标**

**核心考核(多层主动性)**:**形式达标、实质部分达标**。结构上 root 全程只 leaf_add 3 个 L2 commander、从未越级建 worker(added_by 链铁证),相对 macp 星形退化是**显著改善**;但 DeepSeek 对抗揭示实质自主性受限——audit 门禁全回流 root、**L3→L2 链路断裂**(A1 5 次寻父失败被迫越级)、commander 仅"执行委派"非"权威委派"。故"完全自主履职"须打折扣。

**项目深度下调**(MiniMax 代码现实派):C1 从初版 58-65 **下调到 47/100**;coder/judge 为"**不可运行空壳**"(`runHardChecks return []`、7 项硬约束全无、`withSoftTimeout` 未实现);sandbox 为"**降级实现**"(架构 §11 自承非真沙箱);20 IPC = 19 空壳 + 1 半空壳。真实深度解决 P0 下调为 **5-6 个**。

**新增维度**:macp2 全 GLM-5.2 单模型,相对 macp 三模型交叉是**认知多样性退化**;初版"GLM 评 GLM"递归同质化,靠补派 DeepSeek + MiniMax 才暴露乐观偏差——**多模型对抗复核本身即证明必要**。

**结论**:macp2 树形任务**核心协议形式达标、条件 PASS(保守)**,不宜宣传为"多层主动性完全成功"。下轮重点:修 L3→L2 链路 + 放开禁 fork auditor(让 commander 真自主)、coder/judge 接真实 LLM(1500+ 行)、引入多模型交叉 + commander peer audit(详见 §5、§六)。

---

## 一、macp2 树结构

### 1.1 leaf 清单(独立核验:12 个,非自述的 11 个)

| leaf_id | 层 | parent | role | added_by | status |
|---------|----|--------|------|----------|--------|
| macp2-root | L1 | — | root | — | done |
| macp2-A-commander | L2 | root | commander | `03cce210`(root) | done |
| macp2-B-commander | L2 | root | commander | `03cce210`(root) | done |
| macp2-C-commander | L2 | root | commander | `03cce210`(root) | done |
| macp2-A1-commander | L3 | A | commander | `c81694f0`(A) | done |
| macp2-B1-commander | L3 | B | commander | `701e701a`(B) | done |
| macp2-C1-commander | L3 | C | commander | `6065eba2`(C) | done |
| macp2-A1a-worker | L4 | A1 | worker | `1a12a0c7`(A1) | done |
| macp2-A1b-worker | L4 | A1 | worker | `1a12a0c7`(A1) | done |
| macp2-B1a-worker | L4 | B1 | worker | `ca77fee4`(B1) | done |
| macp2-B1b-worker | L4 | B1 | worker | `ca77fee4`(B1) | done |
| macp2-C1a-worker | L4 | C1 | worker | `3d2402c3`(C1) | done |

**数据源**:`tree_tree_dump(macp2)` 经 node 全量解析(113 KB / 2598 行);`tree_validate` → `ok:true, issues:[]`。

### 1.2 层级图(非对称扇出 1-3-3-5)

```text
macp2-root (root, L1)                    [self]
├─ macp2-A-commander (commander, L2)     [added_by root]
│  └─ macp2-A1-commander (commander, L3) [added_by A]
│     ├─ macp2-A1a-worker (worker, L4)   [added_by A1]
│     └─ macp2-A1b-worker (worker, L4)   [added_by A1]
├─ macp2-B-commander (commander, L2)     [added_by root]
│  └─ macp2-B1-commander (commander, L3) [added_by B]
│     ├─ macp2-B1a-worker (worker, L4)   [added_by B1]
│     └─ macp2-B1b-worker (worker, L4)   [added_by B1]
└─ macp2-C-commander (commander, L2)     [added_by root]
   └─ macp2-C1-commander (commander, L3) [added_by C]
      └─ macp2-C1a-worker (worker, L4)   [added_by C1]
```

### 1.3 结构核验结论

- **层数**:最大深度 3(root 计第 1 层则共 4 层)✓ 满足"3+ 层"要求
- **status 分布**:`{done:12}`——全部 done,无 active/archived/pruned
- **结构异常**:0 孤儿 / 0 环 / 0 缺失父节点 / 0 role 错配
- **扇出不对称**:A/B 各 2 worker、C 仅 1(非缺陷,C 子树任务粒度更大;但建议文档化防未来误读)
- ⚠️ **自述 leaf 计数错误**:根指挥官 `macp2-root-summary.md` §二/§七称"共 11 leaf",**实际 12**(疑漏算 root 自身或漏数 C1a)。建议修订自述,避免后续审计误判。

---

## 二、多层指挥官主动性评估(**核心考核**)

### 2.1 P0-1 红线:root 越级 leaf_add worker = **0 次**(PASS)

逐 leaf 复核 `added_by` 字段(root session = `03cce210`):

| 层 | leaf | added_by 归属 | 判定 |
|----|------|--------------|------|
| L2 ×3 | A/B/C-commander | 全 `03cce210`(root) | ✓ root 派 L2(合规) |
| L3 ×3 | A1/B1/C1 | 各自 L2(c81694f0/701e701a/6065eba2) | ✓ **L2 自主派** |
| L4 ×5 | A1a/A1b | `1a12a0c7`(A1) | ✓ **L3 自主派** |
| L4 ×5 | B1a/B1b | `ca77fee4`(B1) | ✓ **L3 自主派** |
| L4 ×5 | C1a | `3d2402c3`(C1) | ✓ **L3 自主派** |

**`worker.added_by == root` 的 leaf 数 = 0**。root 全程仅 leaf_add 3 个 L2 commander,**从未越级建 worker**——P0-1 W_STAR_DEGRADATION 红线**结构层面零违规**。

### 2.2 退化标记扫描(无实际告警)

- `W_STAR_DEGRADATION` 字样在 events 中出现 5 处,**全部为协议名/策略名/自评文本**(root plan 的 `meta.protocol`、A1 plan 的 `strategy="W_STAR_DEGRADATION: L3 自主派 2 个 L4 worker"`、root done checklist `"全程零 W_STAR_DEGRADATION"`),**非独立告警事件**。
- event 类型仅 plan/progress/done/brief_echo/blocked,**无 type=warning**;`delegation_hint` 全 null;`nudge_count` 全 0;drift 14 条全为 rhythm/production 可恢复错误(无退化标记)。

### 2.3 每层自主履职证据(非 root 包办)

**L2 commander 自主性**(root 只发 brief):
- A/B/C commander 各自 create_session(ZLM)+ leaf_add(parent=自己)建 L3 ✓
- 各发 5 件套 brief 下传(comm_log entry 7-10、19-20 留痕)✓
- A commander 给 A1 发了 **5724 字 brief**(含 20 IPC 端点精确清单 + done 八步 + V10 约束),比 root 给它的还详尽 ✓
- A commander **实地核查项目真实状态**,修正审计报告"router/snapshot 95%"的估算措辞下传澄清 ✓

**L3 sub-commander 自主性**(L2 不越级):
- A1 自主派 A1a+A1b;B1 自主派 B1a+B1b;C1 自主派 C1a ✓
- 正确回填 alignment(A1a=0.92 / A1b=0.90 / C1a=0.95,auditor=root 信任锚)✓

**L4 worker 自主性**:
- 4 worker 写高质量 brief_echo(A1a 精确到端点拆解 4+3+2+4+3+4=20;C1a 规划 TC-SPRINT-210~309 + 7 类判据)✓
- A1a 自纠 E_DELIVERABLE_MISSING(cp report 到 deliverables 后第二次成功),沉淀 auto memory ✓

**root 职责边界**(只协调 + 冷启动信任锚):
- 从未 leaf_add worker;零 W_STAR_DEGRADATION
- 履行引擎冷启动信任锚:配 milestone_set_result + audit_gate pass(因 V10 约束只有 root 能当冷启动 auditor,见 §5)
- 有 5 次越级 **send_message 通知** worker(A1a/A1b/C1a/B1a/A1/C1/B1)——内容全为"通知 set-status"或"配门禁信任锚",**执行者仍是 worker 自己(caller=owner)**,**合规**(非越级 leaf_add)

### 2.4 vs macp 基线(tests/002 星形退化)——决定性对照

| 维度 | macp(2026-07-24,星形退化) | macp2(2026-07-25,多层自主) |
|------|---------------------------|----------------------------|
| root 行为 | 建 3 commander 但**从不发 brief**,越级直连 6 worker | 只发 brief 给 3 commander,**绝不越级建 worker** |
| commander 状态 | 沦为孤儿占位,events 永远为空 | 自主建 L3 + 发详尽 brief + 跟进 done |
| 树形态 | 扁平星形(root→6 worker) | 真 4 层树(root→3→3→5) |
| W_STAR_DEGRADATION | 无防护(引擎当时未拦) | root 全程零告警 |
| progress event | **0** | **37** |
| communication_log | **0** | **32** |
| drift | **0**(24 次失败零记录) | **14**(10 self_correct + 1 declare) |

> **结论**:macp §3.1 明载"3 commander 建后从未收 brief → root 直连 6 worker → 树退化为星形"。macp2 形成完整 4 层自主树形,L2/L3 全自主履职,root 零越级 leaf_add——**核心教训被有效吸收,质变改善**。

### 2.5 主动性评分:**9/10**

扣 1 分主因:**audit 门禁回流 root 频繁**(A/B/C 子树各 2-4 次)——这是引擎 V10 冷启动约束所致(`milestone_set_result`/`audit_gate` 只有 root 信任锚能配,commander 自配撞 E_AUDITOR_NOT_INDEPENDENT / E_BORROWED_IDENTITY),**非 commander 不主动**,但客观上削弱了"commander 全自主 done 闭环"的纯度。worker 各卡一轮"等 root 通知 set-status"亦同因。

---

## 三、macp 项目推进评估

### 3.1 12 P0 基线(取自 `.context/mlaudit-reports/macp-{A1,A2,B1,B2,C1,C2}-worker.md`)

聚焦 macp2 任务三大责任区:**C1 实现类(3)、B2 API 对齐类(3+)、C2 测试类(3)**。

### 3.2 P0 真实解决核验(自述 9 → 独立核验 **7 真 + 2 部分**)

| P0 | 自述 | 独立核验 | 证据 |
|----|------|---------|------|
| C1-P0-1 整库不可运行 | ✅ | ✅ **真** | package.json 补 6 脚本 + main→dist/electron/main.js + 8 devDeps;main.ts 可启动并有 renderer fallback |
| C1-P0-2 沙箱缺失 | ✅ | ✅ **真(质量最高)** | sandbox-manager.ts 20KB,prepareIsolation(envRemap+祖先路径防逃逸)+spawnIsolated(并发守卫+watchdog+OOM kill)全实现,仅 4 处占位 |
| C1-P0-3 coder/judge 逻辑 | ✅ | ⚠️ **未解决(空壳)** | coder-stub 593 行/**55 处占位** + judge-stub 498 行/**39 处占位** = 94 处占位,0 业务逻辑(文件名诚实标注 -stub,非虚假注水) |
| B2-P0-1 版本漂移 | ✅ | ✅ **真** | api-spec v0.4,agent-comm 引用对齐,有"闭环 audit B5"标注 |
| B2-P0-2 缺 4 channel | ✅ | ✅ **真** | main.ts 有 project:list/open/delete/switchMode 全 4 个真实 handle + frontend-backend-api.md +319 行契约 |
| B2-P0-3 协作语义 | ✅ | ✅ **真** | agent-comm §2.3.1 SPSAS 不变量 + SESSION_LOCK_CONTENTION 完整 payload + 重试语义 |
| B2-P0-4 错误码收录 | ✅ | ⚠️ **部分** | SESSION_LOCK_CONTENTION ✅收录;但 **GUIDE_INTERNAL_JUDGE_FAILED 未按 P0-4 要求重命名为 GUIDE_JUDGE_EVALUATION_FAILED**(api-spec.md:974 仍用旧名) |
| C2-P0-1 Phase2-4 空白 | ✅ | ✅ **超额** | test-plan §10(S4-S13 共 10 Sprint 四要素)+ §10.11 追溯表 **100 用例 TC-SPRINT-210~309**,远超要求 |
| C2-P0-2 缺陷流程缺失 | ✅ | ✅ **高质量** | defect-management.md 342 行,P0/P1/P2 + 五维矩阵 D1-D5 + issue 模板 + SLA + Sprint 联动,完整闭环 |
| C2-P0-3 判据不明 | ✅ | ✅ **真** | test-plan §11 追加 7 类用例 PASS/FAIL 客观信号 + CI 集成 |

**核验结论**:**9 个 P0 中 7 个硬确认真实解决 + 2 个部分**(B2-P0-4 命名未遵循、C1-coder/judge 业务逻辑仍空壳)。自述基本属实,略有美化(把"契约级空壳 stub"也计入"已解决")。

### 3.3 代码质量评级

| 产出 | 评级 | 依据 |
|------|------|------|
| `src/sandbox/sandbox-manager.ts`(20KB) | 🟢 **真实骨架** | prepareIsolation/spawnIsolated 真实现,占位密度极低(~4 处) |
| `electron/main.ts`(331 行/13687B) | 🟢 **真实骨架** | 20 个 ipcMain.handle/on 真实绑定 + 信封规范,含 B2-P0-2 的 4 个 project:* channel |
| `package.json` + tsconfig | 🟢 **可运行** | 6 脚本 + main 入口 + electron/vite/typescript devDeps 齐备 |
| `src/coder/coder-engine-stub.ts`(593 行) | 🟡 **契约级空壳** | 55 处占位,契约齐备但 0 业务逻辑(符合 -stub 定位,非虚假) |
| `src/judge/judge-engine-stub.ts`(498 行) | 🟡 **契约级空壳** | 39 处占位,同上 |
| 文档(test-plan/defect-mgmt/api-spec/agent-comm) | 🟢 **实质内容** | 1339/342/1119/670 行,版本对齐 + 错误码 + Phase2-4 规划实质 |

### 3.4 C1 推进量化

**C1 从 macp 基线 32/100 → 估算 58-65/100**:沙箱(0→满)+ 可运行性(0→满)两大块拉起;但 coder/judge 业务逻辑、6 编程子角色、wizard 骨架仍拖后腿。

### 3.5 项目推进 verdict:**条件 PASS**

P0 真实解决率 7/9(78%),代码无虚假注水(stub 诚实标注),文档质量超预期。扣分项:coder/judge 仍是契约级空壳(占位密度 ~10%);B2-P0-4 错误码重命名未执行。

> ⚠️ **§3.6 MiniMax-M3 代码复审修正(2026-07-25 14:35,见 §7.2)**:上述 §3.3-3.5 为**初版 4×GLM-5.2 结论**,经 MiniMax-M3 逐文件全文复审后**一致向下修正**:
> - C1 从 58-65 **下调到 47/100**
> - coder/judge:"契约级空壳" → "**不可运行的空壳**"(核心方法 `generateCode/runGwt/evaluateCode` 0 业务逻辑;`runHardChecks` 直接 `return []`、**7 项硬约束全不存在**;`runSoftEval` 返回写死 0.85;`withSoftTimeout` 根本未实现超时)
> - sandbox:"质量最高/真实骨架" → "**最诚实的降级实现**"(架构 §11 自承"非真沙箱",prepareIsolation 仅 cwd+env 重映射,非 OS 级隔离,子进程仍可读 /etc/passwd)
> - Electron 20 IPC:"真实骨架" → **19 空壳 + 1 半空壳**(仅 project:delete 有真实校验)
> - 占位数修正:coder 55→17、judge 39→14(GLM 把步骤注释也算入,但结论方向不变——核心 0 业务逻辑)
> - **真实深度解决 P0 从 7 下调为 5-6**(coder/judge 业务逻辑、sandbox OS 级隔离均未落地)

---

## 四、P1-1 / P1-2 使用评估

### 4.1 数据(`tree_event_list`/`tree_communication_list`/`tree_drift_list` 独立全量核验)

| 指标 | macp 基线 | macp2 实测 | 改善 |
|------|-----------|-----------|------|
| progress event | **0** | **37** | 质变 |
| communication_log | **0** | **32** | 质变 |
| drift | **0**(24 次失败零记录) | **14**(10 self_correct + 1 declare) | 质变 |

### 4.2 P1-1 progress 覆盖(条件 PASS)

- 37 条,覆盖 **8/11 非 root leaf(73%)**,时间跨度 12:37→13:39,平均 1.6 分/条,节奏活跃
- 层级分布:L2 commander **全覆盖**(A=9/B=6/C=5);L3 覆盖 2/3(A1=6、C1=2、**B1=0**);L4 覆盖 3/5(B1a=3/B1b=2/C1a=4、**A1a=0、A1b=0**)
- ⚠️ **断层**:B1/A1a/A1b 三 leaf 中间无 progress(直接跳到 done)——违背 macp §3 观察员点名的"worker progress tracking"要求

### 4.3 P1-2 communication_log 覆盖(条件 PASS)

- 32 条:root out=15 / 上行=17;类型齐全(root→L2 brief 6 条含 ZLM 重发、L2→L3 brief 3 条、L3→L4 brief 3 条、done 上报 9 条、root 通知 set-status 8 条)
- ⚠️ **~10% 漏记**(3-4 条),集中在:
  - A1→A1a brief、A1→A1b brief:12:43 progress 自述"已发",comm_log **无对应记录**
  - B1b→B1 done:由 B1 代报,B1b 自身未 log
  - C1a→C1 done:由 C1 代报

### 4.4 drift 使用(PASS)

14 条:rhythm 3(ZLM 切换 session_id)+ production 11(10 self_correct + 1 declare: B1 主动声明 audit 门禁困境);severity 全 low/mid,无 high——健康迭代文化,非隐瞒。

### 4.5 P1 verdict:**条件 PASS**(vs macp 显著改善,但覆盖有缝)

---

## 五、改进建议(供父会话拉团队改进)

按优先级 P0 / P1 / P2,分引擎层 / SKILL 层 / 流程层。

### 🔴 P0(高优先,直接影响多层主动性纯度)

| # | 层 | 建议 | 理由 |
|---|----|------|------|
| P0-A | 引擎 | **放开"冷启动禁 fork 独立 auditor",采用 macp2 commander 们提的方案 B**:root fork 一个 role=auditor leaf 并背书它 audit_gate pass,之后该 auditor leaf 给全树所有 leaf 配 milestone_set_result/audit_gate(root 只介入一次) | 当前 V10 冷启动约束致 audit 门禁全回流 root(A/B/C 子树各 2-4 次),削弱 commander 全自主 done 闭环纯度,是主动性扣 1 分主因。P0a(2026-07-08)已用"root 先背书 auditor"解决循环依赖,方案 B scalable 且已有 commander 自主提议 |
| P0-B | 引擎 | **`tree_init` 自动绑定 caller session 到 root leaf**(或强制要求传 session_id),消除 PENDING_ROOT 死锁 | 本评估观察员建 oeval-macp2 时实测:tree_init 未绑 caller session → root leaf session=PENDING_ROOT → set_session 撞 E_BORROWED_IDENTITY(creator=null)→ leaf_add added_by 校验失败 → 冷启动死锁。macp2 root commander 靠额外手段绕过,新人会卡 |
| P0-C | 项目 | **下个 Sprint 把 coder/judge-stub 占位密度从 ~10% 降到 <2%,接入真实 LLM 调用** | C1-P0-3 业务逻辑仍空壳(94 处占位),C1 评分 32→58-65 拉不起来的主因 |

### 🟡 P1(中优先,影响可观测性与协议完整度)

| # | 层 | 建议 | 理由 |
|---|----|------|------|
| P1-A | SKILL | **tree-worker/tree-commander SKILL 加硬 checklist:每次 `send_message` 后必须紧接 `tree_log_communication`** | 当前 comm_log ~10% 漏记,集中在 L3→L4 brief 高发漏点,影响心跳可见性(P1-2 目的) |
| P1-B | SKILL | **worker 层强制至少 1 条中间 progress event(非直接 done)** | B1/A1a/A1b 三 leaf 进度对父/心跳不透明,违反 macp §3 点名要求 |
| P1-C | SKILL | **brief 模板预置"set-status caller=owner(worker 自己)"规则讲透** | 4 个 worker 各卡一轮"等 root 通知 set-status",来回成本高 |
| P1-D | 项目 | **补做 B2-P0-4 错误码重命名迁移**(GUIDE_INTERNAL_JUDGE_FAILED → GUIDE_JUDGE_EVALUATION_FAILED),或在审计回复明确说明保留旧名理由 | P0-4 部分未达标,api-spec.md:974 仍用旧名 |

### 🟢 P2(低优先,文档与一致性)

| # | 层 | 建议 | 理由 |
|---|----|------|------|
| P2-A | 引擎 | **`tree_init` 校验 tree_id 符合 prefix 规则(`[a-z][a-z0-9_]{3,7}` 无连字符),否则拒绝** | 本评估用 tree_id="oeval-macp2"(含连字符)→ tree_init 接受但 leaf_add 的 prefix 派生断裂(E_NAME_INVALID)。引擎前后校验不一致 |
| P2-B | 文档 | **修订 `macp2-root-summary.md` 的"共 11 leaf"为"12 leaf"** | 自述 leaf 计数误(实际 12),避免后续审计误判 |
| P2-C | 文档 | **文档化 C 子树扇出不对称(A/B 各 2 worker、C 仅 1)的设计意图** | 防未来审计误读为"C commander 履职不充分" |
| P2-D | 流程 | **macp2 的 V10 冷启动 audit 约束发现 + 方案 A/B 已沉淀至 auto memory `multi-layer-tree-commander.md`,下轮 commander 可直接复用** | 知识已沉淀,确认团队按此执行 |

---

## 七、多模型对抗审查(差异化复核,2026-07-25 14:35 补)

> ⚠️ **本评估初版(§一~§五 + §六 v1)由 4 个评估员完成,但均为 GLM-5.2 单一模型,结论高度一致——存在同质化共识风险。** 应"需获得原初差异性"的复核要求,补派 **2 个不同厂商模型**对前述共识做对抗审查:W5=**DeepSeek-v4-pro**(逻辑一致性对抗)、W6=**MiniMax-M3**(代码现实派,macp 基线同款最严苛视角)。两者**方向一致地向下修正**了初版裁定,印证"单模型共识偏乐观"。

### 7.1 W5 DeepSeek-v4-pro — 逻辑对抗(部分反驳"核心 PASS")

三项 GLM 共识盲区:

1. **"0 越级 leaf_add = 主动性成功"是形式逻辑谬误**:added_by 链只证**结构合规**,不证**实质自主**。DeepSeek 查 list_messages(root 会话 580 条)发现:
   - root 实际**直连 8/10 非 root leaf**(≥9 条跨级直连,初版所报"5 次"是低报)
   - **A1(L3)5 次给父 A-commander 发消息全失败**("上一条消息仍在处理中"),被迫**绕过 L2 直连 root** 配门禁;C1 同样绕过 C-commander 寻 root——这是"**链路断裂被 root 修补**",非"自主"
   - commander→root 消息 **100% 是门禁背书请求、零战略判断**——commander 干的是"建子+发 brief+写 progress"的**执行委派**,非**权威委派**;关键批准权(里程碑/审计门禁)全回流 root
   - **修正等式**:"多层执行委派成功" ≠ "多层自主权威成功"
2. **macp2 vs macp 多样性维度被忽略**:macp 用 DeepSeek/GLM/MiniMax 三模型交叉(observer report §5 明载互补价值),macp2 全 GLM-5.2 零多样性——"用结构优化换取认知同质化";且本评估初版"4 个 GLM 评 GLM 产出" = **递归同质化**(类比审计学"同所审计同客户多年"的独立性风险)
3. **"9 P0 推进"水分**:`grep` 出 **141 处占位**,核心引擎空壳归类"部分解决"是**会计美化**(类比"没发动机的车打条件 PASS")

**新增改进建议**(初版未提):① commander 的 audit_gate 全 `skip` 是方法论漏洞——root 信任锚把信任给了 commander 但**从未验证其工作质量**,建议下轮对 commander 增设 **peer audit**(A↔B↔C 互审);② 用"**决策多样性**"补"结构多样性"(每个 commander brief 须列"可能出错的关键假设"供 worker 挑战)。

### 7.2 W6 MiniMax-M3 — 代码现实派(C1 独立打分 47/100)

逐文件深读全文,强力下调初版代码评级:

| 文件 | 初版 GLM 判断 | MiniMax 独立复核 |
|------|--------------|------------------|
| coder-stub(593行) | 55处占位/契约级空壳 | 占位实为 **17处**(55 把步骤注释也算);但核心方法 `generateCode/applyFix/runGwt` **0 业务逻辑**——调 stub LLM + 写死返回 outputFiles/testReport{8/8/0} |
| judge-stub(498行) | 39处占位/契约级空壳 | 占位实为 **14处**;但 `runHardChecks` 直接 `return []`、**7 项硬约束全不存在**、`runSoftEval` 返回写死 0.85、`runClassConsistencyCheck` 写死 2 个类名——**无一规则真会跑** |
| sandbox-manager | 🟢 质量最高/真实骨架 | **不是 OS 级隔离**(架构 §11 自承"非真沙箱"),prepareIsolation 仅做 cwd+env 重映射,子进程仍可 `fs.readFileSync('/etc/passwd')` → 应标"**最诚实的降级实现**" |
| electron/main.ts(20 IPC) | 🟢 真实骨架 | **19 空壳 + 1 半空壳**,仅 `project:delete` 有真实校验;通道就绪 ≠ 业务就绪 |

**初版漏报硬伤**(MiniMax 新发现):
- `withSoftTimeout` **根本没实现超时**(注释 "S1 占位:直接 await")——60s 超时保护形同虚设,LLM 卡死即拖垮整个 judge 流程
- coder/judge 距离"能跑"还需 **1500+ 行生产代码 + 真实 LLM 联调**(PromaCloudLlmClient 实现 + sandbox 回填 + 自修复循环 + PlantUML TypeScript Compiler API 解析 + 硬约束 7 项)

**C1 独立打分 47/100**(比 macp 基线 32 高 15 分、比初版 GLM 58-65 低 11-18 分):架构骨架 + 错误码对齐 + sandbox watchdog 真能跑拉起;核心引擎 0 业务逻辑 + 距能跑差 1500+ 行拉低。

### 7.3 对抗审查结论

两不同厂商模型**一致向下修正**初版裁定,印证 GLM-5.2 单模型共识存在**乐观偏差**:
- **核心主动性**:PASS → **形式达标、实质部分达标**
- **C1 代码**:58-65/100 → **47/100**;coder/judge "契约级空壳" → "**不可运行的空壳**";sandbox "质量最高" → "**最诚实的降级实现**"
- **多模型多样性**:macp2 相对 macp 是**认知多样性退化**(初版对比未提此维度)

> 方法论启示:树形任务评估本身亦需多模型交叉,单模型(GLM-5.2)评估单模型(GLM-5.2)产出构成递归同质化,务必引入异厂商对抗审查。

---

## 六、终局裁定(Verdict,经多模型对抗修正)

### 6.1 维度汇总(经多模型对抗修正)

| 维度 | 初版(4×GLM-5.2) | 对抗修正后(+W5 DeepSeek +W6 MiniMax) |
|------|------------------|----------------------------------------|
| 1. 树结构 | PASS | **PASS**(无争议,4层12leaf0issues) |
| 2. 多层指挥官主动性(**核心**) | PASS | **形式达标 / 实质部分达标**(0越级结构合规铁证;但 audit 门禁全回流 root + L3→L2 链路断裂 + commander 仅执行委派非权威委派) |
| 3. 项目推进 | 条件 PASS(C1 58-65/100) | **条件 PASS(保守,C1 47/100)**;coder/judge=不可运行空壳;sandbox=降级实现 |
| 4. P1 使用 | 条件 PASS | 条件 PASS(对抗审查未新反驳,维持) |

### 6.2 总裁定:**条件 PASS(保守)——核心仅形式达标**

经 DeepSeek-v4-pro + MiniMax-M3 两**异厂商**模型对抗复核,初版"条件 PASS(核心 PASS)"**向下修正**:

- **核心考核(多层主动性)**:**形式达标、实质部分达标**。结构层面 0 越级 leaf_add、4 层树完整无误(铁证,无争议);但**实质自主性受限**:audit 门禁/里程碑全回流 root(引擎 V10 冷启动约束)、**L3→L2 链路断裂**(A1 5 次寻父失败)被迫越级 root、commander 决策深度仅"执行委派"非"权威委派"。相对 macp 星形退化仍是**显著改善**,但"完全自主履职"的表述须打折扣。
- **项目推进**:C1 从 58-65 **下调到 47/100**(MiniMax 独立打分)。核心引擎 coder/judge 为"**不可运行的空壳**"(`runHardChecks` 直接 `return []`、7 项硬约束全无、`withSoftTimeout` 未实现超时);sandbox 为"**降级实现**"(架构 §11 自承非真沙箱);20 IPC = 19 空壳 + 1 半空壳。9 P0 中**真实深度解决的应下调计为 5-6 个**(coder/judge 业务逻辑、sandbox OS 级隔离均未真正落地,初版计入偏宽)。
- **多模型多样性维度**(初版漏):macp2 全 GLM-5.2 单模型,相对 macp 三模型交叉是**认知多样性退化**;且评估环节"GLM 评 GLM"= 递归同质化——本次靠补派 DeepSeek+MiniMax 才暴露初版乐观偏差,**本身即证明多模型对抗的必要**。

**建议父会话**:判定 macp2 树形任务**核心协议形式达标、条件 PASS(保守)**,但**不宜宣传为"多层主动性完全成功"**。下轮重点(升级版):
- **P0-A** 放开禁 fork auditor **并修 L3→L2 链路断裂**(让 commander 真正自主完成 done 闭环,而非仅执行委派)
- **P0-C** coder/judge 接入真实 LLM + 实现 7 项硬约束 + `withSoftTimeout`(约 1500+ 行)
- **🆕 P0-D 引入多模型交叉**:下轮 commander 子树刻意用不同模型(DeepSeek/MiniMax/GLM 等),恢复 macp 多样性优势;并对 commander 增设 **peer audit**(A↔B↔C 互审,补 audit_gate 全 skip 的方法论漏洞)
- P0-B(引擎 `tree_init` 绑 session)、P1-A/B(comm_log + progress 覆盖)维持

---

## 附录 A:观察方法与独立性声明

- **观察架构**:Pro 实例独立观察员(session `cbaca811`)+ 2 层观察树 `oeval-macp2`(root 观察 → 4 评估 worker 并行)
- **4 评估 worker(初版,均 ZLM-CodingPlan / GLM-5.2,独立子会话)**:
  - W1 树结构、W2 多层主动性(核心)、W3 项目推进、W4 P1 使用
- **🆕 多模型对抗复核(2026-07-25 14:35 补,应对"单模型同质化共识"风险)**:
  - W5 **DeepSeek-v4-pro**(DeepSeek 官方渠道,逻辑一致性对抗)→ 部分反驳"核心 PASS"(见 §7.1)
  - W6 **MiniMax-M3**(MiniMax-CodingPlan,代码现实派,macp 基线同款最严苛)→ C1 独立打 47/100(见 §7.2)
  - W7(原派 GLM-**4.6V**)因视觉模型不胜任文本架构审查、经复核指出后**废弃未派**(3 模型对比已足够)
  - 两异厂商模型**一致向下修正**初版裁定——印证单模型(GLM-5.2)共识存在乐观偏差
- **独立性**:4+2 worker 各自调 `tree_tree_dump(macp2)` + `list_messages(03cce210)` + 读项目文件 + 读 macp 基线,**不轻信根指挥官 `macp2-root-summary.md` 自评**;观察员 root 另用 node 全量解析 113KB tree_dump 交叉。结论由 6 worker(含 2 异厂商对抗)+ root 一手核验双向印证。
- **观察员自身合规**:2 层观察树,4 worker 均观察员直接子节点(无越级);自身亦撞引擎冷启动工具缺口(PENDING_ROOT 死锁 / tree_id 连字符致命名断裂),已转 P0-B / P2-A 改进建议。

## 附录 B:关键数据文件索引

- macp2 树状态:`.context/trees/macp2/tree-state.json`(可 `tree_tree_dump(macp2)` 取)
- 根指挥官自述:`.context/macp2-root-summary.md`(注:leaf 计数有误,见 P2-B)
- macp2 产出报告(12 份):`.context/trees/macp2/deliverables/macp2-{root,A,B,C,A1,B1,C1,A1a,A1b,B1a,B1b,C1a}-*.md`
- macp 基线(tests/002 星形退化):`.context/mlaudit-reports/macp-{observer-report,root-summary,A1..C2}.md`
- 本评估的观察树:`.context/trees/oeval-macp2/tree-state.json`

---

*报告生成:2026-07-25 ~14:45 GMT+8*
*评估方:Pro 实例独立观察员(session cbaca811)· 2 层观察树 oeval-macp2 · 4 ZLM/GLM-5.2 评估 worker*

