---
description: |
  树形会话执行体系 — 工人（子会话/叶子节点）操作手册。
  触发场景：被 Fork 成 worker / 接收 5 件套契约 / 处理 brief_echo 回填 /
  milestone 自审 / 子会话角色 / 上行事件 done/blocked/plan/heartbeat_reply /
  接到 mcp__tree__* 工具调用任务 / 接收 autonomy_override 限权。
  核心能力：5 件套契约解析 / 里程碑拆解 / 自审 check-list / 上行事件格式化 /
  对齐度自评 / V5b 硬约束遵守（alignment 回填才能 audit pass）。
  工具调用前先 mcp__tree__tree_help(topic) 拿用法。
---

# tree-worker / 树形会话执行体系 — 工人 Skill

> **角色**: 子会话（叶子节点）加载的操作手册。定义如何理解任务契约、拆解里程碑、执行自审、上报事件。

> ### 📍 任务启动第一件事（2026-07-08 调用形式事故后强制）
>
> 你被 leaf_add 加入树时，返回结果带 `startup_notice`（引擎强制）——**必读**：
> 1. **先加载本 SKILL**（尤其 §4.6「调用形式红线」），再干活。
> 2. G1-G5 自审的 SubAgent 只能用内置 **`Agent` 工具**（进程内）；🚫 禁 `create_session`/`fork_session`/`delegate_agent` 当 reviewer（建真实会话＝烧独立 API 额度；既往调用形式事故）。
> 3. 撞错修根因，禁换名重试新建会话。收敛：角色 2/3/5 + 轮≤3 + `red_count=0` 停。
> 4. 每 leaf subagent_spawn ≤ 15（引擎 `E_SUBAGENT_BUDGET_EXCEEDED` 硬拦）。

---

## §0 元数据

```yaml
skill_name: tree-worker
version: 2.6
target: 子会话（叶子 Worker / create_session 创建的执行会话；子 Commander 由 fork_session 创建）
requires:
  - tree-state.js                          # 通过 commander 间接调用，worker 不直接调
  - tree-audit-methodology.md v1.0        # 当角色为审查/审计/验证时必读
load_on: create_session  # 原则 11：叶子 = create_session；子 Commander 由 fork_session 创建
```

---

## §1 铁律（9 条，v0.2 升级版）

> 对应设计文档: §3 契约纪律, §4.2 事件通道, §5.4 双层纠偏, §6.1–6.5, §10.4

| # | 铁律 | 违例后果 |
|---|---|---|
| 1 | **首条消息必须是 brief_echo** — 用自己的话复述 brief/dod，不通过简报不放行干活 | 路线图 Agent 驳回，最便宜的纠偏 |
| 2 | **必须列出 milestones** — 没有 milestones 的任务不允许开始 | 指挥官拒绝下发，契约不成立 |
| 3 | **每个 Mi 完成后必须自审**（v0.2 必须化）— Fork code-reviewer 做对齐校验，最多自纠 2 次 | 自审缺失 → done 验收直接 severity=high |
| 4 | **每个 Mi 产出必须带 .note.md** — 无 note → 验收 Agent 直接 severity=high | 重档退回，产出不被接受 |
| 5 | **上下文最小化** — 不留一次性大输出、不重复读已读文件、超 85% 甜点主动声明 | 哨兵 Agent 竹节强制交接 |
| 6 | **done 上报必须附 self_check** — 逐条比对 deliverables + quality_gates，附 check-list ✅/❌ | 缺一项 → 不进入外部验收，直接退回 |
| 7 | **上行消息必须结构化 YAML** — 只允许 done/blocked/plan/brief_echo 四种 type，不允许散文 | 指挥官路由 Agent 无法解析，视为无效上报 |
| 8 | **严禁直接读写 tree-state.json** — 所有状态通过事件上报让指挥官调 tree-state.js 记录 | 违反补丁 4，字段错写/覆盖丢失由工人全责 |
| 9 | **严禁越界** — 改动 out_of_scope → 必须请示；改动 DoD deliverables → 必须请示 | 方向偏差，路线图 Agent 检出后升级纠偏 |
| 10 | **set-status done 必须 worker 自己调** — commander 代调被 E_BORROWED_IDENTITY 拦；步骤 8 audit_gate pass 由 commander 完成，步骤 9 set-status done 是你自己的事 | 引擎硬拦，worker 卡“等通知”浪费时间 |

---

## §2 收到 5 件套后的首动作

> 对应设计文档: §3 核心契约, §3.5 自审契约, §6.1

> 📍 **启动首步（2026-07-14 Sprint 2 约束 4，混合任务书机制）**：worker 启动后指挥官发来的首条消息只含 `leaf_id`（混合任务书，非完整 5 件套）。**第一件事是 `mcp__tree__tree_leaf_get(tree_id=<tree_id>, leaf_id=<自己的 leaf_id>)` 主动读 leaf 持久化的 5 件套**（commander §4 Step 2 写进 leaf 的 `brief`/`dod`/`report_protocol`/`autonomy`/`self_audit` 字段），不依赖 fork 继承父历史（正常派生是 create_session，干净会话）。详见 §2.5 阶段 3。

worker 会话启动 → 读 leaf 任务书 → 拿到 5 件套契约（brief / dod / report / autonomy / self_audit）后，按以下流程执行：

```
0. 启动首步：tree_leaf_get 读自己的 5 件套
   mcp__tree__tree_leaf_get(tree_id=<tree_id>, leaf_id=<自己的 leaf_id>)
   从返回的 leaf.brief / leaf.dod / leaf.report_protocol / leaf.autonomy / leaf.self_audit 取出 5 件套
   ⚠️ 权威任务书来源（持久化进 leaf，崩溃恢复 / 竹节交接不丢）；指挥官首条 send_message 只给 leaf_id 指路

1. 解析 5 件套
   逐条阅读 brief.in_scope / brief.out_of_scope / dod.deliverables / dod.quality_gates
   理解 autonomy.can_decide / must_report / must_ask 的边界

2. 写出 milestones 列表并持久化
   优先使用 self_audit.milestones（如已提供）
   若未提供，基于 brief.my_mission 自己拆解
   每个 Mi 包含: id / desc / expect_outputs
   持久化：调 mcp__tree__tree_milestone_add(tree_id, leaf_id=自己, milestone={id,desc,expect_outputs}) 逐个 add
   （V3 硬约束：done 前 milestones 必须非空 + 全部 audit_pass；不 add → done 被 E_* 拦）

3. 发送 brief_echo
   用自己的话复述理解 + milestones_preview（模板见 §3.4）
   不通过简报不放行干活

4. 等待放行
   默认放行时间: report.plan_ack_seconds（默认 300 秒，即 5 分钟）
   5 分钟内未收到 NACK → 默认放行，开始执行
   收到 NACK → 根据指挥官反馈修正理解后重新发送 brief_echo
```

---

## §2.5 worker lifecycle 全景（谁调什么）

> 对应设计文档: §4.2 事件通道 + §6.1 brief_echo；commander 侧流程见 tree-commander SKILL §13.3。
> 一图看懂 worker 一生要经历 9 个阶段，哪些是 worker 主动调、哪些是 commander 调、哪些是 worker 收件。

| 阶段 | 调用者 | 工具 / 动作 | worker 做什么 |
|------|--------|------------|--------------|
| 1. 派生 | commander | 正常派生：`create_session`（§4 Step 2）；仅 §7 纠偏重档 / F1 崩溃恢复用 `fork_session` | （被动）被创建，拿到自己的 session_id |
| 2. leaf_add | commander | `mcp__tree__tree_leaf_add`（含 5 件套持久化进 leaf） | （被动）被登记为 tree 里的 leaf，拿到 leaf_id |
| 3. 读 5 件套 | **worker 主动** | 首条 send_message 只含 `leaf_id`（混合任务书）→ worker 调 `tree_leaf_get(自己的 leaf_id)` 读 leaf 持久化的 5 件套 | 解析 brief/dod/report/autonomy/self_audit，理解任务边界 |
| 4. brief_echo（首条） | **worker 主动** | `mcp__tree__tree_event_append(type=brief_echo, meta={my_understanding, milestones_preview})` | 用自己的话复述 brief + 列 milestones（无 alignment 字段） |
| 5. alignment 回填 | commander（root 身份） | `tree_event_append(type=brief_echo, meta={alignment, auditor_session_id=root.session_id})` | （被动）等待 commander 回填对齐评估；撞 `E_ALIGNMENT_NOT_VERIFIED` 说明这步没做，上行 `blocked` 提示母会话 |
| 6. 干活 | **worker 主动** | 产出文件落盘 `deliverables/` + 每个 Mi 自审（§4）+ review_round（若 review_required，§4.6） | 执行 milestones，每个 Mi 完成跑 §4.2 自审、产出 `.note.md` |
| 7. done event | **worker 主动** | `tree_event_append(type=done, meta={self_check, deliverables, milestones, context_usage, drift_declaration})` | 全部 Mi 完成、self_check 全过后上报；self_check schema = `[{item,pass,evidence}]`（§3.1） |
| 8. audit_gate pass | commander（caller===audit_session_id=root.session_id） | `tree_audit_gate(verdict=pass, audit_session_id=root.session_id)` | （被动）等待门禁背书；步骤 5 没做则这步被 `E_ALIGNMENT_NOT_VERIFIED` 拦，worker 永远到不了步骤 9 |
| ⚠️ **衔接规则** | — | — | **步骤 8 是 commander 的最后一步，步骤 9 是你（worker）自己的事——不要等 commander 通知你调 set-status，audit_gate pass 本身就是“可以 set-status”的信号** |
| 9. set-status done | **worker 主动** | `tree_leaf_set_status(status=done)` | 步骤 8 通过后自己调；deliverables 必须已落盘，否则 `E_DELIVERABLE_MISSING` |

> **worker 主动调的步骤**：4（brief_echo）、7（done event）、9（set-status done）——这三步 commander 不能代调（代调 → `E_BORROWED_IDENTITY`）。
> **步骤 9 前必须步骤 8 完成**：worker 调 set-status done 时引擎查 `audit_gate.verdict=pass`，没过 → `E_GATEKEEPER_REQUIRED`。若卡在这，先确认 commander 是否已调步骤 8（上行 `blocked` 催一下）。
> **撞 `E_ALIGNMENT_NOT_VERIFIED`**：说明步骤 5 没做（commander 没回填 alignment event），worker 这边上行 `blocked` 提示母会话补 alignment 评估，**不要自己伪造 alignment**（auditor 必须独立，伪造会被拦）。

### §2.5.1 SubAgent 辅助（步骤 6 干活期间，鼓励但非强制）

> 2026-07-07 新增（SubAgent 入树）。worker 在步骤 6 干活时，可 spawn SDK SubAgent 放大产能；每个 SubAgent 通过本 leaf 上的 `subagent_spawn` 事件被树"看见"。SubAgent **不是树实体**（无 leaf_id / 无 Proma session_id），是 worker 本 leaf 事件溯源的劳动单元；worker 永远是自己 leaf 的 actor（caller-binding 不变）。

**两种辅助场景**：

| 场景 | SubAgent role | 用途 | 落盘 + 事件 |
|------|--------------|------|------------|
| milestone 实施（§2.5 步骤 6） | `implement` / `research` | 辅助生成代码/文档/调研——比如让 SubAgent 写一个模块的初稿、查一组资料 | 每个 SubAgent 产出落 `<treeDir>/deliverables/subagent-outputs/sub-<本leaf>-<序号>.md`；append `subagent_spawn`（role=implement/research，output_ref 同上，status=done） |
| done 前内容审查（§4.6） | `review` | G1-G5 多视角审查 | 同上，详见 §4.6 |

**关键约束**：
- SubAgent 的劳动是**辅助**，milestone 的 `expect_outputs`（交付物）**仍是 worker 自己的责任**——worker 必须把 SubAgent 产出整合/校验为自己的交付物，不能让 SubAgent 产出直接当 milestone 交付物而不经过 worker 审阅。
- 每个 SubAgent **都要** append 一条 `subagent_spawn` 到本 leaf（不论 role）。`subagent_id` 父段必须 = 本 leaf_id；`status=done` 时 `output_ref` 文件必须存在 + size>0。
- SubAgent 产出落盘用绝对路径 `<treeDir>/deliverables/<output_ref>`（treeDir 从 tree_state 或 leaf 上下文取）。
- SubAgent 不得当 caller（worker 仍是本 leaf actor）；SubAgent 不得当 auditor-of-record（审计背书必须独立 leaf）。

**`subagent_spawn`（implement/research）示例**：

```yaml
- type: subagent_spawn
  meta:
    subagent_id: "sub:rvreq1-A1-worker:01"     # 父段 = 本 leaf_id
    role: implement                              # 或 research
    purpose: "为 M2 调研 3 个评测引擎方案，输出对比表"
    output_ref: "subagent-outputs/sub-rvreq1-A1-worker-01.md"   # 相对 deliverables 根
    status: done
```

> SubAgent 辅助是**鼓励**的（放大产能、并行提速），不是强制的——小任务 worker 自己干即可。但一旦 spawn，就必须按上述规则落盘 + 事件溯源，否则引擎 `E_DELIVERABLE_MISSING` / `E_DELIVERABLE_EMPTY` / `E_SCHEMA_INVALID`。

---

## §2.6 路径语义（治 BUG-2，重要）

> 2026-07-07 新增。worker 写文件、填 `expect_outputs` / `output_ref` 时，路径基准必须分清，否则引擎解析双重嵌套 → `E_DELIVERABLE_MISSING`。

**两条路径规则**：

| 字段 | 路径基准 | 解析后绝对路径 |
|------|---------|--------------|
| `milestone.expect_outputs`（worker 交付物） | **deliverables 根** = `<treeDir>/deliverables/` | `<treeDir>/deliverables/<expect_outputs>` |
| `subagent_spawn.meta.output_ref`（SubAgent 产出） | **deliverables 根** = `<treeDir>/deliverables/` | `<treeDir>/deliverables/<output_ref>` |

两者**都是相对 deliverables 根**，**不要**带 `deliverables/` 前缀（会双重嵌套）。

**正/误例子**：

```
✅ milestone.expect_outputs: "design.md"
   → 引擎解析 <treeDir>/deliverables/design.md
   → 文件落 <treeDir>/deliverables/design.md

❌ milestone.expect_outputs: "deliverables/design.md"
   → 引擎解析 <treeDir>/deliverables/deliverables/design.md（双重嵌套）
   → 文件实际在 <treeDir>/deliverables/design.md → E_DELIVERABLE_MISSING

✅ milestone.expect_outputs: "docs/api.md"
   → <treeDir>/deliverables/docs/api.md

❌ milestone.expect_outputs: "/docs/api.md"（绝对路径，引擎拒）
❌ milestone.expect_outputs: "../api.md"（含 ..，引擎拒，path-safe 校验）

✅ subagent_spawn.output_ref: "subagent-outputs/sub-rvreq1-A1-worker-01.md"
   → 引擎解析 <treeDir>/deliverables/subagent-outputs/sub-rvreq1-A1-worker-01.md
   → 文件实际落 <treeDir>/deliverables/subagent-outputs/sub-rvreq1-A1-worker-01.md（一致）

❌ subagent_spawn.output_ref: "deliverables/subagent-outputs/sub-...01.md"
   → 双重嵌套 → E_DELIVERABLE_MISSING

❌ subagent_spawn.output_ref: "<treeDir>/deliverables/subagent-outputs/sub-...01.md"（绝对路径，引擎拒）
```

**写文件时**：worker 用绝对路径 `<treeDir>/deliverables/<outPath>` 落盘（treeDir 从 tree_state 或 leaf 上下文取）。填字段时只填相对 deliverables 根的部分。

**done 门禁 size>0 校验**（治 BUG-3）：引擎在 `cmdLeafSetStatus(status=done)` 时，对每个 `expect_outputs` 校验文件存在 + `fs.statSync().size > 0`；0 字节 → `E_DELIVERABLE_EMPTY`。SubAgent 产出在 `subagent_spawn status=done` 时同样校验。worker 落盘后自检文件非空。

---

## §3 上行消息模板

> 对应设计文档: §4.2 事件通道, §6.1 brief_echo

### §3.1 done — 完成上报

**触发**: 所有 milestones 完成，self_check 全部通过后

**必填字段**: `event`, `deliverables`, `self_check`, `milestones`, `context_usage`, `drift_declaration`

> **self_check schema（v2.4 强化，引擎硬校验）**：必须是 `[{item, pass, evidence}]` 数组。`item` = 检查项描述；`pass` = true/false；`evidence` = ≥10 字的客观证据（引用产出文件的具体位置/行/段落，禁止空泛"已检查"）。缺 `evidence` 或 <10 字 → done event 被 `E_SELFCHECK_INVALID` 拦，必须重写。

> **P1b red_findings_resolved（2026-07-08，治假收敛）**：若你的 review_round 有 red findings（带 `finding_id`），done event 的 `meta.red_findings_resolved` 必须声明每条 red 怎么处理（治既往假收敛事故：red 降 yellow 但文档没改）。每项 `{finding_id, fix_method, fix_evidence}`：`fix_method` = `edit_file`（改了文档，fix_evidence 是 diff）/ `downgrade`（降级，fix_evidence 是理由）/ `other`；`fix_evidence` ≥20 字。无 red 或 red 无 finding_id 时可省略（向后兼容）。违例 → `E_SELFCHECK_INVALID`。详见 tree_help('how_to_worker_lifecycle')。

> **SubAgent 诚实性提醒（2026-07-07 补）**：若 worker 用了 SubAgent 辅助（§2.5.1）或 §4.6 多视角审查，self_check **不得**对 SubAgent 身份/产出撒谎——例如不得写 "reviewer_session_id 合法" 实则填了占位 UUID（旧 BUG-1，已被引擎 E_REVIEW_FORGERY 拦截），不得写 "SubAgent 产出完整" 实则文件 0 字节（BUG-3，已被 E_DELIVERABLE_EMPTY 拦截）。新机制下 worker 用真 `subagent_spawn` 事件 + 真 `output_ref` 落盘，self_check 如实核验：① 本 leaf events 中 subagent_spawn 数量 = 实际 spawn 的 SubAgent 数；② 每个 output_ref 文件存在且非空；③ review_round 的 reviewer_ref 都能溯源到 subagent_spawn。撒谎会被审计（commander 他审 + 独立 auditor）追溯查出。

```yaml
event: done
deliverables: ["docs/prd/module-x.md", "docs/prd/module-x/flow.mmd"]  # 必填
self_check:                     # 必填，逐条比对 deliverable + quality_gate；schema = [{item,pass,evidence}]
  - item: "Mermaid 流程图可渲染"
    pass: true
    evidence: "flow.mmd 经 mmdc CLI 渲染输出 flow.svg 无报错，含 7 个节点 6 条边"
  - item: "API 列表覆盖全部端点"
    pass: true
    evidence: "api.yaml 第 12-89 行列出 8 个端点，逐条对照 brief.in_scope 第 2 条 8 项全部命中"
  - item: "异常处理 section 存在"
    pass: false                  # ❌ 则标注原因，在 milestones 中说明
    evidence: "module-x.md 当前无 '异常处理' 二级标题，仅在第 4 段提及 1 句，缺 timeout/重试/降级三档"
milestones:                     # 必填，逐个标注
  - id: M1
    audit_pass: true
    note_path: "docs/prd/module-x/flow.note.md"
  - id: M2
    audit_pass: false           # 自审未过但有 drift_declaration
    note_path: "docs/prd/module-x/api.note.md"
context_usage: 73               # 必填，当前会话 token 使用百分比
drift_declaration: true         # 必填，v0.2: 如有未解决偏差则 true，否则 false
```

**可选字段**: 无（done 模板所有字段均为必填）

---

### §3.2 blocked — 卡点上报

**触发**: 遇到无法自决的阻碍

**必填字段**: `event`, `obstacle`, `tried`, `options`, `wait_for`

```yaml
event: blocked
obstacle: "评测引擎选型不确定，对课程环境的兼容性无把握"  # 必填
tried:                          # 必填，至少 1 项
  - "Docker 方案 — 部署太重，学生机器无法承载"
  - "WebAssembly — 较新，文档和社区支持不足"
options:                        # 必填，至少 2 个可选项
  - id: A
    desc: "Docker，稳定但部署重"
    cost: "高（需额外 500MB 镜像）"
  - id: B
    desc: "WebAssembly，轻量但风险高"
    cost: "中（需调研和学习投入）"
wait_for: "decision"            # 必填，固定值
```

**根会话回应格式**（工人收到后按此解析）：

```yaml
decision: "A"                   # 选中的 option id
reason: "稳定优先，部署重可接受"
```

**可选字段**: 无

---

### §3.3 plan — 拆解计划上报

**触发**: 需要拆解孙任务时

**必填字段**: `event`, `sub_missions`, `silence_ack_seconds`, `status`

```yaml
event: plan
sub_missions:                   # 必填，至少 1 项
  - name: "评测引擎调研"
    dod: "输出引擎对比表（≥3 个方案），含性能/部署/兼容性维度"
    est_steps: 5
  - name: "评测 API 设计"
    dod: "RESTful API 列表 + 请求/响应示例 + 错误码表"
    est_steps: 8
silence_ack_seconds: 300        # 必填，默认 300（范围 60–300）
status: "5 分钟内无 NACK 则开始 Fork"  # 必填
```

**可选字段**: `est_steps` 为可选（不提供则视作步骤数未知）

---

### §3.4 brief_echo — 简报复述（首条消息）

**触发**: 收到 5 件套后，开工前必须发送

**必填字段**: `event`, `my_understanding`, `milestones_preview`

```yaml
event: brief_echo
my_understanding:               # 必填，用自己的话复述
  parent_intent: "为南大软件编程课 24 秋写一份完整 PRD"
  my_mission: "完成实验评测模块的需求规格，含学生提交→评测→反馈闭环"
  in_scope:
    - "学生提交代码 → 自动评测 → 反馈分数"
    - "教师端：查看评测日志、调整测试用例"
  out_of_scope:
    - "课程内容本身（其他模块负责）"
    - "成绩录入教务系统（属于成绩模块）"
  dod_essence: "产出 docs/prd/experiment-eval.md（≥2000 字，含评测流程图/异常处理/API 列表），Mermaid 可渲染"
milestones_preview:             # 必填，至少 1 项
  - "M1: 评测流程图初稿（输出 flow.mmd）"
  - "M2: API 列表（输出 api.yaml）"
  - "M3: 异常处理方案（输出 error-handling.md）"
```

**可选字段**: `my_understanding.why_this_exists`（可选，说明此任务存在的理由）

> **⚠️ v0.7 批次5 (V5b) done 前置 — alignment 回填**：worker 的 brief_echo 本身不带 alignment（alignment 是 commander/独立 auditor 的对齐评估产物）。但 worker 要 `set-status done`，引擎要求 events 中**必须存在一条带 `alignment + auditor_session_id` 的 brief_echo event**（由母会话/独立 auditor 收到你的首条 brief_echo、评估对齐后回填）。若卡在"audit pass 被拦 E_ALIGNMENT_NOT_VERIFIED"，说明 commander 还没回填 alignment——请上行 `blocked` 提示母会话补 alignment 评估，**不要自己伪造 alignment**（auditor 必须独立，伪造会被拦）。
>
> **冷启动期（2026-07-07 补）**：母会话在冷启动期会用 `root.session_id` 直接当 alignment+audit_gate auditor（引擎信任锚，详见 tree-commander SKILL §13）。这正常，worker 不必担心 auditor 是"母会话自己"——root 作信任锚是引擎允许的例外。worker 仍只需：发首条 brief_echo（无 alignment）→ 干活 → done 上报，alignment 回填和 audit_gate pass 由母会话（root 身份）完成。

---

## §4 内部自审流程（v0.2 必须）

> 对应设计文档: §10.4 内部自审流程, §3.5 自审契约

### §4.1 触发时机

每次 `milestone set-result` 后**立即**触发。不可跳过。

### §4.2 检测者

会话内自 Fork 的 `code-reviewer` 子 Agent（`subagent_type=code-reviewer`），同步返回判定。

### §4.3 审计 Prompt 模板

```text
审计里程碑 <Mi.id> 的产出是否与任务 brief/dod 对齐。

brief:
  parent_intent: <brief.parent_intent>
  my_mission: <brief.my_mission>
  in_scope: <brief.in_scope>
  out_of_scope: <brief.out_of_scope>

dod:
  deliverables: <dod.deliverables>
  quality_gates: <dod.quality_gates>

当前里程碑:
  id: <Mi.id>
  desc: <Mi.desc>
  expect_outputs: <Mi.expect_outputs>

产出路径: <实际产出文件路径>

检查点:
  1. 产出是否覆盖 Mi.desc 描述的全部内容
  2. 是否有偏离 brief.in_scope 的内容
  3. 产出质量是否达到 dod.quality_gates 的最低标准
  4. 如涉及 auto_test，检查退出码和 stdout 摘要

输出格式（严格 JSON）:
{
  "alignment": <0-100 整数>,
  "gaps": ["<差距描述1>", "<差距描述2>"],
  "severity": "low|mid|high",
  "suggestion": "<修正建议，severity=low 时可省略>"
}
```

### §4.4 处理逻辑

```
自审 Agent 返回 verdict:

  if verdict.severity == "low":
    → 通过。记录后进入下一个里程碑

  elif verdict.severity == "mid" or verdict.severity == "high":
    → 按 verdict.suggestion 自纠
    → 再次调用自审 Agent（第 2 次）
    → 第 2 次仍 mid+:
        → 不再纠（达到 max_self_corrections=2）
        → 标记 drift，在最终 done 上报时 drift_declaration=true
```

### §4.5 drift_history 写入

> 通过上行事件传达给指挥官，由指挥官调 `tree-state.js drift append`

| 场景 | kind | severity | action |
|---|---|---|---|
| 自纠成功（第 1/2 次修正后 low） | production | low | self_correct |
| 2 次自纠后仍 mid+，上报声明 | production | mid | declare |

---

## §4.6 done 前 G1-G5 多子Agent 内容审查（ISS-003，review_required=true 时强制）

> 对应引擎硬约束：`cmdLeafSetStatus` done 门禁校验 events[] 须含 ≥1 条 `review_round` 事件（schema + 末轮 red_count===0 + 总轮数≤3）。
> 2026-07-07 重写（SubAgent 入树）：reviewer 走 `reviewer_kind:subagent` + `reviewer_ref=sub:<本leaf>:<序号>`，由本 leaf 上的 `subagent_spawn` 事件溯源；不再用 `reviewer_session_id` 填假 UUID（subagent 分支靠 `reviewer_ref` 溯源，不用 session_id；⚠️ 注意：若误把 `reviewer_kind` 写顶层导致缺省走 session 分支，**合法格式的占位 UUID 能过**——见下方 2026-07-16「schema 位置红线」nanju05 事故）。与 §4.2 互补：§4.2 是每个 Mi 后的快速单 Agent 对齐自检；§4.6 是全部 Mi 完成后、done 前的多视角内容审查收敛。

**触发条件（两个独立条件，满足任一即必须跑 §4.6，不可跳过）**：
1. **引擎强制**（worker 不需自检此字段）：done 门禁读 `leaf.audit_meta.review_required`（叶级覆盖）→ `state.audit_meta.review_required`（树级回退）→ 默认 false。commander 建 tree 时通过 `audit_meta_override` 设 `review_required=true` 让门禁触发 review_round 校验。
2. **worker 主动自检触发**（不等 review_required=true）—— 产出属以下任一即**必须主动**跑 §4.6 自审：
   - 设计文档 / API 规格 / 架构文档 / PRD / 数据模型等**正式交付物**
   - 跨文件交付（≥2 文件）
   - 单文件 ≥1000 字（架构级 / 重要业务逻辑）

> 🔴 **自审事故教训（2026-07-15 链 A）**：worker 产 API 设计文档（属条件 2"设计文档级"），但 `review_required=false`，worker **没主动**开 §4.6 → 全程无自审，4 worker 全 done 但产物无质量防线。**不要等 review_required=true**——产出类型自检命中条件 2 即主动开。条件 2 是 worker 自己的判断（不是 commander 的），是质量防线。

**与 §4.2 的关系**：§4.2 不废弃（仍用于 milestone 级快速自检），但 review_required=true 时 done 前必须**额外**跑 §4.6。审计角色（§10，commander 派 leaf 模式）是另一条独立链，不冲突。

**SubAgent 在树体系中的定位**：SubAgent **不是树实体**（无 leaf_id / 无 Proma session_id），是 worker 本 leaf **事件溯源**的劳动单元。worker 永远是自己 leaf 的 actor（caller-binding 不变）；SubAgent 通过 worker 在自己 leaf 上 append 的 `subagent_spawn` 事件被树"看见"。因此 §4.6 的 reviewer 是"worker 自派的代理人"，标注 `independence:self_delegated`（自审 / 第一道筛）。

> ### 🔴 schema 位置红线（2026-07-16 nanju05 事故强制；违者＝自审形同虚设）
>
> **`reviewer_kind` 必须写在每个 reviewer 对象内（reviewer 级），不是顶层 meta。** 引擎读的是 `r.reviewer_kind`（r = `reviewers[]` 每一项），**不读** `meta.reviewer_kind`。写错位置的后果链：
> 1. `reviewer_kind` 写顶层 → 每个 reviewer 的 `r.reviewer_kind`=undefined → 引擎**缺省 `'session'` 分支**
> 2. session 分支只校验 `reviewer_session_id` 是合法 UUID 格式（8-4-4-4-12 hex，不校验版本位）+ ≠本leaf.session_id + ≠added_by（**by design 不校验存在性**——引擎注释明说"内容真实性靠 commander 抽样"，见 tree-engine L1451）
> 3. worker 给每个 reviewer 填**任意 8-4-4-4-12 hex 格式的占位 UUID**（如 `11111111-1111-4111-8111-111111111111`；UUID_RE `/^[0-9a-f]{8}-...{12}$/i` **不校验版本位**，全 1 / 全 5 / 任意 hex 均凑过）→ session 分支放行 → done 门禁通过
> 4. 结果：`review_round` 形式合规，但 **SubAgent 自审根本没被引擎溯源验证**（没走 subagent 分支查 subagent_spawn），自审防线被架空
>
> **正确做法**（worker 自审 SubAgent 一律走 subagent 分支）：
> - 每个 reviewer 写 `reviewer_kind: subagent` + `reviewer_ref: "sub:<本leaf_id>:<序号>"`（**都在 reviewer 对象内**）
> - **禁用 session 分支**（v0.18 引擎硬拦）：worker 自审**一律走 subagent 分支**，**禁用 `reviewer_kind:session`**——worker 用 session 分支会被引擎抛 **`E_REVIEW_SESSION_FORBIDDEN`**（append 时即时拦 + done 门禁双校验）。无论 `reviewer_session_id` 是占位 UUID 还是**借来的真实 session_id**（来自另一 leaf 的 session，≠本leaf.session_id 且≠added_by，引擎同样放行；且 list_messages 能查到真实对话，伪装比占位 UUID 更深）。session 分支=以 `reviewer_session_id` 标识的他审者（设计意图=独立第三方真 session 复核，如 commander fork 真 session；但引擎 **by design 不校验 session 存在性**，故该分支既能被真他审者用、也能被占位/借真 UUID 蒙混——这正是 worker 须禁用它的原因；注：auditor 的复核走 audit_gate/alignment 独立简化协议，不经 review_round）；worker 是 leaf owner 无独立他审 session，故 session 分支不适用
> - **禁任何占位 UUID**：哪怕格式合法（引擎只校验格式不校验存在性），填了=伪造审查
>
> ❌ **错误写法（nanju05 实证，勿抄）**：
> ```yaml
> # 错：reviewer_kind 写顶层 + reviewer 填占位 session_id
> - type: review_round
>   meta:
>     reviewer_kind: subagent          # ← 错！引擎不读顶层，读 reviewer 级
>     reviewers:
>       - perspective: G1
>         reviewer_session_id: "11111111-1111-4111-8111-111111111111"  # ← 占位合法UUID，蒙混 session 分支
> ```
> ✅ **正确写法**：reviewer_kind + reviewer_ref 都在每个 reviewer 对象内（见本节末「subagent_spawn + review_round 完整示例」）。

> ### ⚠️ 调用形式红线（2026-07-08 调用形式事故强制；违者＝成本爆炸）
>
> **SubAgent 必须用内置 `Agent` 工具**（进程内 SDK subagent，`CLAUDE_CODE_ENABLE_TASKS=true` 已开启 → 不建 Proma 会话、不进侧边栏、只花 token）：
> ```
> Agent(description:"G1 完整性审查", prompt:"<视角专属指令，读 deliverables/<文件>，返回 findings JSON [{item,severity,evidence≥10字}]>", subagent_type:"Explore")
> ```
> **🚫 严禁** `mcp__session__create_session` / `fork_session` / `mcp__collaboration__delegate_agent`(delegate_agents) 当 reviewer —— **建真实会话＝烧独立 API 额度**（既往调用形式事故：短时炸百级会话，某模型额度耗尽）。
>
> **撞错（`E_DUPLICATE_SESSION_ID` / `E_MAX_SESSIONS` 等）修根因，禁换名（v2/b/x）重试新建会话**（换名重试循环放大器）。
>
> **收敛条件（成本有界，对齐 commander SKILL §13.5）**：
> - **角色数按交付物分档**：2/3/5（**上限 5**），最小档 ≥2（禁单角色 = 禁自审自批）。字数/文件数分档细则见下方"执行步骤 1"。
> - **轮数 ≤3**：末轮 `red_count=0` 即收敛停；3 轮未收敛则**上行 `blocked`（commander 接管）而非无限重试**。
> - **🚫 禁止靠新建会话重试**：未收敛时新建 reviewer session = 成本爆炸。
> - `total = 角色数 × 轮数`，有界可预算。
>
> **预算护栏（硬上限）**：tree `audit_meta.max_sessions` + worker `max_subagent_spawn`。撞上限 → 修根因（任务范围 / 分档 / 未释放的旧 session），禁换名重试。

**执行步骤**（最多 3 轮，红色归零收敛）：

1. **分档决定 reviewer 数量**（按交付物总字数/文件数，避免小任务过重）：
   - < 1000 字或单文件小改 → 2 reviewer（G1 完整性 + G3 可执行性）
   - 1000–5000 字或跨 2-3 文件 → 3 reviewer（G1 + G2 一致性 + G3）
   - \> 5000 字或跨多文件/架构级 → 5 reviewer（G1-G5 全视角）

2. **并行 spawn N 个 SubAgent**（**必须用上面红线的 `Agent` 工具，进程内；🚫禁 `create_session`/`fork_session`/`delegate_agent`**），每个分配一个视角：
   - **G1 完整性**：交付物是否覆盖 brief.my_mission / dod.deliverables 全部要求
   - **G2 一致性**：交付物内部 / 跨文件是否自洽（命名、接口、术语）
   - **G3 可执行性**（红色必改）：能否跑/编译/通过测试；命令、依赖、路径是否正确
   - **G4 可读性**：结构、表达、受众适配
   - **G5 格式合规**（红色必改）：对照 dod.quality_gates 逐项

   每个 SubAgent prompt 给出 brief / dod / milestone / 产出路径，要求**只提 findings，不重写**，每条 finding 标 `severity: red|yellow|green` + `evidence`（≥10 字，引用具体位置）。

3. **每个 SubAgent 产出必须落盘**到 `<treeDir>/deliverables/subagent-outputs/sub-<自己leaf_id>-<序号>.md`（含该 perspective 的 findings 列表）。序号从 `01` 起，两位数。**禁止只把 findings 留在 SubAgent 返回值里不落盘**——后续 `subagent_spawn` 事件 `status=done` 时引擎会校验 output_ref 文件存在且 size>0（否则 `E_DELIVERABLE_MISSING` / `E_DELIVERABLE_EMPTY`）。

4. **每个 SubAgent 对应 append 一条 `subagent_spawn` 事件到本 worker leaf**（`mcp__tree__tree_event_append`）：
   - `tree_id` / `leaf_id` = 本 worker 自己的 tree_id / leaf_id
   - `type` = `subagent_spawn`
   - `meta`:
     - `subagent_id` = `sub:<自己leaf_id>:<序号>`（如 `sub:rvreq1-A1-worker:01`）。**父段必须 = 本 leaf_id**，否则引擎 `E_SCHEMA_INVALID`。
     - `role` = `review`
     - `perspective` = `G1` / `G2` / `G3` / `G4` / `G5`（review 角色必填）
     - `purpose` = 非空，一句话说明这个 SubAgent 干什么（如 "G1 完整性审查：覆盖 brief.my_mission 全部要求"）
     - `output_ref` = 相对 **deliverables 根**的路径（如 `subagent-outputs/sub-rvreq1-A1-worker-01.md`）。引擎解析为 `<treeDir>/deliverables/<output_ref>` 校验存在 + size>0。
     - `status` = `done`（产出落盘成功）或 `failed`（SubAgent 失败，可省 output_ref）

   > ⚠️ **append 即校验**（2026-07-08 既往复盘改）：`subagent_spawn` 和 `review_round` 在 `event_append` 时**当场校验 schema**——格式错立即 `E_REVIEW_FORGERY`/`E_SCHEMA_INVALID`，**不会静默写入后卡 done 门禁**（events append-only 删不掉；既往事故早期坏 review_round 曾导致 status 永久卡 active）。严格按下方格式 + 禁止清单写，一次过。
   > alignment 对齐评估走 **`brief_echo` event**（`type=brief_echo, meta={alignment, auditor_session_id}`），**没有** `alignment` 事件类型（写了 → `E_SCHEMA_INVALID`）。

5. **收集 N 份 findings → 写 review_round event**（`mcp__tree__tree_event_append`，仍 append 到本 worker leaf）：
   ```yaml
   event: review_round
   meta:
     round_no: 1
     reviewers:
       - reviewer_kind: subagent              # 新字段：subagent = 自派代理人（溯源本 leaf 的 subagent_spawn 事件）
         reviewer_ref: "sub:rvreq1-A1-worker:01"   # = 对应 subagent_spawn 的 subagent_id；父段必须=本 leaf_id
         perspective: G1
         findings:
           - { severity: red, item: "评测流程图缺异常分支", evidence: "flow.mmd 第3段未画 timeout 分支，与 error-handling.md 不一致" }
           - { severity: green, item: "API 列表完整", evidence: "api.yaml 覆盖 brief 要求的 8 个端点" }
       - reviewer_kind: subagent
         reviewer_ref: "sub:rvreq1-A1-worker:02"
         perspective: G3
         findings:
           - { severity: yellow, item: "评测命令缺超时参数", evidence: "run.sh 第 5 行 timeout 未设置，长任务可能挂死" }
     red_count: 1
     converged: false
     independence: self_delegated              # worker 自派 SubAgent 审自己 = 自审 / 第一道筛；诚实标注
   ```
   ⚠️ **字段约束**：
   - `reviewer_kind:subagent` 时**必须**给 `reviewer_ref`（sub:... 格式），**禁止**给 `reviewer_session_id`（互斥，给了 → `E_REVIEW_FORGERY`）。
   - 引擎溯源：本 leaf events 中**必须**有 `type=subagent_spawn` 且 `meta.subagent_id === reviewer_ref` 的事件；无匹配 → `E_REVIEW_FORGERY`（"reviewer_ref 无对应 subagent_spawn，涉嫌伪造"）。
   - `reviewer_kind:session`（旧路径，他审 / 独立 reviewer）保留向后兼容：走 `reviewer_session_id` + UUID_RE + ≠本leaf.session_id + ≠added_by。**注意（A3 审计修正）**：引擎 session 路径**只校验 UUID 格式合法性**（UUID_RE + ≠本leaf.session_id + ≠added_by），**不校验真实性/liveness**（不调 `checkSessionAlive`，因 SDK SubAgent 无真 session_id，强查会误杀）。所以 worker 若走 session + **格式合法的假 UUID**，引擎**会放行**——但 **SKILL 明确禁止 worker 这么做**（worker §4.6 自审场景**必须**用 `reviewer_kind:subagent`，诚实路径），且 commander 他审会 `list_messages` 抽查 `reviewer_session_id` 真实性兜底（§4 Step4）。worker 走 session+假 UUID 蒙混属伪造审查记录，违反 worker 契约。

6. **若末轮 red_count > 0** → 按 findings 自改 → 再 spawn N 个 SubAgent（新序号 03/04/..，同样落盘 + append subagent_spawn）→ 写 round 2 → …
7. **最多 3 轮**：red_count=0 即收敛（converged: true）→ 可 done；3 轮仍红 → 不再循环，上行 `blocked` 请求 commander 介入（引擎拦截 total_rounds>3 的 done）。

**`subagent_spawn` + `review_round` 完整示例（可直接复制）**：

假设 worker `leaf_id=rvreq1-A1-worker`，5 reviewer（G1-G5），deliverables 根 = `<treeDir>/deliverables/`。先写 5 个 findings 文件到 `<treeDir>/deliverables/subagent-outputs/sub-rvreq1-A1-worker-01.md` ~ `-05.md`，然后：

```yaml
# 步骤 A：5 条 subagent_spawn 事件（append 到本 worker leaf）
- type: subagent_spawn
  meta:
    subagent_id: "sub:rvreq1-A1-worker:01"
    role: review
    perspective: G1
    purpose: "G1 完整性审查：交付物是否覆盖 brief.my_mission / dod.deliverables 全部要求"
    output_ref: "subagent-outputs/sub-rvreq1-A1-worker-01.md"
    status: done

- type: subagent_spawn
  meta:
    subagent_id: "sub:rvreq1-A1-worker:02"
    role: review
    perspective: G2
    purpose: "G2 一致性审查：交付物内部 / 跨文件是否自洽"
    output_ref: "subagent-outputs/sub-rvreq1-A1-worker-02.md"
    status: done

- type: subagent_spawn
  meta:
    subagent_id: "sub:rvreq1-A1-worker:03"
    role: review
    perspective: G3
    purpose: "G3 可执行性审查（红色必改）：命令/依赖/路径是否正确"
    output_ref: "subagent-outputs/sub-rvreq1-A1-worker-03.md"
    status: done

- type: subagent_spawn
  meta:
    subagent_id: "sub:rvreq1-A1-worker:04"
    role: review
    perspective: G4
    purpose: "G4 可读性审查：结构/表达/受众适配"
    output_ref: "subagent-outputs/sub-rvreq1-A1-worker-04.md"
    status: done

- type: subagent_spawn
  meta:
    subagent_id: "sub:rvreq1-A1-worker:05"
    role: review
    perspective: G5
    purpose: "G5 格式合规审查（红色必改）：对照 dod.quality_gates 逐项"
    output_ref: "subagent-outputs/sub-rvreq1-A1-worker-05.md"
    status: done

# 步骤 B：1 条 review_round 事件（append 到本 worker leaf）
- type: review_round
  meta:
    round_no: 1
    reviewers:
      - reviewer_kind: subagent
        reviewer_ref: "sub:rvreq1-A1-worker:01"
        perspective: G1
        findings:
          - { severity: red, item: "评测流程图缺异常分支", evidence: "flow.mmd 第3段未画 timeout 分支，与 error-handling.md 不一致" }
          - { severity: green, item: "API 列表完整", evidence: "api.yaml 覆盖 brief 要求的 8 个端点" }
      - reviewer_kind: subagent
        reviewer_ref: "sub:rvreq1-A1-worker:02"
        perspective: G2
        findings:
          - { severity: yellow, item: "术语混用", evidence: "design.md 用 '评测'，api.yaml 用 '评估'，需统一" }
      - reviewer_kind: subagent
        reviewer_ref: "sub:rvreq1-A1-worker:03"
        perspective: G3
        findings:
          - { severity: red, item: "评测命令缺超时", evidence: "run.sh 第 5 行 timeout 未设置" }
      - reviewer_kind: subagent
        reviewer_ref: "sub:rvreq1-A1-worker:04"
        perspective: G4
        findings:
          - { severity: green, item: "结构清晰", evidence: "三级标题 + 每节有摘要，符合读者预期" }
      - reviewer_kind: subagent
        reviewer_ref: "sub:rvreq1-A1-worker:05"
        perspective: G5
        findings:
          - { severity: yellow, item: "Mermaid 主题未配", evidence: "flow.mmd 未声明 theme，与 quality_gates 第 2 条 '统一暗色主题' 不符" }
    red_count: 2
    converged: false
    independence: self_delegated
```

第 2 轮：worker 自改 red 项 → spawn 序号 06/07/.. 的 SubAgent 复审 → 写 round_no=2，直到某轮 red_count=0 + converged:true。done 门禁放行。

**诚实声明（reviewer_kind:subagent + independence:self_delegated 的语义）**：

`reviewer_kind:subagent` 标记的 reviewer 是 **worker 自审 / 第一道筛**——SubAgent 是 worker 自己派的代理人，不是独立第三方。引擎能保证：① reviewer_ref 真能溯源到本 leaf 上的一条 subagent_spawn；② 该 SubAgent 有非空产出（size>0，治 BUG-3）。但引擎**不校验**findings 内容真实性（worker 仍可写全 green 蒙混）。**引擎硬拦 backlog**（当前靠 commander §4 Step4 他审兜底，未来补引擎校验）：① reviewer_kind 位置错（顶层 vs reviewer 级，引擎缺省 session 不报错）；② session 分支不校验 `reviewer_session_id` 存在性/归属（占位或借真 UUID 均过）；③ findings 内容真实性（全 green 蒙混）。

**真实的内容防线是 commander 他审**（见 tree-commander SKILL §4 Step4）：commander 验收时会把 worker 的 review_round 当作"自审视图"对待，独立判断 findings 是否与产出文件相关；commander 可派自己的 SubAgent（记 commander leaf）做独立复核（independence:independent）。worker 不得用 `reviewer_kind:session` 冒充独立 reviewer：session 分支引擎**只校验 UUID 格式 + 非自审，不校验存在性**（by design——合法格式的占位 UUID 能过，这正是上方「schema 位置红线」要堵的 nanju05 事故）。worker 没有第二个真实 session，故**必须走 subagent 分支**（`reviewer_ref` 溯源 subagent_spawn），让引擎能验证 SubAgent 确实 spawn 过、确有产出。

**禁止**：
- `reviewer_kind:subagent` 缺 `reviewer_ref`，或 `reviewer_ref` 父段 ≠ 本 leaf_id（`E_SCHEMA_INVALID` / `E_REVIEW_FORGERY`）
- `reviewer_kind:subagent` 同时给 `reviewer_session_id`（互斥，`E_REVIEW_FORGERY`）
- `reviewer_ref` 指向不存在的 `subagent_spawn`（`E_REVIEW_FORGERY`）
- SubAgent 产出文件缺失（`E_DELIVERABLE_MISSING`）或 0 字节（`E_DELIVERABLE_EMPTY`，治 BUG-3）
- findings 为空或 evidence < 10 字（`E_REVIEW_FORGERY`）
- 跳过审查直接 done（`E_REVIEW_NOT_CONVERGED`）
- 用假 UUID 填 `reviewer_session_id` 冒充独立 reviewer（旧 BUG-1 路径）——⚠️ 引擎只拦**格式非法**的 UUID，**合法格式的占位 UUID（如 `11111111-1111-4111-8111-...`）能过 session 分支**，见上方「schema 位置红线」nanju05 事故；故 worker 自审必须走 subagent 分支
- `reviewer_kind` 写在顶层 `meta`（必须在每个 reviewer 对象内）——引擎读 `r.reviewer_kind`，顶层不读，缺省走 session 分支架空自审（nanju05 事故）

---

## §5 决策笔记模板（.note.md）

> 对应设计文档: §6.3 决策日志

每个里程碑产出文件旁必须附带 `<产出名>.note.md`（≤ 50 行），模板：

```markdown
---
milestone: M2
topic: api-style
reversible: true
---

## 可选方案

- REST
- GraphQL
- RPC

## 选择

REST

## 理由

学生群体更熟悉 RESTful 风格，与现有教案对接成本最低。GraphQL 虽灵活但学习曲线对课程无增益。RPC 过于底层不适合教学场景。

## 触发重审条件

课程组反馈接口散乱 > 3 次则切换至 RPC
```

**约束**:

| 字段 | 必填 | 说明 |
|---|---|---|
| `milestone` | 是 | 关联的 milestone id |
| `topic` | 是 | 决策主题，简短标签 |
| `reversible` | 是 | true/false，决策是否可逆 |
| 可选方案 | 是 | ≥ 2 个考虑过的方案 |
| 选择 | 是 | 最终采用方案 |
| 理由 | 是 | 为什么选这个 |
| 触发重审条件 | 否 | 什么条件下重新评估此决定 |

---

## §6 上下文最小化规则（3 条）

> 对应设计文档: §6.4 上下文最小化

| # | 规则 | 实现 |
|---|---|---|
| 1 | **不留一次性大输出** | 产出大文件后，只保留路径 + 摘要，不把文件内容塞进对话历史 |
| 2 | **不重复读已读文件** | 已读文件路径 + 摘要记录在 `working_notes/files_index.md` |
| 3 | **超甜点 85% 主动声明** | 检测到 context_usage ≥ 85% 时，在最近一次上行消息中附带 `context_usage` 字段，让哨兵 Agent 接管竹节交接 |

**附加**: 若收到指挥官竹节交接指令，输出任务简报（≤ 2K tokens）：进度 + 关键发现 + 未完成 milestones，供新会话接收。

---

## §7 禁止行为清单（12 条）

> 综合设计文档全部约束 + v0.1 审计报告发现

| # | 禁止行为 | 来源 |
|---|---|---|
| 1 | 第一条消息发任何非 brief_echo 内容 | §6.1 |
| 2 | 无 milestones 直接开始执行 | §3 契约纪律 |
| 3 | 跳过里程碑自审（v0.2） | §10.4 |
| 4 | 产出里程碑但不附带 .note.md | §6.3 |
| 5 | done 上报缺 self_check 或 quality_gates 执行结果 | §6.2 |
| 6 | 发非结构化（散文式）上行消息 | §4.2 |
| 7 | 直接读取或写入 tree-state.json 文件 | 补丁 4 / §1 铁律 8 |
| 8 | 改动 brief.out_of_scope 的内容而不请示 | §3.4 autonomy |
| 9 | 改动 DoD 的 deliverables 路径或 quality_gates 项而不请示 | §3.4 autonomy |
| 10 | 使用 done/blocked/plan/brief_echo 之外的事件类型 | §4.2 |
| 11 | 在 brief_echo 未放行前开始产出实际文件 | §6.1 |
| 12 | 重复读取已读过的文件（不做 files_index.md 记录） | §6.4 |

---

## §8 命名规范摘要

> 对应设计文档: §6.5 命名规范（worker 视角精简版）

工人只需记住自身 `leaf_id` 的格式约束：

```
<prefix>-<path>-<role>[-<suffix>]
```

| 段 | 约束 | 示例 |
|---|---|---|
| `prefix` | 小写字母开头，4–8 字符，仅含 `[a-z0-9_]`，不含连字符 | `nanju`, `pguide`, `webv3` |
| `path` | 树定位：根为空，子为 A/B/C，孙为 A1/A2，曾孙 A1a/A1b | `A`, `B1`, `A1a` |
| `role` | 角色短名，可含连字符 | `eval`, `api`, `ui` |
| `suffix` | 可选。`s<N>` 表竹节 / `i<N>` 表尝试序号 | `s2`, `i3` |

**示例**: `nanju-A-eval` = nanju 项目第 1 子（A）执行评测模块；`nanju-B1b-engine` = B 的第 1 孙的第 2 次尝试（评测引擎）。

工人**不需要**记忆完整正则，但必须确保自己的 `leaf_id` 符合上述段约束。`prefix` 由根会话首次激活时生成、Fork 时自动继承，工人无需自行生成。

> 🔴 **prefix 超长会潜伏卡死（超长命名事故 2026-07-15）**：commander 建树时若用了 >8 字符 prefix（如某 10 字符超长名），引擎 init/leaf_add 会 `E_NAME_INVALID` 拦截（worker 进不来 / leaf 不入树，但 send_message 可能已发出 → 产了文件但 leaf 不存在 → 死锁）。worker 收到 send_message 后第一件事是 `tree_leaf_get`，若返回 `E_LEAF_NOT_FOUND` / `E_NAME_INVALID` → **立即上行 `blocked`** 告知 commander "leaf_id prefix 非法，请改 ≤8 字符重建"，不要继续产文件。

---

## §10 审计角色（v2.1；P0a 2026-07-08 更新为 role=auditor）

> 依据：tree-audit-methodology.md v1.0。当你的 role 或 brief.my_mission 涉及审查/审计/验证/终局时，**必须**按本节执行。
>
> **P0a 更新**：审计角色现在用独立的 `role='auditor'` leaf（不再用 worker 假装，既往假阳性事故实证 + W-AUDIT-WORKER 违规）。创建流程见 tree-commander SKILL §13.4。auditor leaf 走**简化协议**（brief_echo+done+audit_gate，无 milestone/review_round/deliverables），其 audit_gate=pass 由 root 信任锚背书（冷启动期）或上级 auditor 背书（正常期）。如果你被 fork 为 auditor role，本节是你的操作手册。

### §10.1 触发判定

收到 5 件套后，检查以下条件，任一满足即进入审计角色：
- `brief.my_mission` 含 "审查/审计/验证/终局/review/audit/verify/converge"
- `leaf_id` 的 role 段为 `C1/C2/C3/C4/A1/A2/verify/review/audit`
- brief.in_scope 第一条含 "按方法论阶段"

### §10.2 auditor role 的核心区别（vs 常规 worker）

| 常规 worker（role=worker） | 审计角色（role=auditor） |
|------------|------------|
| 自己产出文档/代码 | **不产出交付物，只产出问题列表 + audit_gate verdict** |
| done 走完整门禁（milestone+deliverables+review_round） | **done 走简化协议（brief_echo+done+audit_gate，无 milestone/deliverables）** |
| audit_gate 由独立 auditor 背书 | **audit_gate 由 root 信任锚或上级 auditor 背书**（不能自审，行 2478 拦） |
| 1 个 self_check 即够 | **鼓励 Fork SubAgent 做多维并行审查**（SubAgent 用内置 Agent 工具，§13.5 红线） |
| done 后指挥官验收 | **done 后由指挥官汇总多审计员结果** |
| 不做反事实攻击 | **攻击角色必须构造破坏性场景** |

### §10.3 auditor 的最小审查结构（Fork SubAgent 做多维审查）

> auditor role 的审查劳动通过 `subagent_spawn` 事件归因（§13.5）。SubAgent **必须用内置 Agent 工具**（进程内，🚫禁 create_session/delegate_agent，调用形式红线）。

**如果你是审查员（C1-C4）**：你 Fork 1 个 SubAgent 执行具体审查。

```
审查员 auditor（你）
  └── Fork 1 个 SubAgent：按你的维度执行具体审查
        产出：结构化问题列表，每个问题含 ID/定位/严重程度/描述/修正建议
```

**如果你是攻击员（A1-A2）**：你必须 Fork 2 个子 Agent 并行攻击。

```
攻击员 auditor（你）
  ├── Fork SubAgent 1：角色视角攻击（每个角色 3 个"如果...怎么办"）
  ├── Fork SubAgent 2：契约边界攻击（每条验收标准 1-2 个边界外输入）
  └── 汇总产出攻击报告
```

### §10.4 auditor done 上报格式（简化协议，无 milestone/deliverables）

```yaml
event: done
self_check:                      # schema = [{item,pass,evidence}]，evidence ≥10 字，缺则 E_SELFCHECK_INVALID
  - item: "已 Fork SubAgent 执行审查（非自己直接判断）"
    pass: true
    evidence: "Agent(G1 完整性审查) 返回问题列表，subagent_spawn 事件已 append 留痕"
  - item: "问题列表含 ID/定位/严重程度/描述/修正建议 5 字段"
    pass: true
    evidence: "审查报告第 2-47 行每条问题均含 ID（P1-P23）/定位（文件:行）/severity/desc/fix 五列"
  - item: "标注了每个严重程度的判断理由"
    pass: true
    evidence: "报告 severity 列每项后括注理由，如 'high（阻断：API 缺 auth 校验，见 §3.2）'"
# auditor 简化协议：无 milestones / 无 deliverables / 无 review_round
# audit_gate 由 root 或上级 auditor 背书（不是自己 set）
context_usage: <数字>
drift_declaration: false
```

### §10.5 审计禁止行为

| # | 禁止行为 | 后果 |
|---|---------|------|
| 1 | 审查员自己读完文档直接写结论，不 Fork 子 Agent | 单维度推理惯性，审计不可采信 |
| 2 | 攻击员和审查员是同一个子会话 | 攻击心态与建设心态冲突 |
| 3 | 审计报告缺少结构化问题列表（无 ID/定位/严重程度） | 无法追溯，视为无效 |
| 4 | done 上报 self_check 中未确认"已 Fork 子 Agent" | 退回重做 |

---

## §11 修订历史

| 日期 | 版本 | 主要变更 |
|------|------|---------|
| 2026-07-25 | v2.6 | **P1-C set-status caller 铁律 + lifecycle 衔接警示**：§1 铁律新增 #10（set-status done 必须 worker 自己调，commander 代调→E_BORROWED_IDENTITY）；§2.5 lifecycle 阶段 8→9 之间加醒目衔接规则（audit_gate pass 本身就是“可以 set-status”的信号，不要等 commander 通知）。配合 tree-commander v2.9.2 P1-C 改动。 |
| 2026-07-16 | v2.5.1 | **nanju05 schema 位置事故修复**：§4.6 加【schema 位置红线】——`reviewer_kind` 必须写在每个 reviewer 对象内（reviewer 级，对齐引擎 `r.reviewer_kind`），写顶层 meta → 引擎缺省走 session 分支 → 合法格式占位 UUID（`11111111-1111-4111-8111-`）蒙混放行（nanju05 实证，自审形同虚设）；worker 自审必走 subagent 分支（`reviewer_ref` 溯源 subagent_spawn），禁 session 分支/任何占位 UUID；修 §4.6 末尾"session 分支已被引擎拦截"过乐观表述（引擎 by design 只校验格式不校验存在性，内容真实性靠 commander 抽样） |
| 2026-07-08 | v2.5 | **调用形式事故修复**：§4.6 加【调用形式红线】——SubAgent 必须用内置 `Agent` 工具（进程内）；🚫禁 `create_session`/`fork_session`/`delegate_agent` 当 reviewer（成本爆炸，既往调用形式事故）；撞错禁换名重试；收敛（角色 2/3/5 + 轮≤3 + red_count=0 停） |
| 2026-07-07 | v2.4 | SubAgent 入树：§4.6 重写——reviewer 走 `reviewer_kind:subagent` + `reviewer_ref=sub:<本leaf>:<序号>`（溯源本 leaf 的 `subagent_spawn` 事件），不再用 `reviewer_session_id` 填假 UUID（旧 BUG-1 路径已被引擎 E_REVIEW_FORGERY 拦截）；标注 `independence:self_delegated`（worker 自审/第一道筛，内容真实性最终靠 commander 他审）。新增 §2.5.1 SubAgent 辅助（implement/research SubAgent 同样走 subagent_spawn）；新增 §2.6 路径语义（治 BUG-2：expect_outputs / output_ref 均相对 deliverables 根，禁带 `deliverables/` 前缀）；§3.1 加 SubAgent 诚实性提醒；引擎新错误码 `E_DELIVERABLE_EMPTY`（治 BUG-3：0 字节产物）。 |
| 2026-07-04 | v2.3 | ISS-003：新增 §4.6 done 前 G1-G5 多子Agent 内容审查（review_required=true 时强制，含分档/红色归零/最多3轮/已知局限诚实标注）。与 §4.2 milestone 级自检互补不冲突 |
| 2026-06-19 | v2.2 | 审计驱动修订：load_on 从 fork_session 修正为 create_session（原则 11：叶子 = create_session）；target 描述明确子 Commander 由 fork_session 创建 |
| 2026-06-19 | v2.1 | 新增 §10 审计角色（触发判定、最小 Fork 结构、审计 done 格式、审计禁止行为）；§0 引用 tree-audit-methodology.md |
| 2026-06-18 | v2.0 | 首次创建。合并 v0.1 9 条铁律 + v0.2 内部自审必须化（铁律 3 从可选升级为必须）；新增 §4 完整自审流程（含 Prompt 模板 + drift_history 写入规范）；done 模板新增 drift_declaration 字段 |
