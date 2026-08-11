---
description: |
  树形会话执行体系 — 指挥官（根会话）操作手册。
  触发场景：建树 / 建开发树 / 建审计树 / 建测试树 / 端到端测试 / e2e / V10 验证 / audit_gate 测试 /
  派子会话 / Fork worker / Fork auditor / 并行 Agent / 多 Agent 协作开发 / 树形任务分解 /
  任何用到 mcp__tree__* 工具的任务（建树后调任何 tree_ 工具前应加载）。
  核心能力：5 件套契约下发 / 事件路由 / 三档纠偏 / 心跳巡检 / 审计树结构 / V10 加固 8 大点。
  工具调用前先 mcp__tree__tree_help(topic) 拿用法，错误返回会附 help_topic 引用。
---

# tree-commander SKILL

树形会话执行体系 — 指挥官（根会话）操作手册。

---

## §0 元数据

```yaml
skill_name: tree-commander
version: 2.9.9-macpaf-closeout
target: 根会话（指挥官）
requires:
  - tree-state.js (v0.7+ 已内联进 mcp__tree__* MCP，工作区不再有源码)
  - commander-methodology.md v1.2                          # 指挥官方法论
  - tree-commander-design.md v1.1                          # 体系设计文档
  - tree-audit-methodology.md v1.0                         # 树形审计方法论（审计任务强制执行）
mcp_dependencies:
  - mcp__session__fork_session / create_session / send_message / list_messages / archive_session
  - mcp__automation__create_automation / get_automation / update_automation
task_tools: TaskCreate / TaskUpdate / Agent
```

> **v0.7+：本 skill 通过 `mcp__tree__*` MCP 工具操作 tree 状态（替代旧的 `node tree-state.js` CLI）。所有工具返回 `{ok, error?, ...result}`，失败时查 `error.code`。引擎代码已内联进 MCP，工作区不再有 tree-state.js 源码。**

---

## §1 铁律（5 条）

> 依据：设计文档 §3 契约纪律 + §4.4 铁律 + §5.3 关键设计；方法论原则 8/9；tree-audit-methodology.md

| # | 措辞 | 依据 |
|---|------|------|
| 1 | **严禁直接读写 tree-state.json** — 所有状态变更必须走 `mcp__tree__*` MCP 工具 | 补丁 4（§A.1）；方法论原则 8 |
| 2 | **必须下发 5 件套契约** — brief / dod / report / autonomy / self_audit 缺一不可 | 设计文档 §3；§3 契约纪律 |
| 3 | **必须走三步质量门** — 实施 → 回归测试 → 审计，缺任一步不算完成 | 方法论原则 3 |
| 4 | **必须三档递进纠偏** — 同一偏差最多 2 次纠正机会，第 3 次必剪枝 | 设计文档 §5.3；方法论原则 9 |
| 5 | **审计任务必须并行多Agent** — 当任务涉及文档审计/验证/终局审查时，必须 Fork ≥4 个独立审查子会话（每人一个维度），禁止单 Agent 包办所有维度。详见 §14 | tree-audit-methodology.md 铁律 1 |

---

## §2 前置检查（加载时执行）

> 依据：设计文档 §8.5 持久化目录结构 + §A.7 init/validate。

指挥官 Skill 加载时，必须执行以下检查：

```text
1. 检查 mcp__tree__* 工具可用:
   任调一个 mcp__tree__* 工具（如 tree_tree_dump）确认返回 {ok:true,...}
   → 返回 {ok:false, error} 则报错，不能继续
   → 若报 "Tool mcp__tree__* not found"（工具根本不在你的工具列表，而非运行报错）:
     ⚠️ 这**不是 bug，是会话运行时不匹配**。tree/session/remote-session 三组 MCP 仅
     **claude 运行时**会话才有；**pi 运行时**会话只有 automation/collaboration/proma_cloud 三组。
     诊断：枚举自己的 mcp__* 工具，若无 session/remote-session/tree → 你是 pi 运行时。
     正解：从 claude 母会话用 **fork_session** 重新派生（fork 继承母会话运行时）。
     根因详见 memory: tree-mcp-pi-runtime-incompat（2026-07-22 定案）。

2. 列出已存在的 tree:
   ls .context/trees/*/    （仍可用文件系统定位 <tree_id>）
   识别子目录名作为 <tree_id> 列表
   对每个 <tree_id> 运行:
     mcp__tree__tree_leaf_list_active(tree_id=<tree_id>)
     输出活跃叶子清单（返回 {ok, leaves:[...]}）

3. 对每个 tree 运行一致性校验:
   mcp__tree__tree_validate(tree_id=<tree_id>)
   → 返回的 issues 非空则打印告警后继续（不阻断）
```

---

## §3 5 件套契约模板

> 依据：设计文档 §3.1-3.5。每条标注必填字段。

下发子会话时，**第一条消息**必须包含以下完整的 5 件套 YAML 模板。直接复制粘贴，仅替换 `<>` 占位符。

### §3.1 任务简报（Brief）

```yaml
brief:
  # ------ 必填 ------
  parent_intent: "<用户/母任务的一句话目标>"
  my_mission: "<本会话的一句话任务>"
  why_this_exists: "<为什么这个子任务存在，缺它整个链条哪里断>"
  in_scope:
    - "<明确边界内的事项 1>"
    - "<明确边界内的事项 2>"
  out_of_scope:
    - "<边界外：必须上报而非自决的事项 1>"
    - "<边界外：必须上报而非自决的事项 2>"
```

### §3.2 DoD（Definition of Done）

```yaml
dod:
  # ------ 必填 ------
  deliverables:
    - path: "<产出的相对路径>"
      min_length: <数字>                                     # 可选
      must_contain: ["<必须包含的关键词 1>", "<关键词 2>"]   # 可选
  quality_gates:
    - type: self_check
      desc: "<自查项描述>"
    - type: auto_test                                       # 可选，须同时给 script
      script: "<测试脚本路径>"
      expect_exit: 0
      timeout_sec: 30
  self_check:                                               # 必填，至少 2 项
    - "逐条比对 deliverables 是否全部产出"
    - "逐条跑 quality_gates 并记录结果"
    - "在交付消息中附 check-list 每项 ✅/❌"
```

### §3.3 汇报契约（Report Protocol）

```yaml
report:
  # ------ 必填 ------
  channels:
    done: "成果 + 自查 check-list + 文件路径"
    blocked: "卡点描述 + 已尝试方案 + 请示选项 A/B"
    plan: "拟拆解的孙任务清单（含各自的 brief/dod）"
    heartbeat_reply: "回应 status_check：当前步骤/已产出/预计剩余"
  format: "结构化 YAML，不要写散文"
  plan_ack_seconds: 300                                    # 60~300，默认 300；worker 端对应 silence_ack_seconds
  escalation: "block 超过 10 分钟未回复根会话 → 升级到 archive + 重 Fork"
```

### §3.4 自主度边界（Autonomy Boundaries）

```yaml
autonomy:
  # ------ 必填 ------
  can_decide:
    - "<可自决的技术/实现级决策>"
  must_report:
    - "<必须上报但可继续执行的事项>"
  must_ask:
    - "<必须请示后才能做的事项>"
  final_step: "完成所有产出 + 收到 audit_gate pass 后，**你（worker）自己调 tree_leaf_set_status(status=done)**。commander 不代调（代调被引擎 E_BORROWED_IDENTITY 拦截）"
```

### §3.5 自审契约（Self-Audit）

```yaml
self_audit:
  # ------ 必填 ------
  milestones:
    - { id: M1, desc: "<里程碑 1 描述>", expect_outputs: ["<产出文件 1>"] }
    - { id: M2, desc: "<里程碑 2 描述>", expect_outputs: ["<产出文件 2>"] }
  audit_after_each_milestone: true
  audit_agent_type: "code-reviewer"
  max_self_corrections: 2
  drift_declaration_required: true
```

---

## §4 工作流程（5 步法）

> 依据：方法论 §2 标准工作流程；设计文档 §2 架构分层 + §4.2 事件通道。

### Step 1：任务规划

```text
用 TaskCreate 拆解用户意图为 3-7 个子任务。
标注依赖关系：独立任务标记为可并行，依赖任务标记为串行。
每个子任务设明确 acceptance。
```

### Step 2：下发子会话

```text
对每个子任务:
  1. **派生 tree 参与者（worker/commander 子节点）的运行时**:
     - **v0.18+ 补丁后（2026-07-23，dev/pro 已部署）**：`create_session` / `remote_create_session` 对 claude 兼容 provider（ZLM/proma/anthropic 等 AGENT_COMPATIBLE_PROVIDERS）自动推断 `agentRuntime="claude"` → 直接产出有 mcp__tree__* 的会话（dev 实证：ZLM/GLM-5.2 → 30 个 tree 工具全有）。`create_session(channel_id=..., model_id=..., title=...)` 即可。
     - **未打 v0.18 补丁的构建**：create_session 默认 pi（无 tree 工具）→ 必须用 `fork_session(from=<parent_session>, new_channel_id=..., new_model_id=...)` 继承母会话 claude 运行时。
     - fork_session 仍是**跨版本的安全默认**（继承运行时，不依赖补丁）。
     - **v0.20+ 补丁后（2026-07-23，dev/pro 已部署）**：pi 运行时（deepseek 等 openai-responses 模型）**也支持 tree**——pi 会话经 `__proma_getPiCustomTools__` customTools 钩子拿到 mcp__tree__*（dev 实证：deepseek-v4-pro 三组工具全有、tree_help 正常）。所以 v0.20+ 上 pi 模型也能直接做 tree 参与者。
     - **未打 v0.20 补丁的构建**：pi 会话无 tree 工具——用 fork_session 从 claude 母会话派生（继承运行时）绕开。
  2. 首条消息 = §3 的 5 件套完整 YAML（直接复制粘贴模板）
  3. 调 mcp__tree__tree_leaf_add(tree_id=<tree_id>, leaf=<leaf 对象>)
     leaf 对象必填字段（缺任一 → E_SCHEMA_INVALID）：
     ```yaml
     leaf:
       leaf_id: "<prefix>-<A1>-worker"        # 命名见 §12；prefix = tree init 时 root_brief.prefix，与 tree_id 解耦
       session_id: "<worker 的 Proma session_id，fork_session/create_session 后获得>"
       parent: "<root 或父 commander 的 leaf_id>"
       path: "A1"   # 仅本层路径段（worker 在 root 下 = "A1"；嵌套在 commander 下 = "A1/B1"）。⚠️ 不是完整 leaf_id（"vpro1-A1-worker" ✗），不是 "root → leaf" 路径链。由 leaf_id 按引擎 parsePathFromLeafId 派生 = leaf_id 去 prefix 和 role 后缀的段（不符 → E_SCHEMA_INVALID）
       role: "worker"                          # 枚举 root|commander|worker（leaf_add 拒绝 role=root，root 只由 init 创建）
       model: "GLM-5.2"
       channel: "<渠道 id>"
       added_by: "<commander/root 的 session_id>"   # 非 root 必填（操作者追溯链）
     ```
     （命名强制校验在工具内置，失败返回 error.code 如 E_NAME_INVALID）
  4. 对 self_audit 的每个 milestone 调:
     mcp__tree__tree_milestone_add(tree_id=<tree_id>, leaf_id=<leaf_id>, milestone=<milestone 对象>)
```

### Step 2.1：层级委派协议（v2.7 新增，P0-1）

> 依据：macp 实战（tests/002）暴露的星形退化——root 建 commander 后从不发 brief，转而越级直连 worker，树形退化为扁平星形，多级协调优势落空。

**核心规则三分**：

| 委派路径 | 谁建会话 | 谁发 5 件套 brief | 引擎行为 |
|---------|---------|------------------|---------|
| **root → commander** | root（create_session/fork_session） | **root**（leaf_add 后首条 send_message） | 正常，无 warning |
| **commander → worker** | **commander 自己** | **commander 自己** | 正常，无 warning |
| **root → worker（越级）** | root | root | ⚠️ 树中有 active commander 时返回 `W_STAR_DEGRADATION` warning（不拦死） |
| **root → worker（单层树）** | root | root | 正常，无 warning（无 commander，root 直辖合法） |

**关键认知**：建 commander leaf ≠ 委派完成。commander leaf 必须收到 5 件套 brief 才能自主履职（leaf_add 后紧接 send_message 发 brief）。**只建 leaf 不发 brief = commander 沦为孤儿占位，树退化为星形**。

**root 越级 worker 反模式**（macp 实战复现）：

```text
❌ 退化路径（星形）:
   root: leaf_add(commander-A, parent=root)           ← 建了 commander
   root: leaf_add(worker-W1, parent=root)             ← 越级！引擎返回 W_STAR_DEGRADATION
   root: send_message(worker-W1, brief)               ← 绕过 commander-A
   → commander-A events 永远为空（孤儿），3 个 commander 沦为占位

✅ 正确路径（树形）:
   root: leaf_add(commander-A, parent=root)
   root: send_message(commander-A, 5件套brief)        ← commander-A 拿到任务书
   commander-A 自主履职:
     commander-A: leaf_add(worker-W1, parent=commander-A)
     commander-A: send_message(worker-W1, brief)
```

**例外（root 直辖 worker 合法场景）**：
- **单层树**（无 commander，root 直辖 1-3 个 worker）——引擎判定"树中无 active commander"自动放行。
- **应急接管**（commander 全部宕机，root 直接补位）——引擎返回 warning 但不拦死，事后可追溯（leaf.delegation_hint='star_degradation_warned'）。

> 引擎软约束实现：tree-engine.cjs cmdLeafAdd，触发条件 `parent.role=root + role=worker + 树中有 active commander`。详见 §11 禁止行为 #14。

#### §4 Step2.1a 层级选择指导（macp4 新增）

> macp3 从 macp2 的 4 层（root→cmd→sub-cmd→worker）扁平化为 3 层（root→cmd→worker），减少一级中转延迟。下为条件表：

| 条件 | 推荐层数 | 结构 |
|------|---------|------|
| worker ≤ 6，任务同质、不需要子域分隔 | **3 层** | root→cmd→worker（macp3 模式） |
| worker 7-12，任务可分组 | 3 层 + 多 commander | root→cmd-A→workers-A + cmd-B→workers-B |
| worker > 12，跨子域、需要独立审计子树 | **4 层** | root→cmd→sub-cmd→worker（macp2 模式） |
| 极简任务（≤ 3 worker） | **2 层** | root→worker（单层树，§4 Step2.1 例外） |

**3 层 vs 4 层选择权衡**：
- **3 层（commander 直管 worker）**：链条短、中转延迟低，但 commander 负载更高（同时跟踪更多 worker 的 brief_echo/alignment/纠偏）。适合任务同质、worker ≤ 10 的中小规模项目。
- **4 层（嵌套 sub-commander）**：多一层中转增加延迟，但 sub-cmd 缓冲了 commander 的直接压力，子域间天然隔离。适合跨子域、大规模项目（worker > 12）。
- macp3 选择 3 层的原因：12 leaf 中 7 worker 任务同质（coder/judge 相关），不需要 sub-cmd 子域分隔，扁平化减少一级中转延迟。注意 macp3 C2 遗漏提示 3 层中 commander 负载更高（需维护待审清单防遗漏，见 §13.4.0a）。

> ⚠️ **多层级树（≥3 层）root 信任锚警示（macp5 新增）**：选 3 层（root→cmd→worker）或多 commander 时，**只有树根 leaf（role=root）是 V10 信任锚**。L2 commander（role=commander）**无法自己 done**——`caller===audit_session_id` 硬约束 + L3091 `added_by` 自审禁令三路径全撞墙（macp4 实证）。L2 commander 想 done 须走 §13.3b（root 代调协议 + root idle 3 道防线）。auditor leaf 必须挂 root 子节点（commander 的兄弟），不能在 commander 子树下（added_by 关系，见 §13.4.0 多层级说明）。

### Step 3：事件路由

```text
子会话通过 send_message(notify) 上行事件。
根会话收到后按 §6 事件路由表派发处理。
所有事件先登记: mcp__tree__tree_event_append(tree_id=<tree_id>, leaf_id=<leaf_id>, type=<type>, meta=<meta 对象>)

**【必须】每次 `send_message` 给树内 leaf 后，紧接 `tree_log_communication(tree_id, target_session_id=<session>, direction='out', note='…')`——漏记一次即违规（§11 #15）。**
```

### Step 4：质量门

```text
子会话 done 上报后:
  1. 检查 self_check 是否全部 pass（缺任一项 → 直接退回，不进入验收）
  2. [ISS-003] 若 brief.audit_meta.review_required=true (worker 应跑 G1-G5 多子Agent 自审):
     a. tree_event_list 查 worker events, 确认含 ≥1 条 review_round 事件 (末轮 red_count=0)
        - 无 review_round → 退回, 要 worker 补跑 tree-worker §4.6 (引擎也会 E_REVIEW_NOT_CONVERGED 拦 set-status done)
     b. 抽查 findings 真实性 (引擎只防格式, commander 抽查是内容真实性的真实防线):
        - 随机抽 1-2 个 reviewer_session_id, 用 mcp__session__list_messages 看是否真有审查对话 (防 worker 自写全 green 蒙混)
        - 抽 1 条历史 red finding 看是否真在后续 round 修复
        - 抽查通过 → 继续; 发现伪造 (reviewer session 无实质内容/全 green 废话) → 退回 + tree_drift_append(severity=high)
  3. 派验收 Agent（见 §9 模板）→ 拿到 verdict
  4. verdict.pass → 先调 audit_gate 给 worker 背书 pass（V5b 硬前置，详见 §13 冷启动信任锚流程）:
     mcp__tree__tree_audit_gate(tree_id, leaf_id=<worker>, verdict='pass',
       audit_session_id=<auditor_session_id>)
     - 冷启动期: audit_session_id = root.session_id，commander 自己调（caller===audit_session_id）
     - 正常期: audit_session_id = 已 done+pass 的独立 auditor leaf session，该 auditor 自己调
     - ⚠️ worker 不能自己调 audit_gate 给自己 pass（caller≠audit_session_id → E_BORROWED_IDENTITY）
     - ⚠️ 不调 audit_gate 直接 set-status done → 引擎 E_GATEKEEPER_REQUIRED 拦
  5. audit_gate pass 后 → mcp__tree__tree_leaf_set_status(tree_id=<tree_id>, leaf_id=<leaf_id>, status=done)
     verdict 不通过 → 按 §7 三档纠偏决策树执行
```

### Step 5：沉淀文档

```text
重要产出落盘到 .context/:
  - 设计文档 / 审计报告 / 测试方案 / 测试报告
  - 每个关键决策记录到 .context/note.md
  原则: "删掉后未来 Agent 会犯错" 的内容才值得沉淀（方法论原则 10）
```

---

## §5 mcp__tree__* 工具速查

> v0.7+ 起 tree-state.js 已内联进 MCP，通过 `mcp__tree__*` 工具调用。依据：设计文档附录 A（A.3-A.7）。所有工具返回 `{ok, error?, ...result}`，失败看 `error.code`（如 `E_NAME_INVALID`、`E_DELIVERABLE_MISSING`、`E_SCHEMA_INVALID`）。

### Query（只读）

| 工具 | 说明 |
|------|------|
| `mcp__tree__tree_leaf_get(tree_id, leaf_id)` | 查询单个 leaf 完整信息 |
| `mcp__tree__tree_leaf_list_active(tree_id)` | 列出所有 status=active 的叶子（心跳用） |
| `mcp__tree__tree_leaf_list_all(tree_id)` | 列出所有叶子（含 done/pruned/archived） |
| `mcp__tree__tree_tree_dump(tree_id)` | 全树 JSON dump（调试/恢复用） |
| `mcp__tree__tree_drift_list(tree_id, leaf_id?, since?)` | 查询 drift 历史，可按 leaf / 时间过滤 |
| `mcp__tree__tree_heartbeat_tail(tree_id, leaf_id?, n?)` | 查询最近 N 条心跳记录 |
| `mcp__tree__tree_event_list(tree_id, leaf_id?, type?)` | 查询事件历史（共 11 种类型：done/blocked/plan/brief_echo/heartbeat_reply/nudge/limit/status_check/review_round/subagent_spawn/progress） |
| `mcp__tree__tree_communication_list(tree_id, leaf_id?, target?, since?)` (v2.9) | 查询外部通信记录（tree_log_communication 记的 send_message 活动，按 leaf/target/since 过滤） |

### Add（新增）

| 工具 | 说明 |
|------|------|
| `mcp__tree__tree_leaf_add(tree_id, leaf=<obj>)` | Fork 新会话时调用，含命名强制校验（失败返回 `E_NAME_INVALID`） |
| `mcp__tree__tree_milestone_add(tree_id, leaf_id, milestone=<obj>)` | 添加里程碑（milestone 对象含 id/desc/expect_outputs） |

### Update（字段更新）

| 工具 | 说明 |
|------|------|
| `mcp__tree__tree_leaf_set_status(tree_id, leaf_id, status)` | status ∈ `active\|done\|pruned\|archived\|segment_pending`。切 done 时校验 milestones 非空且全部 audit_pass=true（失败返回 `E_SCHEMA_INVALID`） |
| `mcp__tree__tree_leaf_set_context(tree_id, leaf_id, context_pct)` | context_pct 0-100，心跳后更新上下文使用率 |
| `mcp__tree__tree_leaf_set_last_event(tree_id, leaf_id, event_type, ts?)` | 更新最后事件类型和时间 |
| `mcp__tree__tree_leaf_autonomy_override(tree_id, leaf_id, overrides=<obj>)` | 中档纠偏时限权（overrides 对象含 added_must_ask / removed_can_decide / reason） |
| `mcp__tree__tree_milestone_set_result(tree_id, leaf_id, milestone_id, audit_pass, audit_session_id, note_path?)` | 记录里程碑审计结果（`audit_pass=true` 时 `audit_session_id` 必填且须独立；冷启动填 `root.session_id` 走闸门2，见 §13.3 步骤2） |

### Append（数组追加）

| 工具 | 说明 |
|------|------|
| `mcp__tree__tree_event_append(tree_id, leaf_id, type, meta=<obj>)` | 登记上行事件元数据，同时更新 last_event_* |
| `mcp__tree__tree_drift_append(tree_id, leaf_id, kind, severity, action, fork_to?, reason?)` | kind ∈ `production\|direction\|rhythm`，severity ∈ `low\|mid\|high`，action ∈ `nudge\|limit\|prune\|self_correct\|declare\|handoff`。双写 drift_history + drift_log |
| `mcp__tree__tree_heartbeat_append(tree_id, heartbeat=<obj>)` | heartbeat 对象含 `{verdicts:[...], ts, next_heartbeat}`，追加并更新 last_heartbeat |
| `mcp__tree__tree_segment_append(tree_id, leaf_id, new_session_id)` | 竹节交接：追加 segment_chain + 改状态 segment_pending |
| `mcp__tree__tree_log_communication(tree_id, target_session_id, direction?, note?)` (v2.9) | 记录外部通信（send_message 等），**不截内容**；自动定位 target leaf + 更新 last_event（心跳巡检据此感知通信活动，不误判冻结） |

### Audit（v2.1 审计专用）

| 工具 | 说明 |
|------|------|
| `mcp__tree__tree_audit_gate(tree_id, leaf_id, verdict, audit_session_id, reason?)` | 审计门禁裁决（`audit_session_id` 必填且须 = caller session_id，否则 `E_BORROWED_IDENTITY`；冷启动填 `root.session_id` 走闸门2，见 §13.3 步骤6） |
| `mcp__tree__tree_audit_append(tree_id, leaf_id, report=<obj>)` | 追加审计报告。report 必填字段：`auditor_session_id`(UUID)、`total`(int)、`passed`(int)、`failed`(int)、`results[]`(每项含 `{item, severity, pass, evidence}`，🔴 **severity ∈ `red`\|`yellow`\|`green` v0.21 强制**，缺/错值抛 `E_SCHEMA_INVALID`；macp6 实战 C/auditor 撞此错自纠正) |
| `mcp__tree__tree_nudge_append(tree_id, leaf_id, nudge=<obj>)` | 追加 nudge 记录 |

### Maintain（维护）

| 工具 | 说明 |
|------|------|
| `mcp__tree__tree_init(tree_id, root_brief=<obj>, root_dod=<obj>, session_id?, model?, channel?, audit_meta?)` | 首次创建 tree（根会话激活时调一次） |
| `mcp__tree__tree_backup(tree_id, label?)` | 手动备份（保留最近 10 份） |
| `mcp__tree__tree_restore(tree_id, backup_file)` | 从备份恢复（恢复前自动安全备份） |
| `mcp__tree__tree_validate(tree_id)` | 一致性校验：parent 引用 / fork_to / session_id 唯一 / path 一致 / milestone.id 唯一 |
| `mcp__tree__tree_migrate(tree_id)` | 数据迁移 |

---

## §6 事件路由表

> 依据：设计文档 §4.2 事件通道 + §4.3 心跳通道 + §6.1 brief_echo。

| 事件 | 触发 | 指挥官动作 | mcp__tree__* 工具 |
|------|------|-----------|------------------|
| **done** | 子会话完成上报 | ① 登记事件 ② 派验收 Agent（§9）③ 按 verdict 执行：pass → set-status done；不通过 → 走 §7 纠偏 | `tree_event_append(type=done)` → `tree_leaf_set_status(status=done)` 或 `tree_drift_append` |
| **blocked** | 子会话卡点上报 | ① 登记事件 ② 审查选项 A/B ③ send_message 给决策 ④ 超 10 分钟无响应 → archive + 重 Fork | `tree_event_append(type=blocked)` → 超时后 `tree_leaf_set_status(status=archived)` + `tree_leaf_add` 新叶 |
| **plan** | 子会话拆解计划上报 | ① 登记事件 + 登记 plan_id + ts ② 派路线图 Agent（researcher）评估 ③ 5 分钟内收到 verdict → 按 verdict 行事 ④ 5 分钟未收到 → **默认放行**（plan_ack_seconds 到期）⑤ 若 verdict=nack 在放行后才到 → 走中档纠偏 | `tree_event_append(type=plan)` → nack 时 `tree_drift_append(action=limit)` |
| **brief_echo** | 子会话首条上行（复述理解） | ① 登记事件 ② 评估对齐度（路线图 Agent 仅做评估，auditor 选择见 §13）③ **回填 alignment event（V5b 必须，见 §6 回填机制 / §13.3 步骤4）** ④ ≥85% → 放行 ⑤ <85% → 发回重 brief_echo | `tree_event_append(type=brief_echo)` → 回填 alignment event → <85% 时 `tree_drift_append(severity=low, action=nudge)` |
| **heartbeat_reply** | 子会话回应 status_check | ① 登记事件 ② 解析回应内容 ③ 正常 → 仅记录 ④ 异常 → 喂给 §7 纠偏 | `tree_event_append(type=heartbeat_reply)` → `tree_leaf_set_context` |
| **progress** (v2.8) | worker 主动报中间进度 | ① 登记事件 ② 若 meta.percent 提供 → 更新 context_usage 估算 ③ 正常仅记录，不触发纠偏 | `tree_event_append(type=progress, meta={step, outputs_so_far?, eta?, percent?})` |

### brief_echo 状态联动（v2.8 引擎自动）

worker 写首条 brief_echo（复述理解）时，引擎自动把 `leaf.status: pending_brief → active`（cmdEventAppend 内置，无需手动调 set-status）。解决 macp 实战"worker 已回应 brief 但 tree 仍显示 pending_brief"的状态滞后——commander 心跳不再误判 worker 没动。commander/auditor 初始即 active 不受影响；只在 pending_brief 触发保证幂等。

### progress event 用法（v2.8）

worker 长任务（>10 分钟）中途可主动报进度，让 tree 可见（避免 commander 误判"冻结"）：

```yaml
# worker 端
mcp__tree__tree_event_append(tree_id, leaf_id=<self>, type='progress',
  meta={step: "正在写第 3 节", outputs_so_far: ["reports/draft-sec3.md"], percent: 60, eta: "15min"})
```

progress 不触发状态转换、不强制 schema（轻量）；commander 在心跳巡检时可读最近 progress 判断进度。

### 外部通信记录协议（v2.9）

root 通过 `send_message` 驱动 worker/commander（发 brief、nudge、追问、指令）时，这些**外部 IPC 通信 tree 默认看不到**——心跳巡检只看 tree events/call-log，会误判 target leaf "冻结"。v2.9 协议：root 每次 `send_message` 给树内 leaf 后，调一条 `tree_log_communication` 记录：

```yaml
# root send_message 后立即调
mcp__session__send_message(session_id=<worker_session>, message="<brief/nudge/追问>")
mcp__tree__tree_log_communication(tree_id, target_session_id=<worker_session>,
  direction='out', note='发送 5 件套 brief')
```

**引擎自动处理**：定位 target leaf（按 session_id）→ 更新其 `last_event_type='communication_out'` + `last_event_ts`（心跳据此感知）+ 追加 `communication_log`。**不截 message 内容**（隐私 + 体积；note 是 agent 自主的简短摘要）。用 `tree_communication_list` 查询历史。

**硬要求**（macp2 实战再证 ~10% 漏记后升级）：每次 send_message 后必须紧接 tree_log_communication。漏记 = 协议违规，属 §11 禁止行为 #15。

### plan 默认放行机制（详细）

```text
子会话 X 发出 plan 后:
  1. 根会话调 event append 登记 plan_id + ts
  2. 根会话派 Agent(subagent_type=researcher) 评估此 plan
     prompt = "评估 plan 是否放行" + plan 内容 + 母任务 brief/dod
  3. plan-审批 Agent: 5 分钟内返回 { verdict: ack | nack | tweak, reason }
  4. 根会话:
     - 5 分钟内收到 verdict → 按 verdict 行事
     - 5 分钟内未收到 → 默认放行（子会话已默认开始 Fork）
  5. 若 verdict=nack 在默认放行后才到 → 走 §7 中档纠偏
```

### brief_echo alignment 回填机制（v0.7 批次5 V5b 必须）

```text
子会话 worker 发出 brief_echo（首条，复述理解）后:
  1. 根会话调 event append 登记（worker 的 brief_echo event，含 my_understanding/milestones_preview）
  2. 评估对齐度（比对 brief/dod）。auditor_session_id 填谁见下方"auditor 选择决策"。
     评估本身的"智力活"可用 SDK SubAgent（researcher）做，但 auditor_session_id 不能填 SDK session。
  3. 评估完成 → 根会话【必须】回填一条 brief_echo event 到 worker leaf:
     mcp__tree__tree_event_append(
       tree_id, leaf_id=<worker>, type='brief_echo',
       meta={"alignment":"<评估结论或百分比>","auditor_session_id":"<auditor_session_id>"}
     )
     # 注：event-append 传 meta 对象（底层 CLI 为 --json 字符串，MCP 层为 meta 对象）
     这条回填 event 是 worker 后续 audit_gate pass 的硬前置（V5b 查 events 留痕，不查可篡改标志）。

  🔴 auditor 选择决策（冷启动死锁的正解，repro 实证 2026-07-07，详见 §13）:
  - 冷启动期（树内尚无 status=done + events 非空 + audit_gate=pass 的 leaf）:
    auditor_session_id = root.session_id（commander 自己）。引擎 resolveAuditorIndep 闸门2
    允许 root 当任意 worker 的 auditor（信任锚）。由 commander 自己写这条回填 event。
    ⚠️ 绝不要在冷启动期 fork "独立 auditor leaf" 当 auditor——它会卡在 V10-auditor-active
    三连（自己 done 需 audit_pass → 需独立 auditor → 自己），无穷递归，是 nanju-iter2 死锁根因。
  - 正常期（已有 ≥1 个 done+pass 的 auditor leaf）: 可派独立 leaf 当 auditor（走闸门3）。
  4. 对齐度 ≥85% → 放行 worker 继续干活
     对齐度 <85% → tree_drift_append(severity=low, action=nudge) 发回重 brief_echo
  5. ⚠️ 若跳过步骤 3（未回填 alignment event），worker 永远拿不到 audit pass:
     - cmdAuditGate 拦 E_ALIGNMENT_NOT_VERIFIED（worker events 无 alignment 留痕）
     - worker 卡死无法 done，会上行 blocked 抱怨"audit pass 被拦"
     - 这是 V5b 的硬约束（堵 A3-omit-alignment 绕过），不是 bug
```

> **为什么 alignment 在回填 event 里，不在 worker 首条 brief_echo 里**：alignment 是 commander/路线图 Agent 的**对齐评估产物**（worker 自己无法自评对齐度）。worker 首条 brief_echo 只含 `my_understanding + milestones_preview`（见 tree-worker SKILL §3.4）。评估由独立 Agent 完成后，结果以第二条 brief_echo event 形式回填到 worker leaf——这同时满足 V5b 的"events 留痕"和 A3 的"独立 auditor 背书"。

### brief_echo 回填完成确认清单（macp4 新增，防并发遗漏）

> macp3 C-commander 并发处理 C1/C2 brief_echo 时漏回填其中一个 alignment event——"教了"不等于"能做到"。以下硬 checklist 逐条确认后才能继续：

```text
commander 收到 worker brief_echo 后，必须在下发下一个 worker 前完成以下确认：

回填完成确认清单（逐条 ✅ 后才能继续）:
  [ ] worker 的 brief_echo event 已写入（worker 自写，含 my_understanding/milestones_preview）
  [ ] alignment 评估已执行（≥85% 或 <85% 走纠偏）
  [ ] alignment 回填 event 已 append 到 worker leaf（tree_event_append type=brief_echo, meta={alignment,auditor_session_id}）
  [ ] tree_log_communication 已记录（send_message 后紧接，§11 #15）
  [ ] 下一个 worker 的 brief_echo 才能开始评估

并发场景特殊规则:
  - 同时收到 ≥2 worker brief_echo → 按 leaf_id 字典序排队，一个完成回填再处理下一个
  - 禁止并发评估 + 并发回填（context switching 导致遗漏，macp3 实证）
```

---

## §7 三档纠偏决策树（v0.2 启用）

> 依据：设计文档 §5.2 三档纠偏表 + §5.3 纠偏决策树 + §10.5 纠偏执行流程。

### 决策树（if-else）

```text
收到 Agent 的 verdict { severity: low|mid|high, action: ..., suggestion: "..." }:

  if severity == low OR action == status_check:
    ┌─ 轻档 nudge ─────────────────────────────────────────┐
    │ send_message(leaf.session_id, "nudge: " + suggestion) │
    │ mcp__tree__tree_leaf_set_last_event(tree_id, leaf_id, "nudge")     │
    │ mcp__tree__tree_drift_append(tree_id, leaf_id,                       │
    │   kind=<kind>, severity="low", action="nudge",                       │
    │   reason="<suggestion 摘要>")                                        │
    └────────────────────────────────────────────────────────┘

  elif severity == mid:
    if leaf.drift_history 近 30 分钟内有 nudge 记录:
      ┌─ 中档限权 ──────────────────────────────────────────────┐
      │ send_message(leaf.session_id, "limit: 权限已限制 — "    │
      │   + verdict.gaps 摘要)                                   │
      │ mcp__tree__tree_leaf_autonomy_override(tree_id, leaf_id, │
      │   overrides={                                            │
      │     added_must_ask:[...], removed_can_decide:[...],      │
      │     reason:"中档纠偏：方向偏差 mid 严重度"})             │
      │ mcp__tree__tree_leaf_set_last_event(tree_id, leaf_id, "limit")     │
      │ mcp__tree__tree_drift_append(tree_id, leaf_id,                       │
      │   kind=<kind>, severity="mid", action="limit")                       │
      └──────────────────────────────────────────────────────────┘
    else:
      → 先走轻档 nudge（给一次自纠机会）

  elif severity == high OR (mid + leaf 已有 limit 记录):
    ┌─ 重档剪枝 ─────────────────────────────────────────┐
    │ archive_session(leaf.session_id)                    │
    │ mcp__tree__tree_leaf_set_status(tree_id, leaf_id, "pruned")         │
    │ fork_session(from=<leaf_id>,                        │
    │   up_to_message_uuid=<verdict.suggested_fork_from_uuid>)     │
    │ 新 leaf: role 加 i2/i3 后缀                         │
    │ mcp__tree__tree_leaf_add(tree_id, leaf=<新 leaf 对象>)             │
    │ mcp__tree__tree_drift_append(tree_id, <原 leaf_id>,                 │
    │   kind=<kind>, severity="high", action="prune",                     │
    │   fork_to=<新 leaf_id>, reason="<偏差原因摘要>")                    │
    └──────────────────────────────────────────────────────┘

全部动作调 tree_drift_append 记录。
```

### 三档递进原则

| 档位 | 触发 | 动作 | 执行者 |
|------|------|------|--------|
| 轻档（提示） | severity=low | send_message(nudge) | 根会话直发 |
| 中档（限权） | severity=mid / 轻档后再偏 | send_message(limit) + autonomy-override | 根会话 |
| 重档（剪枝） | severity=high / 中档后再偏 | archive + fork + prune | 根会话 |

---

## §8 心跳通道（v0.2 启用）

> 依据：设计文档 §4.3 心跳通道 + §10.3 心跳通道实现。

### §8.1 心跳 Automation 配置（可直接粘贴）

```yaml
name: "tree-heartbeat-<tree_id>"
scheduleType: interval
intervalMinutes: 15
sessionMode: reuse
permissionMode: bypassPermissions
prompt: |
  执行树 <tree_id> 心跳巡检。工作区: C:\Users\sir_c\.proma\agent-workspaces\proma\workspace-files

  步骤:
  1. 调用 mcp__tree__tree_leaf_list_active(tree_id=<tree_id>)
     返回: {ok:true, leaves:[{leaf_id, session_id, last_event_ts, context_usage_pct},...]}
  2. 对每个 active 叶子调用 mcp__session__list_messages(session_id, limit=3) 获取最近活动
  3. 组装数据后，调用哨兵 Agent（subagent_type=explorer），prompt 见下方判定矩阵
  4. 对哨兵判定为 stale/silent 的叶子:
     mcp__session__send_message(session_id, "status_check: 请报告当前步骤、已产出文件、预计完成时间、是否有阻塞")
     调 mcp__tree__tree_leaf_set_last_event(tree_id=<tree_id>, leaf_id=<leaf_id>, event_type="status_check")
  5. 调 mcp__tree__tree_heartbeat_append(tree_id=<tree_id>, heartbeat=<判定结果对象>)
  6. 返回巡检摘要（< 200 字）：活跃数/停滞数/静默数/已发 status_check 数
```

### §8.2 哨兵 Agent prompt 模板

```text
任务：判定一批 active 叶子的状态。

输入数据格式:
[{leaf_id, last_event_ts, last_event_type, context_usage_pct, recent_messages: [...最近3条]}]

判定矩阵 (依据设计文档 §4.3):

| 最近活动    | 上下文使用 | 判定               | action                     |
|------------|-----------|-------------------|-----------------------------|
| < 5 分钟    | < 85%     | active            | none                        |
| < 5 分钟    | >= 85%    | sweet_spot_risk   | schedule_handoff            |
| 5~30 分钟   | 任意       | stale             | status_check                |
| > 30 分钟   | 任意       | silent            | status_check + mark_pending_correction |

输出格式 (JSON 数组):
[
  {
    "leaf_id": "...",
    "verdict": "active|stale|silent|sweet_spot_risk",
    "action": "none|status_check|schedule_handoff|mark_pending_correction",
    "reason": "..."
  }
]

去重规则 (设计文档 §4.4):
- leaf.last_event_ts 在 5 分钟内 → 跳过（事件通道已覆盖），判定为 active，action=none
```

### §8.3 心跳结果处理流程

```text
收到哨兵 Agent 返回的 verdicts 数组:

  for each verdict in verdicts:
    调 mcp__tree__tree_leaf_set_context(tree_id=<tree_id>, leaf_id=<leaf_id>, context_pct=<pct>)
    
    if verdict.verdict == "active":
      → 仅记录，不动作
    
    elif verdict.verdict == "sweet_spot_risk":
      → 在 heartbeat 日志中标记预警
      → 下次心跳仍 >=85% 则触发竹节交接（v0.3 实现）
    
    elif verdict.verdict == "stale":
      → 已发 status_check（步骤 4 完成）
      → 调 mcp__tree__tree_leaf_set_last_event(tree_id=<tree_id>, leaf_id=<leaf_id>, event_type="status_check")
    
    elif verdict.verdict == "silent":
      → 已发 status_check
      → 调 mcp__tree__tree_leaf_set_last_event(tree_id=<tree_id>, leaf_id=<leaf_id>, event_type="status_check")
      → 调 mcp__tree__tree_drift_append(tree_id=<tree_id>, leaf_id=<leaf_id>,
          kind="rhythm", severity="mid", action="nudge",
          reason="静默 > 30 分钟，下次心跳若仍 silent 升级到重档剪枝")
  
  最后调 mcp__tree__tree_heartbeat_append(tree_id=<tree_id>, heartbeat=<完整 verdicts 对象>)
```

---

## §9 验收 Agent prompt 模板（v0.2 启用）

> 依据：设计文档 §10.5 验收 Agent prompt 骨架。

```text
任务：验收子会话产出是否符合任务契约。

输入:
  leaf_id: <leaf_id>
  brief: <子会话的 brief YAML>
  dod: <子会话的 dod YAML>
  deliverables_paths: [<产出文件绝对路径列表>]
  self_check: [{item, pass}, ...]
  drift_history: [<子会话 drift_history 数组>]

检查维度:
  1. deliverables 是否存在且满足 dod.min_length 和 dod.must_contain
  2. self_check 项目是否全部 pass=true（缺一项 → severity=high）
  3. 产出内容是否超出 brief.in_scope 范围（超出 → direction 偏差）
  4. drift_history 中有无未解决的 severity>=mid 偏差
  5. 如有偏差，从哪个里程碑开始偏（用于确定 suggested_fork_from_uuid）
  6. 每个交付物是否附带 .note.md 决策笔记（无 → severity=high，依据 §6.3）

输出格式:
{
  "pass": true|false,
  "gaps": ["缺失项 1", "出界内容 2", ...],
  "severity": "low|mid|high",
  "suggested_fork_from_uuid": "uuid 或 null",
  "reason": "一句话摘要"
}

注意:
  - severity=high 时必须给出 suggested_fork_from_uuid
  - 假设有偏，找出证据（避免自我合理化盲区，设计文档 §5.6）
  - auto_test 退出码 != 期望 → severity=high
  - auto_test 超时 → severity=mid
```

---

## §10 灾难恢复检查表

> 依据：设计文档 §8.3 灾难恢复（4 类故障 F1-F4）。

| 故障 | 现象 | 恢复动作 | mcp__tree__* 工具 |
|------|------|---------|------------------|
| **F1. 子会话崩溃** | send_message 无响应，心跳发现 🔴 | ① 从该 leaf 最后通过的 milestone uuid 重 Fork ② archive 旧会话 ③ 新 leaf 加 i2 后缀 | `tree_leaf_set_status(status=pruned)` → `tree_leaf_add` 新叶 → `tree_drift_append(action=prune, fork_to=<新 leaf_id>)` |
| **F2. 根会话崩溃** | 调度停滞 | ① tree-state.json 完整 → 重启根会话 ② 调 `tree_leaf_list_active` 恢复所有活跃叶子索引 ③ 调 `tree_validate` 校验一致性 ④ 恢复心跳 automation（如存在） | `tree_leaf_list_active` → `tree_validate` → `tree_event_list` 重建最近事件时间线 |
| **F3. tree-state 损坏** | JSON 解析失败（E_SCHEMA_INVALID） | ① 从 `.tmp` 或最近 backup 恢复 ② 无备份则从 drift_log/heartbeat_log 重建叶子列表 ③ 重建后调 `tree_validate` | `tree_restore(tree_id, backup_file)` 或 `tree_tree_dump` 确认恢复结果 |
| **F4. SDK 配额耗尽** | Fork/send_message 失败 | ① 根会话"待机"：每 5 分钟 ping 1 次 ② 恢复后重试失败的 Fork ③ 不写 tree-state，等恢复后统一更新 | 无需特殊工具，恢复后 `tree_leaf_list_active` 确认状态一致 |

**关键设计**：
- leaves 条目永不删除，只改 status（保留可追溯）
- drift_log 永不截断
- 每写 10 次自动备份一次（mcp__tree__* 引擎内置）

---

## §11 禁止行为清单（17 条）

> 依据：方法论 §6 反模式表 + 设计文档 §1 补丁约束 + §8.2 写入铁律。

| # | 禁止行为 | 后果 | 正确做法 |
|---|---------|------|---------|
| 1 | 指挥官亲自写代码 / 亲自做判断 | 上下文爆炸，甜点危机 | 派子 Agent 判断 / 派子会话执行 |
| 2 | 给子会话一句话任务 | 必然跑偏 | 7 段式 prompt：背景 + 必读 + 任务 + 约束 + 流程 + 禁止 + 格式 |
| 3 | 直接读/写 tree-state.json | 字段写错 / 格式错误 / 覆盖丢失 | 走 mcp__tree__* 工具 |
| 4 | 下发缺失 DoD 的任务 | 子会话不知道什么叫完成 | 5 件套缺一不可 |
| 5 | 下发缺失 milestones 的任务 | 无法内部自审 | self_audit.milestones 必填 |
| 6 | 跳过 brief_echo 直接开始干活 | 理解偏差在全程传播 | 首条上行必须是 brief_echo |
| 7 | 信任子 Agent 的"已完成" | bug 漏到下游 | trust but verify：独立子 Agent 验收 |
| 8 | done 上报 self_check 缺项不退回 | 低质量产出通过验收 | DoD 硬校验：缺一项直接退回 |
| 9 | 同一偏差反复 nudge 超过 2 次不升级 | 纠偏失效 | 第 3 次必剪枝 |
| 10 | plan 审批阻塞子会话等待 | 子会话空等浪费 | 默认放行机制：5 分钟无 NACK 自动放行 |
| 11 | 重档剪枝后删旧会话 | 丢失可追溯历史 | archive 不删，drift_log 永存 |
| 12 | 不沉淀文档 | 跨会话失忆 | 重要产出落盘到 .context/ |
| 13 | 用 create_session 派生 tree 参与者（**未打 v0.18 补丁的构建**） | 子会话默认 pi、无 mcp__tree__*，§13.3 caller=worker 步骤全卡 | v0.18+ 补丁后 create_session 自动推断 claude（dev/pro 已验证）；未打补丁的构建必须用 fork_session。详见 §4 Step2 |
| 14 | root 在已有 active commander 时直接 leaf_add worker（越级） | commander 沦为孤儿占位，树退化为扁平星形，多级协调优势落空 | 把 worker 挂到对应 commander 下（parent=<commander_leaf_id>，由 commander 自主 leaf_add + 发 5 件套 brief）。引擎返回 W_STAR_DEGRADATION warning（不拦死）。详见 §4 Step2.1 |
| 15 | send_message 给树内 leaf 后漏记 tree_log_communication | 心跳巡检看不到通信活动，误判 target leaf 冻结（macp2 实战 ~10% 漏记触发升级） | 每次 send_message 后紧接 tree_log_communication（§6 硬要求）。commander 心跳读 communication_log 感知 IPC 活动 |
| 16 | root 中转链上不维护待审 worker 清单 | worker done 但待审清单未划掉 → 遗漏异厂商审（macp3 C2 教训） | 按 §13.4.0a 6 步流程维护待审清单，全清单空 = 审查闭环完成 |
| 17 | commander 派 worker 后漏回填 alignment event | worker 永远拿不到 audit_gate pass（E_ALIGNMENT_NOT_VERIFIED），卡死无法 done | 执行 §6 回填完成确认清单逐条确认，并发场景按 leaf_id 字典序排队，禁止并发评估+并发回填 |

---

## §12 命名规范

> 依据：设计文档 §6.5 命名规范。

### 格式

```
<prefix>-<path>-<role>[-<suffix>]
```

| 段 | 内容 | 正则 |
|----|------|------|
| `prefix` | 项目代号 | `[a-z][a-z0-9_]{3,7}`（小写字母开头，4-8 字符，**不含连字符**） |
| `path` | 树定位：根为空，子=A/B/C，孙=A1/A2，曾孙=A1a | `[A-Z]\d*(?:[a-z]\d*)*` |
| `role` | 角色枚举（引擎硬约束，越界抛 `E_SCHEMA_INVALID`） | `root\|commander\|worker` |
| `suffix` | 可选。竹节=sNN / 尝试=iNN | `s\d+\|i\d+` |

### 完整正则

```
^([a-z][a-z0-9_]{3,7})-(?:([A-Z]\d*(?:[a-z]\d*)*)?-)?(root|commander|worker)(?:-(s\d+|i\d+))?$
```

### 正例

| 命名 | 解读 |
|------|------|
| `nanju-root` | nanju 项目根会话 |
| `nanju-A-commander` | 第 1 子 A = 子指挥官 |
| `nanju-A-commander-s2` | A 的竹节第 2 节 |
| `nanju-A1-worker` | A 的第 1 孙 = 原子工人 |
| `sweng-B-worker` | sweng 项目 B = 原子工人 |
| `webv3-C-commander` | webv3 项目 C = 子指挥官 |
| `pguide-root` | pguide 项目根会话 |
| `nanju-A1b-worker` | A1 的第 2 次尝试（i2=i, path 中 b 表示第 2 个曾孙） |

### 负例

| 命名 | 原因 |
|------|------|
| `proma-guide-root` | prefix 含连字符 `-` |
| `NA-root` | prefix 大写 + 不足 4 字符 |
| `nju-root` | prefix 仅 3 字符 |
| `NANJU-root` | prefix 含大写字母 |
| `123abc-root` | prefix 首字符非小写字母 |
| `toolkithelper-root` | prefix 13 字符，超过 8 字符上限 |

### 配套规则

1. `prefix` 由根会话首次 `init` 时生成，**永不变更**
2. Fork 时强制继承 prefix（leaf add 校验）
3. `role` 必须在 `[root, commander, worker]` 枚举内，越界抛 `E_SCHEMA_INVALID`（引擎 `cmdLeafAdd` → `assertEnum` 硬约束，Q1 v1.1 起生效）
4. 重档剪枝时旧会话 archive 不删，新会话加 `i2/i3` 后缀

---

## §13 冷启动信任锚流程（2026-07-07 repro 实证新增）

> 解决 nanju-iter2 暴露的 alignment/audit_gate **冷启动死锁**（nanju-iter2 = 2026-07-07 一次冷启动死锁实战复盘，详见上游报告 `tree-system-execution-report-2026-07-07.md`）。
> 根因：commander 误 fork "独立 auditor leaf" 走 V10-auditor-active（`resolveAuditorIndep` 闸门3），冷启动期陷入"自己 done 需 audit_pass → 需独立 auditor → 自己"的**循环依赖（无法自启动）**。
> 正解：引擎 `resolveAuditorIndep` **闸门2**（tree-engine.cjs L2241-2255）允许 root 当任意 worker 的 auditor（信任锚），repro 场景 B 实证 10/10 全通过。**引擎不需要改，是协议必须教对。**

### §13.0 前置术语（必读，否则 §13.3 看不懂）

- **caller**：mcp__tree__* 工具调用方的 Proma session_id，引擎从 MCP context 自动提取（**工具签名里没有 caller 参数，它是隐式的**）。commander 调 → caller=root.session_id；worker 调 → caller=worker.session_id。
- **root.session_id 怎么拿**：`mcp__session__get_my_session_id()` 的返回值就是 root.session_id（commander 自己的 session_id）。
- **caller=worker 的步骤怎么执行**：commander 用 `send_message` 给 worker 发指令（如"请调 mcp__tree__tree_event_append(type=done, meta={...})"），worker 收到后按 tree-worker SKILL 自己调（caller=worker 自动满足）。⚠️ commander 绝不能代调 caller=worker 的工具（→ `E_BORROWED_IDENTITY`）。
- **V10-auditor-active**：引擎判定一个 leaf 可当独立 auditor 的三条件——`status=done` + `events` 非空 + `audit_gate.verdict=pass`。冷启动期没有任何 leaf 满足它（所以才需要 root 信任锚）。
- **多层级树（≥3 层）下的 'root' = 树根 leaf（macp5 新增）**：`leaf_id` 形如 `<tree_id>-root`，`role=root`，**≠ 当前 L2 commander**。L2 commander 读 §13.3 凡见 `caller=root` / `audit_session_id=root.session_id`，都指**树根 leaf 的 session_id**，不是 L2 commander 自己的 session_id。L2 commander 用 `get_my_session_id()` 拿到的是 `commander.session_id`，不能用来填 `root.session_id`（→ `E_BORROWED_IDENTITY`，caller=commander≠root）。L2 commander 自己想 done 须走 §13.3b。

### §13.1 冷启动期判定

冷启动期 = 树内尚无任何满足 V10-auditor-active 的 leaf（`status=done` + `events` 非空 + `audit_gate.verdict=pass`）。首个 worker 完成 done 之前都是冷启动期。

### §13.2 冷启动期 auditor = root.session_id（commander 自己）

冷启动期所有 worker 的 milestone audit_pass + alignment 回填 + audit_gate pass，`auditor_session_id` 一律填 `root.session_id`，由 commander 自己调用（`caller=root.session_id === audit_session_id`）。

🔴 **冷启动期绝不要 fork "独立 auditor leaf" 并让它自审**——闸门3 V10-auditor-active 三连对冷启动 leaf 是循环依赖（自己 done 需 audit_pass → 需独立 auditor → 自己，无法自启动），这是 nanju-iter2 死锁根因。冷启动期定义见 §13.1；何时转正常期（可派独立 auditor leaf）见 §13.4。

### §13.3 root 给 worker 配齐 done 前置（严格顺序，repro 场景 B 实证 10/10）

> **步骤映射主流程**：步骤 0-2 属 §4 Step2 下发期；步骤 3-4 属 §4 Step3 事件路由（worker brief_echo → commander 回填 alignment）；步骤 5-7 属 §4 Step4 质量门。
> ⚠️ 若树的 `audit_meta.review_required=true`（ISS-003 opt-in），步骤 5 前还需 worker 产 ≥1 条 review_round event（末轮 red_count=0，见 §4 Step4 / tree-worker §4.6），否则步骤 7 被 `E_REVIEW_NOT_CONVERGED` 拦。

**§13.3 步骤前置条件表**（撞错即翻；列=步骤｜调用者｜前置条件｜产物｜漏做触发的错误码）：

| 步骤 | 调用者 | 前置条件 | 产物 | 漏做触发 |
|------|--------|---------|------|---------|
| 0. root 写 plan/status_check event | root | tree_init 已完成 | root.events 非空（闸门2 前置，只增不减，做一次永久满足） | 闸门2 不放行 → 后续 audit 全卡 |
| 1. milestone_add（含 expect_outputs） | root | 步骤 0 + leaf_add 完成 | worker 的 milestones 列表 | 步骤 2 无 milestone 可 set |
| 2. milestone_set_result（audit_pass=true） | root（audit_session_id=root.session_id） | 步骤 1 | worker milestone audit_pass 留痕 | 步骤 7 `E_SCHEMA_INVALID（milestone 未 audit_pass）` |
| 3. brief_echo 首条（worker 自发） | worker | 收到 5 件套 | worker.events 首条 brief_echo（无 alignment） | 步骤 4 无对象可回填 |
| 4. brief_echo alignment 回填 | root（auditor_session_id=root.session_id） | 步骤 3 | worker.events 多一条带 alignment 的 brief_echo（V5b 硬前置） | 步骤 6 `E_ALIGNMENT_NOT_VERIFIED` |
| 5. done event（带 self_check） | worker | 步骤 4 + 干活完成 + deliverables 落盘 | worker.events done 留痕 | — （worker 漏做则永远到不了步骤 6） |
| 6. audit_gate pass | root（caller===audit_session_id） | 步骤 4 + 验收 Agent verdict.pass | worker.audit_gate.verdict=pass | 步骤 7 `E_GATEKEEPER_REQUIRED` |
| 7. set-status done | worker | 步骤 0-6 全过 + deliverables 落盘 | worker.status=done | `E_DELIVERABLE_MISSING` / `E_GATEKEEPER_REQUIRED` / `E_SCHEMA_INVALID（milestone未pass）` / `E_REVIEW_NOT_CONVERGED（review_required=true时）` |

> **caller 标注说明**：`root` = commander 自己调（caller=root.session_id）；`worker` = commander 用 `send_message` 让 worker 自己调（caller=worker.session_id）。commander 绝不能代调 caller=worker 的步骤（→ `E_BORROWED_IDENTITY`）。
> **review_required 提示**：若 `audit_meta.review_required=true`，步骤 5 的 done event 之前 worker 必须先产 ≥1 条 `review_round` event（末轮 `red_count=0`，总轮数 ≤3），否则步骤 7 被 `E_REVIEW_NOT_CONVERGED` 拦（见 §4 Step4 / tree-worker §4.6）。

```text
[caller=root]  0. tree_event_append(tree_id, leaf_id=<root>, type=plan|status_check)  # root.events 非空（闸门2 前置；events 只增不减，一旦非空永久满足，无需每个 worker 都重做此步）
[caller=root]  1. tree_milestone_add(tree_id, leaf_id=<worker>, milestone=<含 expect_outputs>)
                  # expect_outputs = deliverables/ 下相对路径数组；禁绝对路径 / 禁 ../ 遍历 / 禁 symlink
[caller=root]  2. tree_milestone_set_result(tree_id, leaf_id=<worker>, milestone_id,
                  audit_pass=true, audit_session_id=<root.session_id>)        # 闸门2 放行
[caller=worker]3. tree_event_append(tree_id, leaf_id=<worker>, type=brief_echo,
                  meta={my_understanding, milestones_preview})                # 无 alignment
[caller=root]  4. tree_event_append(tree_id, leaf_id=<worker>, type=brief_echo,
                  meta={alignment, auditor_session_id=<root.session_id>})     # 闸门2，V5b 前置；alignment 填评估如 "0.92 (aligned)"
                  ── worker 干活，把产出写入 deliverables/<expect_outputs 声明的相对路径> ──
[caller=worker]5. tree_event_append(tree_id, leaf_id=<worker>, type=done,
                  meta={self_check})                                          # self_check = 非空 [{item,pass,evidence}] 数组（schema 见 tree-worker SKILL §3.1）
[caller=root]  6. 派验收 Agent（§9）→ verdict.pass → tree_audit_gate(tree_id, leaf_id=<worker>,
                  verdict=pass, audit_session_id=<root.session_id>)           # caller===audit_session_id，闸门2 放行
[caller=worker]7. tree_leaf_set_status(tree_id, leaf_id=<worker>, status=done)  # 全 8 道门禁通过；deliverables 须已落盘
```

⚠️ 关键约束（引擎硬校验，违反即拦）：
- **步骤 0**：root.events 必须非空才能命中闸门2（root init 后 events 默认空，须先写一条 plan/status_check）
- **步骤 1**：expect_outputs 声明的每个文件必须在步骤 7 前真实落盘到 `<treeDir>/deliverables/<outPath>`，否则步骤 7 `E_DELIVERABLE_MISSING`
- **步骤 5**：done event 必须 worker 自己写（caller=worker），commander 代写被 `E_BORROWED_IDENTITY` 拦
- **步骤 6**：audit_session_id 必须 = 调用者（root）的 session_id，否则 `E_BORROWED_IDENTITY`；worker 不能自己调步骤 6；步骤 4 的 alignment event 是步骤 6 的硬前置（V5b），缺则 `E_ALIGNMENT_NOT_VERIFIED`
- **步骤 7**：set-status done 必须 worker 自己调（caller=worker）。commander 做完步骤 6（audit_gate pass）后 send_message 通知 worker “audit_gate pass，你可以 set-status done”——但执行者是 worker。commander 代调步骤 7 → `E_BORROWED_IDENTITY`

### §13.3a root 自身 done（不走 §13.3 八步）

> **本节 'root' 指树根 leaf（role=root）**。单 commander 树（macp2/macp3，root===commander 自己）下本节直接适用；**多层级树（≥3 层）下 root 是独立的树根 leaf，L2 commander 不能用本节路径给自己 done**（L2 commander 自己调 milestone_set_result(audit_session_id=commander) 撞 L3107 `auditor is the leaf itself`（L3061 找 rootLeaf 失败后落到 L3107；L3091 不触发，因 commander.added_by=root≠commander）；填 audit_session_id=root 撞 L2341 `E_BORROWED_IDENTITY`）。L2 commander done 须走 §13.3b。

引擎 L1765 已豁免 root milestone 非空门禁（macp4 P0-E 修复，`if(!isAuditor&&!isRoot)` + L1763 注释自证），root done 走 §13.3a.1 正常路径即可，无需备选分支。auto_upgrade 机制处理 audit_gate（skip→pass），milestone 非空门禁对 role=root 不生效。

#### §13.3a.1 正常路径（引擎 L1765 已豁免）

条件：引擎 L1765 对 role=root 有豁免（`!isAuditor && !isRoot`，macp4 P0-E 已修），或 root 已有 milestone。
操作：引擎 auto_upgrade 机制（tree-engine.cjs L1961-1972）——root 写自己的 done event（caller=root，带 self_check）→ audit_gate 自动从 skip 升为 pass（auto_upgrade=true）→ set-status done 引擎全部门禁通过（milestone 非空门禁对 root 豁免，不查）。

```text
[caller=root]  tree_event_append(tree_id, leaf_id=<root>, type=done, meta={self_check})  →  tree_leaf_set_status(tree_id, leaf_id=<root>, status=done)
```

#### §13.3a.3 诊断（set-status done 撞墙时）

root 调 set-status done 返回错误时：
- `E_SCHEMA_INVALID` → 引擎 L1765 已豁免 root milestone 非空门禁（macp4 P0-E），正常不撞此错。若仍撞，先确认引擎版本/补丁已部署（旧构建无 P0-E 豁免）；若 milestones 有值但某条 audit_pass=false → milestone_set_result 补过（audit_pass 不在 root 豁免范围，仍需补）。
- `E_GATEKEEPER_REQUIRED` → 检查是否写了 done event（auto_upgrade 依赖 done event 触发）。
- 非以上错误码 → 翻 §13.7 速查表或 `tree_help(topic=<error.code>)`。

这也解释了 root 两种 event 的不同作用：① 写 plan/status_check → root.events 非空（满足闸门2 对 rootLeaf 的 events 要求，即 §13.3 步骤0 的前置）；② 写 done → 触发 auto_upgrade，root 自身 audit_gate 升 pass（满足 root 自己 set-status done 的门禁 L1399）。注意：闸门2 对 rootLeaf（L2247-2252）只校验 status + events，**不校验 root 自己的 audit_gate**——所以步骤0 只需写 plan 让 events 非空即可，不必先 done。

### §13.3b L2 commander 多层级 done 路径（macp5 新增，macp4 V10 张力实证）

> macp4 实证：多层级树（≥3 层）L2 commander 想给自己或自己子树 worker 配 done 门禁时，撞 V10 三路径墙：①`audit_session_id=root` → `E_BORROWED_IDENTITY`（caller=commander≠root，L2341 拦）②`audit_session_id=commander 自己` → `E_AUDITOR_NOT_INDEPENDENT`（L3061 找 rootLeaf 失败 + L3091 `auditor=added_by`，因 worker.added_by=commander）③`audit_session_id=auditor` → `E_BORROWED_IDENTITY`（caller≠auditor）。唯一解 = root 代调（caller=root===audit_session_id=root，L3061 root-as-auditor 放行），但依赖 root 活。

**适用场景**：多层级树（≥3 层），L2 commander 要给自己子树 worker（或自己）配 milestone_set_result/audit_gate。

**正确树结构（关键，避免 macp4 结构错误）**：
- ✅ **auditor 挂 root 子节点**（commander 的兄弟）：`parent=root`。root 给 auditor 配门禁走 L3061 root-as-auditor 分支；auditor done 后给 commander 子树 worker 配门禁（auditor≠worker.added_by=commander，L3091 不拦）。
- ❌ **auditor 挂 commander 子树**（macp4 错误）：`added_by=commander`。commander 永远无法给 auditor 配门禁（L3091 `auditor=added_by`），auditor 永远 done 不了。

**root 代调协议**：
```text
L2 commander 给自己子树 worker 配门禁:
  1. commander send_message(root, "请代调：
       tree_milestone_set_result(tree_id, leaf_id=<我的 worker>, milestone_id,
         audit_pass=true, audit_session_id=<root.session_id>) +
       tree_audit_gate(tree_id, leaf_id=<我的 worker>, verdict=pass,
         audit_session_id=<root.session_id>)")
  2. root 代调（caller=root === audit_session_id=root，L3061 root-as-auditor 放行）
  3. commander 收 ack → send_message(worker, "audit_gate pass，你可以 set-status done")
  4. worker 自己 set-status done（caller=worker）
```

> 📝 **macp5 实战发现：commander 自己 done 不需 audit_gate 代调**（macp5 实证 + 观察员 MiniMax-M3 异厂商核验）：commander 角色 audit_gate.verdict 初始="skip"（引擎设计如此，非临时状态），写 done event + set-status done 直接放行，**无需 root 代调 audit_gate**（区别于 root 的 P0-E auto_upgrade=true —— root 有 auto_upgrade 标志，commander 没有）。commander 自己 done 实际只需：① `tree_milestone_add` 给自己（caller=commander）② send 请 root 代调 `milestone_set_result`（audit_pass=true, auditor_session_id=root）③ 写 done event（self_check 3+ items）④ `tree_leaf_set_status(done)`（caller=commander）。**可省 audit_gate 代调步骤**（macp6 候选简化；实战发现 root 代调 audit_gate 反撞 E_AUDIT_PREMATURE "no done event"，commander 写 done event 后直接 set-status done 即可）。

**root idle 3 道防线**（macp4 实证 root idle gap：fire-and-forget 派 root 后 root 处理首条 brief 即 idle，后续 send 撞 SDK 队列死锁"上一条消息仍在处理中"，但 `get_session_context` 返回"No usage data yet"——SDK 误判 idle 为"处理中"）：
- **防线 1（活性探测前置，必做）**：commander 请 root 代调前，先 ping `mcp__session__send_message(root.session_id, "<ping>", wait=true)`，3-5s 超时。wait=true 在 SDK 正常时秒回；root idle 时撞"上一条消息仍在处理中"或超时 → 探测失败，转防线 3。
- **防线 2（派遣期预防，写进 tree-iterative-development SOP §2.2）**：父会话派 root 指挥官用 `wait=true`（强制持续 turn），或 fire-and-forget 派后立即发 1 条 ping 确认活。这是父会话职责，不是 L2 commander。
- **防线 3（root idle 应急）**：
  - 3a **转 2 层树（推荐）**：prune 中间 commander 层 → root 直管 worker → 绕开"L2 commander done"问题。适用 commander 主要做中转、自身无重产出的场景。
  - 3b **§13.6 极端应急**：done event + archived 形式闭环（非首选，最后兜底）。

**三路径撞墙诊断**（撞 E_BORROWED_IDENTITY/E_AUDITOR_NOT_INDEPENDENT 时）：
- 查是否走了"commander 自己配门禁（audit_session_id=commander 或 audit_session_id=root 但 caller=commander）"错误路径 → 改走 root 代调协议。
- 查 auditor 是否挂错位置（commander 子树而非 root 子节点）→ 重建 auditor leaf（parent=root）。

#### §13.3b 接力协议补章（macp6 实证，macp7 新增）

> macp6 实战暴露：root context 胖时派 v2 接力（`tree_segment_add` **只追加 segment_chain + 改 status=segment_pending，不改 session_id 也不改 added_by**——纯上下文接力，非权限接力）。root 引擎自建 added_by=null，v2 接力后 **leaf.session_id 仍=旧 root、added_by 仍=null** → v2 既非 owner（session_id≠v2）也非 creator（added_by=null）→ v2 调 set-status/set-session/milestone_set_result 全撞 `E_BORROWED_IDENTITY`（cmdLeafSetStatus L1733 `_isOwner` + cmdLeafSetSession L2164 creator + cmdMilestoneSetResult L2341 caller===audit_session_id 三重校验，macp6 drift 19:11:04 实证）。

**身份继承矩阵**（v2 接力后，哪些工具 v2 可自调 / 哪些需旧 root 代调）：

| 工具 | v2 可自调？ | 原因 |
|------|------------|------|
| `tree_event_append` / `tree_leaf_get` | ✅ v2 可自调 | 无 owner/creator 校验 |
| `tree_milestone_add` | ❌ 需**旧 root** 代调（macp9 论证修正）| cmdMilestoneAdd L2248 `_isOwner/_isCreator/_isRootSelf` 三重校验，v2 接力后三项全 false 撞 E_BORROWED_IDENTITY（macp7 原标"可自调"错）|
| `tree_audit_append` | ❌ 需 auditor 自调（V10-active）或旧 root 代调 | dispatchAudit L3974 caller 校验（macp9 补）|
| `tree_milestone_set_result(audit_pass=true)` | ❌ 需**旧 root** 代调（caller=旧 root===audit_session_id=旧 root）| V10 caller===audit_session_id 硬约束，audit_session_id 仍指向旧 root |
| `tree_audit_gate(verdict=pass)` | ❌ 需**旧 root** 代调（同上）| 同上 |
| `tree_leaf_set_status(done)` | ❌ 需**旧 root** 代调或先 `leaf_set_session` 转所有权 | cmdLeafSetStatus L1733 双重校验：`_isOwner=caller===leaf.session_id(旧root)` + milestone；v2 非 owner 撞 E_BORROWED_IDENTITY |
| `tree_leaf_set_session`（转所有权）| ❌ 需**旧 root** 代调（caller=旧 root） | cmdLeafSetSession L2158+ creator 校验；v2 调撞 E_BORROWED_IDENTITY。**旧 root 代调后 session_id=v2，v2 成 owner 可自调 set-status**。无 CLI 应急通道（生产构建已禁用，见下方"CLI 应急通道已禁用"） |
| `tree_segment_add` | ✅（v2 可调，接力用）| 接力机制本身（只追加 segment_chain）|

**emergent v2 + 旧 root 协作模式**（macp6 涌现有效，macp9 论证精化）：
- **旧 root 担当"权限锚"**：代调 milestone_add + milestone_set_result + audit_gate + set-status + set-session（caller=旧 root 满足 owner/creator/V10 校验）；代发 send_message 激活 auditor
- **v2 担当"上下文接力"**：**只能** event_append + leaf_get + 写报告 + 读 comm_log（macp9 修正：macp7 说"v2 做 milestone_add/set-status"错，**全需旧 root 代调**——v2 接力后 leaf.session_id 仍=旧 root、added_by=null，v2 既非 owner 也非 creator）
- **协作约定**：旧 root 接力后主动 `send_message(v2, "接力交你。约束：除 event_append/leaf_get 外，全需我代调（milestone_add/set_result/audit_gate/set-status/set-session）。我 segment_pending 待命")`

**旧 root 失联预案**（macp9 补，macp6 实战 Stream closed 教训）：
- v2 接力后先 `send_message(旧root, "<ping>", wait=true)` 短超时（10s）探测旧 root 活性
- 旧 root 活 → 走 emergent 协作（旧 root 代调）
- 旧 root 失联（ping 超时/撞"消息处理中"）→ v2 上行父会话请求补发 brief / 干预 + `tree_drift_append(severity=high, reason='旧 root 失联，v2 上行父会话请求干预')` 留痕（生产构建无 CLI 应急通道，已禁用）
- 失联超 10 分钟 → v2 上行父会话请求干预（或转 §13.6 极端应急）

**多级接力权限锚归属**（macp9 补）：
- v1→v2 接力：权限锚=v1（旧 root）
- v2→v3 接力：权限锚仍=**v1**（added_by 链源头，不是 v2）；v3 调工具 caller=v3，仍需 v1 代调
- 多级接力时，所有 v_n 的权限锚都是 v1（树根 root.session_id）
- 🔴 **建议避免多级接力**：context 溢出优先用 `leaf_set_session` 一次性转所有权给新 session（旧 root 代调一次，v2 成 owner 后自调），而非 segment_add 链（每级都需 v1 代调）

**CLI 应急通道已禁用**（配合引擎 P0-1 关闭 CLI 兼容通道）：CLI 直接调用引擎入口（省略 callerSessionId 的兼容写法）已在生产构建禁用——caller 缺省抛 `E_CALLER_REQUIRED`，仅 `TREE_ENGINE_ALLOW_CLI=1` 测试模式放行。v2 撞 E_BORROWED_IDENTITY 卡死时**不再有 CLI 兜底**，应对走：① 父会话补发 brief（本节"旧 root 失联预案"现有协议，上行父会话请求干预）+ ② 平台修复（tree_init 强制启动 root agent / 模型切换不应丢 MCP 工具集，从源头消除 root idle）。

### §13.4 转正常期

首个 worker done 后，若需长期独立 auditor（复杂树多 worker 并行审查）:
- commander 用 §13.3 流程把一个 auditor leaf 喂到 V10-auditor-active（repro 场景 A 实证：root 先给 auditor leaf 配齐，auditor leaf 自己 done 后即合格）
- 之后该 auditor 走闸门3 审后续 worker（auditor 自己调 audit_gate，`caller=auditor.session_id`）

#### §13.4.0 建 auditor leaf 协议（P0-A，macp2 改进）

macp2 暴露 audit 门禁全回流 root 的问题——不是引擎禁止独立 auditor，而是 commander 不知道建 auditor leaf。引擎 `resolveAuditorIndep` 闸门2→闸门3 已完全支持（零引擎改动）。按以下四步流程，commander 可建独立 auditor leaf 给全树配门禁：

> ⚠️ **多层级树（≥3 层）auditor 挂载位置（macp5 新增）**：auditor leaf **必须挂 root 子节点**（`parent=root`，是 commander 的兄弟 leaf），由 root 建（`added_by=root`）或 commander 建（`added_by=commander` 但 `parent=root`）。**绝不能挂 commander 子树下**（`parent=commander`）——若 auditor.added_by=commander 且 commander 想给它配门禁，撞 L3091 `auditor=added_by` 自审禁令；auditor 永远 done 不了（macp4 结构错误实证）。正确做法见 §13.3b"正确树结构"。

```text
步骤 A: commander fork 一个 role=auditor leaf
  mcp__tree__tree_leaf_add(tree_id, leaf={role='auditor', parent=<commander/root>, ...})
  → 引擎不禁止（只禁 worker/auditor 担任 added_by，root/commander 可建 auditor leaf）

步骤 B: auditor leaf 完成自身工作（≥2 events 强制 + schema 提示，macp8 补充）
  auditor leaf 走简化协议：① `tree_event_append(type=brief_echo)` 复述审查任务理解 ② `tree_event_append(type=done)` 含 verdict
  🔴 **set-status done 前必须 ≥2 events**（brief_echo + done），满足 V10-auditor-active 的 "events 非空" 条件（macp6 实证 auditor 需 events 非空）
  → auditor leaf status=done + events ≥2 + audit_gate 初始='required'
  🔴 **audit_append 时 `report.results[]` 每项必须含 `severity ∈ red|yellow|green`**（v0.21 强制，缺抛 `E_SCHEMA_INVALID`；macp6 C/auditor 撞此错自纠正，浪费轮次）

步骤 C: root 用闸门2 背书 auditor leaf
  🔴 **前置（macpaf 2026-07-29 实证）**：root 背书前需 `root.events ≥ 1`（引擎 minimum activity guard：root leaf events 空时背书撞 `E_AUDITOR_NOT_INDEPENDENT`）。**冷启动 root 首次背书前先发 1 条 plan event**：
    mcp__tree__tree_event_append(tree_id, leaf_id=<root>, type='plan', meta={plan:'冷启动 root 调度，准备背书 auditor'})  // 仅首次需要，后续 root.events 已非空
  mcp__tree__tree_audit_gate(tree_id, leaf_id=<auditor>, verdict='pass', audit_session_id=<root.session_id>)
  → 闸门2（root 信任锚）放行 → auditor.audit_gate.verdict=pass
  → auditor leaf 满足 V10-auditor-active 三连（done + events 非空 + audit_gate=pass）

步骤 D: auditor leaf 自主给全树任意 leaf 配门禁
  auditor 自己调 audit_gate / milestone_set_result（caller=auditor.session_id，走闸门3）
  → 闸门3 查 auditor status=done ✅ + events 非空 ✅ + audit_gate=pass ✅ → 放行
  → auditor 可以给任意 worker leaf 配门禁，不限子树范围
```

#### §13.4.0a 待审 worker 清单维护流程（macp4 新增，防 C2 遗漏）

> macp3 C2 遗漏异厂商审查的根因：中转链（commander→root→auditor）中 root 没有"待审队列"视角，最后一个 done 的 worker 从指间滑落。以下 6 步流程教 root 维护待审清单：

```text
root 在中转链上的待审清单操作（6 步）:
  1. 【记】每当 commander 派 worker → root 在待审清单记一行
     {leaf_id, commander, auditor, status='pending_done'}
  2. 【更】worker done → 更新 status='pending_audit'，准备中转给 auditor
  3. 【转】root 中转审查请求给 auditor（macp4 P1-B R7-sibling-send 已让兄弟直发，可省中转；
     未启用直发时仍走 root 中转）→ 更新 status='in_audit'
  4. 【划】auditor 审完（audit_gate pass）→ 更新 status='audited'，划掉
  5. 【催】定期核对清单：status='pending_audit' 超过 N 分钟未进入 'in_audit' → 主动催 auditor
  6. 【验】全树 done 前做最终遍历：清单中 status!='audited' 的按条排查。清单非空但 worker 全部 done
     → 遗漏异厂商审（macp3 C2 教训），必须补审

清单格式建议: .context/pending-audit.md（markdown 表格，每行一个 worker）
全清单空 = 审查闭环完成。
```

**关键认知**：
- macp2 中 audit 全回流 root 是 SKILL/流程层问题，引擎闸门2→闸门3 已天然支持（见 engine-evaluation.md P0-A 论证）
- 冷启动期仍需 root 走闸门2（§13.2），auditor leaf done+pass 后立即转入正常期
- auditor done 后 set-status 同样要 auditor 自己调（P1-C 规则）
- 引擎 `resolveAuditorIndep` 闸门3 要求 auditor 自己 status=done + events 非空 + audit_gate=pass——这就是"V10 冷启动约束":冷启动期无任何 leaf 满足它，必须 root 通过闸门2 打破死锁，步骤 C 正是此意
- 即：**root 只在冷启动期当 auditor，正常期交给独立 auditor leaf**

#### §13.4.6 fix leaf 反馈闭环（Gap B，v2.9.1 合并自 Pro v0.22）

> **场景**：auditor 完成 audit_append（leaf.audit_log 含 findings）后，severity≠green 的 findings 需要修复闭环——worker "非 red 不修" + auditor findings 无 fixer 回修 = 实战暴露的系统 gap（non-green findings 进"已知但未修复"真空）。

**闭环流程**（commander 编排）：
1. auditor 完成 audit_append → leaf.audit_log 含 findings（severity red/yellow/green + item/evidence）
2. commander 读 audit_log → 过滤 severity≠green 的 findings → 生成 fix_brief
3. **派 fix leaf**（create_session，role=worker，brief 含 audit_log findings + 原始 worker deliverables 路径）：
   - fix leaf 修每项 finding → edit_file（改产物）/ downgrade（降级附理由）/ deferred（推迟）
   - fix leaf done event meta 含 `fixes_resolved`：`[{finding_ref, fix_method: edit_file|downgrade|deferred, fix_evidence ≥20字}]`
4. **auditor 复审 fix leaf**（audit_gate + audit_append，确认修复有效）
5. fix leaf done（auditor 复审 pass）

**关键约束**：
- fix leaf 是 role=worker（不是 auditor），走完整 worker 协议（brief_echo + milestone + done + audit_gate）
- fixes_resolved 必须覆盖 audit_log 中所有 severity≠green 的 findings
- 与 §14.2 fix 区别：§14.2 fix 是审计任务批量修正（审被审文档）；§13.4.6 fix 是独立审 worker 产物的反馈闭环
- 🔴 **fix leaf 派出后立即回填 alignment=1.0**：fix leaf 是修正任务（edit/downgrade/defer），不需要重评对齐度——commander 派 fix leaf 后立即 `tree_event_append(type=brief_echo, meta={alignment:"1.0", auditor_session_id=root.session_id})` 到 fix leaf，不等 fix leaf 自己 brief_echo（避免 V5b 死锁）
- 🔴 **状态机 gap 应急——上行 blocked，不直改 JSON**：如果 root done 被引擎拦，commander 上行 `blocked` 请示编排方（send_message + tree_event_append type=blocked）。**绝对不要直改 tree-state.json 文件**——绕过门禁=破坏审计链

**与 yellow_findings_resolved（P1b）协同**：worker 自己 review_round 的 yellow → yellow_findings_resolved（worker done event）；auditor 发现的 yellow/red → fix leaf 闭环（§13.4.6）。两层闭环。

### §13.5 SDK SubAgent 的位置

对齐度评估、验收等"智力活"可用 SDK SubAgent（researcher / code-reviewer），但 SDK SubAgent 无 Proma session_id，**不能当引擎 auditor**。`auditor_session_id` 永远填 `root.session_id`（冷启动）或独立 auditor leaf session（正常期）。

### §13.6 极端应急 + idle 多维核验

#### §13.6.0 idle 探测多维核验（macp6 实证，macp7 新增）

> macp6 实战暴露：J-commander 实际 21:50 已完成缺陷修复（J-fix-report.md + typecheck/build/探针三重验证），但 send_message 撞"上一条处理中"队列锁 + `get_session_context` 返回"No usage data yet"（假信号）→ root 22:00 误判 J idle → prune + 重派 J2，**浪费 J 实质修复产出 ~10min**（J2 验证式接力补救）。

**根因**：idle 探测单一信号不可靠。SDK 队列锁 ≠ session idle（可能正在产出）；"No usage data" ≠ 真 idle（GLM-5.2 context 计算也不准，见 memory `glm-context-calc-inaccurate`）。

**多维核验清单**（判断 leaf idle 前必须全查，任一非 idle 信号即不 prune）：
1. **产出文件 mtime**：`ls -la <treeDir>/deliverables/` 看 worker 产出文件最近改动时间（10min 内有改动 = 正在产出，非 idle）
2. **tool calls 计数**：`mcp__session__list_messages(leaf.session_id, limit=5)` 看最近是否有 assistant 消息（有 = 近期活跃）
3. **send ping**：`send_message(leaf.session_id, "<ping>", wait=true)` 短超时（5-10s），秒回 = 活；撞"上一条处理中"或超时 = 可能 idle（但需结合 1+2 确认）
4. **heartbeat / last_event**：`tree_leaf_get` 看 last_event_ts + drift_history（最近有 event = 活）
5. **communication_log**：`tree_communication_list(tree_id, leaf_id=<leaf>)` 看该 leaf 最后一条 comm_log 出站时间 + 对方是否回应（§6 强制记 comm_log 的核心目的就是防误判 idle——外部 send_message 活动 tree events 看不到，comm_log 是唯一留痕，比 usage_pct 更可靠）。近期有出站 comm_log + 对方有回应 = 活，非 idle

**判定规则**：5 项中 ≥2 项指向 idle 才 prune；仅"No usage data"或单次 send 撞锁 ≠ idle（可能是队列锁或假信号）。

**避坑**：GLM-5.2 的 `get_session_context.usage_pct` 虚高（如 661% 实际未溢出）不可信；判断 session 卡死必须主动 ping 核实，不能轻信遥测（用户纠正，macp6 实证）。

#### §13.6.1 极端应急（引擎/协议彻底失效时）

若上述流程因引擎 bug 或协议冲突彻底走不通（参考 nanju-iter2 降级 A）:
- 应急形态 = `create_session` 新建 b-worker（commander 作 owner）+ 产出直落 `deliverables/` + 跳过 tree leaf done 门禁
- 这是"形式死锁但内容必须交付"的最后兜底，**非首选**；优先排查 §13.1-§13.4 是否执行到位

### §13.7 错误码速查表（撞错即翻）

> 撞到任一错误码先翻此表；表没覆盖的，看工具返回里的 `help_topic` 字段。所有 `mcp__tree__*` 工具失败统一返回 `{ok:false, error:{code, message, help_topic?}}`。

| 错误码 | 哪步触发 | 含义 | 修复方法 |
|--------|---------|------|---------|
| `E_DUPLICATE_SESSION_ID` | `leaf_add` | 该 `session_id` 已被别的 leaf 注册（一 session 不能挂多 leaf） | worker 重新 `fork_session` 拿一个新 `session_id`，再用新 id 重新 `leaf_add` |
| `E_BORROWED_IDENTITY` | `leaf_add` / `leaf set-session` / `milestone set-result` / `done` event / `audit_gate` / `audit_append`（多处 caller≠audit_session_id 校验） | caller（调工具的 session）≠ `audit_session_id`（冒名背书） | commander 把"该 worker 调的工具"通过 `send_message` 让 worker 自己调；冷启动期 `audit_session_id` 永远填 `root.session_id`（详见 §13.2/§13.0）。**多层级树（≥3 层）**：L2 commander 给自己子树 worker 配门禁时填 `audit_session_id=root.session_id` 但 caller=commander≠root → 撞此错；改走 §13.3b root 代调协议 |
| `E_AUDITOR_NOT_INDEPENDENT` | `milestone set-result` / `audit_gate`（`resolveAuditorIndep` 闸门，L3061/L3091） | auditor 不独立：`audit_session_id` 填了自己（caller===audit_session_id 但被审 leaf.added_by=auditor）或 auditor 不满足 V10-auditor-active | **单 commander 树**：冷启动期 `audit_session_id` 填 `root.session_id`，由 root（commander 自己）调。**多层级树（≥3 层）**：L2 commander 填 `audit_session_id=commander 自己` → L3091 `auditor=added_by`（worker.added_by=commander）→ 撞此错；改走 §13.3b root 代调协议。auditor leaf 须 V10-active（done+events+gate=pass）才能审别人 |
| `E_AUDIT_PREMATURE` | `audit_gate pass` | 步骤6 audit_gate pass 时，被审 leaf 的 events 里还没有 done event（步骤5 done event 漏做，或步骤顺序反了：6 跑在 5 之前） | 先让 worker 写 done event（步骤5），再调 `tree_audit_gate(verdict=pass)`（步骤6） |
| `E_SELFCHECK_INVALID` | `done` event | `self_check` 不是 `[{item,pass,evidence}]` 数组（缺字段/格式错） | 改 schema 见 tree-worker SKILL §3.1（每项必须有 `evidence` ≥10 字证据；至少 1 项 `pass=true`（全 false 与 done 矛盾，V6 拦截）） |
| `E_DELIVERABLE_MISSING` | `set-status done` | `expect_outputs` 声明的文件未落盘到 `deliverables/` | 让 worker 把产出写到 `<treeDir>/deliverables/<outPath>`（相对路径，禁绝对路径/symlink）后重试 |
| `E_ALIGNMENT_NOT_VERIFIED` | `audit_gate pass` | worker 的 events 缺 alignment 回填（§13.3 步骤4 漏做） | commander 回填一条 `brief_echo` event（`meta={alignment, auditor_session_id=root.session_id}`），见 §6 回填机制 / §13.3 步骤4 |
| `E_GATEKEEPER_REQUIRED` | `set-status done` | 没先 `audit_gate pass` 就直接 set done（缺门禁背书） | 先调 `tree_audit_gate(verdict=pass, audit_session_id=root.session_id)`（§13.3 步骤6）通过后再 set-status done |
| `E_SCHEMA_INVALID` | `set-status done`（root 自身 done） | root 调 set-status done 撞 milestone 门禁（仅旧引擎；macp4 P0-E 后 L1765 已豁免 root） | 引擎 L1765 已豁免 root milestone 非空门禁（macp4 P0-E），走 §13.3a.1 正常路径即可（写 done event → set-status done）。若仍撞此错，确认引擎版本/补丁已部署；milestones 有值但某条 audit_pass=false → milestone_set_result 补过（audit_pass 不在 root 豁免范围） |
| `E_CHILDREN_NOT_DONE` | `set-status done`（commander / 中间层 done） | commander 自己 done 前，子树有未 done 的 leaf（引擎 V10 闸门：父 done 前子须全 done） | 先让所有子 leaf done（或 prune 不再需要的子 leaf），再重试 commander set-status done |
| `E_AUDITOR_NOT_DONE` | `audit_gate pass`（auditor 背书别人时） | auditor leaf 自己还没 done 就去给别人配门禁（V10-auditor-active 要求 status=done） | 先把 auditor leaf 喂到 done（§13.4.0 四步），满足 V10-auditor-active 三连后再背书别人 |
| `E_AUDITOR_NO_EVENTS` | `set-status done`（auditor 自身 done） | auditor leaf events < 2（V10-auditor-active 要求 events 非空，macp6 实证需 ≥2：brief_echo + done） | auditor 先写 ≥2 events（brief_echo 复述审查任务 + done 含 verdict），再 set-status done |
| `E_MAX_SESSIONS` | `leaf_add` / `register_session` / `leaf_set_session` | tree session 数超过 `audit_meta.max_sessions` 上限（防失控蔓延） | 提高 `audit_meta.max_sessions`（tree_init 时设），或 prune/archived 不用的 leaf 释放配额后重试 |
| `E_CALLER_REQUIRED` | 任一 `mcp__tree__*` 工具（caller 缺省） | **P0-1 新增**：caller session_id 缺省即拒绝（生产构建禁用 CLI 兼容通道，省略 callerSessionId 不再跳过校验） | 工具必须从 MCP context 提取 caller（会话内调用自动满足）；CLI 直调引擎入口需带 `TREE_ENGINE_ALLOW_CLI=1` 测试模式 |
| `E_STATE_INTEGRITY` | 任一写操作（tree-state 落盘时） | **P0-2 新增**：tree-state HMAC 校验失败（文件被外部篡改 / 手工编辑破坏完整性签名） | 从最近 backup 恢复（`tree_restore`），或 `tree_validate` 诊断；禁止手工编辑 tree-state.json（§11 #3） |

> **通用排查注**：所有 `mcp__tree__*` 工具失败时返回 `{ok:false, error:{code, message, help_topic}}`。若返回里带 `help_topic` 字段，**立即** `mcp__tree__tree_help(topic=<help_topic>)` 拿该主题详细用法——多数错误根因是参数 schema 或调用顺序错，help_topic 给的就是正解。

---

### §13.8 leaf 主动性收尾（macpaf 2026-07-29 实证）

> macpaf pro 实战发现：leaf（root/commander）做完自己轮次工作后 idle，**没主动对照 `leaf_dod.accept_criteria` 收尾**，需父会话/用户手工提示才 done。根本解是引擎 `child_done` 事件（轮 1 已实施，leaf done → parent 收 child_done 标记），但 **leaf 主动性**仍是必要补充（事件标记 + 主动收尾 = 完整闭环）。

**每个 leaf 每轮结束前必做**：
1. **对照 `leaf_dod.accept_criteria`**：自己的 DoD 是否全满足（不依赖父会话提示）
2. **查 `child_done` 事件**（轮 1 引擎新增）：子 leaf done 后引擎自动给 parent 写 `child_done` event。parent 被 send_message 唤醒时，先查 events 里的 `child_done` 确认依赖是否全满足
3. **自己能闭环的立即 done**：DoD 全满足 + 依赖（子 leaf）全 done → 主动走 done 流程（event done self_check + set-status done），**不等外部触发**。注：worker/root 走此简单路径；**L2 commander（多层级树）done 走 §13.3b root 代调路径**（milestone_set_result + audit_gate 由旧 root 代调），非此 event+set-status 简单路径

**root 主动性**（macpaf 实证 root 易遗漏）：root 是 tree 最终负责人，做完核心调度任务后，主动核 `root_dod.accept_criteria`（如"三 leaf done"），自己能闭环的立即走 §13.3a done，**不因单轮任务边界推后自己的收尾**。

**识别信号**：leaf 做完轮次工作后长期 active、需手工提示才 done → 撞此 gap。查该 leaf 的 DoD + `child_done` 事件 + 主动性。

---

## §14 审计工作流（v2.1 新增）

> 依据：tree-audit-methodology.md v1.0。当任务涉及文档审计/终局验证/可信度审查时，**必须**按本节执行。

### §14.1 何时触发

满足任一条件即进入审计模式：
- 任务 brief 中含 "审计/审查/验证/验收/终局/converge/audit/verify/review" 等关键词
- 需要对一份已完成文档进行可信度评估
- 子会话 done 上报后进入 §4 Step 4 质量门

### §14.2 最小审计树结构（强制执行）

```
{tree_id} (指挥官)
  ├── {tree_id}-fix        — 修正执行员（等审查完成后统一修改）
  ├── {tree_id}-C1         — 一致性审查员
  ├── {tree_id}-C2         — 完整性/闭环审查员
  ├── {tree_id}-C3         — 规范性/格式审查员
  ├── {tree_id}-C4         — 可验证性/证据审查员
  ├── {tree_id}-A1         — 反向映射重构员
  └── {tree_id}-A2         — 反事实攻击员
```

**铁腕要求**：
- **最少 7 个审查 leaf**（4 四维 + 2 攻击 + 1 修正），缺一个都不算完成
- C1-C4 和 A1-A2 必须并行启动（相互独立）
- 修正员（fix）在所有审查员返回后启动
- 禁止指挥官亲自充当审查员（"自己画靶自己打分"）

### §14.3 审计 5 件套模板

下发审查子会话时，在标准 §3 模板基础上，`brief.in_scope` 必须包含**该维度的具体审查问题**。以下为 7 个角色的 in_scope 模板（C1-C4 审查 + A1-A2 攻击 + fix 修正执行员）：

**C1 一致性审查员**：
```yaml
in_scope:
  - "逐项比对报告与上游文档的数字/版本/环境声明是否一致"
  - "用例计数可复算（逐行求和的每一步写出来）"
  - "报告声称的修复项与实际问题列表逐条对照"
  - "时间窗口声称与 session 时间戳是否吻合"
```

**C2 完整性/闭环审查员**：
```yaml
in_scope:
  - "11 个工具是否全部测试（逐一核对，不跳）"
  - "每个工具的错误用例是否覆盖（方案要求 ≥1）"
  - "集成场景是否全部执行（逐场景检查步骤完整性）"
  - "跳过的用例是否有充分理由和替代探索记录"
  - "性能数据是否完整（总耗时、最慢工具精确值）"
```

**C3 规范性审查员**：
```yaml
in_scope:
  - "报告格式是否符合方案模板要求"
  - "严重程度评级是否合理（有无降级/升级）"
  - "结论是否基于证据（非主观判断）"
  - "统计表述是否有误导（'零失败' vs '2跳过'）"
  - "'READY FOR RELEASE' 声明是否满足前置条件"
```

**C4 可验证性审查员**：
```yaml
in_scope:
  - "每个关键声称是否有可验证证据（session ID/时间戳/原始返回值）"
  - "性能数据是否有测量方法说明"
  - "第三方能否根据报告复现测试"
  - "session ID 引用是否完整（禁止短格式）"
  - "报告是否在 git 中固化（非未提交修改）"
```

**A1 反向映射重构员**：
```yaml
in_scope:
  - "忽略报告原有分组，从每条声称反向提取功能验证点"
  - "汇总为功能清单，与上游方案逐项比对"
  - "标记三类差异：遗漏（方案有报告无）/ 冗余（报告有方案无）/ 偏离（都有但不一致）"
  - "特别注意：方案和报告中的编号体系是否对应"
```

**A2 反事实攻击员**：
```yaml
in_scope:
  - "覆盖边界攻击：单频道/单模型的测试能否支撑全频道通用结论？"
  - "结论逻辑攻击：跳过=未覆盖≠通过，统计数据是否误导？"
  - "时间线攻击：声称的时间窗口与实际 session 时间戳是否吻合？报告是否经历多版本迭代但未声明？"
  - "并发场景攻击：核心使用模式是否被跳过？"
  - "至少 5 个具体攻击场景，每个标注：报告能否兜住/失守/部分失守"
```

**fix 修正执行员**（等审查完成后统一修改，§14.2 强制第 7 leaf，必须存在）：
```yaml
in_scope:
  - "汇总 C1-C4 + A1-A2 全部审查员的问题列表，去重后按严重程度排序（blocker / severe / suggestion）"
  - "逐项修复：edit_file（改产物）/ downgrade（降级附理由）/ deferred（推迟附理由），每项 fix_evidence ≥20 字"
  - "fixes_resolved 必须覆盖 audit_log 中所有 severity≠green 的 findings，无遗漏（§13.4.6 闭环要求）"
  - "修复后跑回归测试（typecheck / build / auto_test），确认未引入新问题"
  - "downgrade / deferred 必须附明确理由 + 后续处理计划（不能悄悄降级或无限推迟）"
```

### §14.4 迭代收敛流程

```
Round 1:
  ① Fork C1-C4 + A1-A2（6 个并行）
  ② 收集所有问题列表，去重汇总
  ③ Fix 子会话执行修正
  ④ tree-state 记录 round=1, issues_found=N1

Round 2:
  ⑤ 重新 Fork C1-C4 + A1-A2（6 个并行，只检查修正是否正确、是否引入新问题）
  ⑥ 收集回归问题列表
  ⑦ 判定收敛（三个条件全部满足）：
     a. N2 < N1 × 0.3
     b. 无阻断级或严重级新问题
     c. 所有遗留问题均为"建议"级或"待人类确认"
  ⑧ 不满足 → Fix 再修正 → Round 3
  ⑨ 满足 → tree-state 记录 converged=true, convergence_round=N

严禁行为:
  - 一轮就 declare done
  - 审查员和攻击员复用同一子会话
  - 回归阶段跳过任何维度
  - 未 commit 就声明"READY FOR RELEASE"
```

### §14.5 tree-state 审计记录

每轮迭代在 `_meta` 中追加：

```json
{
  "audit_rounds": [
    {
      "round": 1,
      "issues_found": {"blocker": N, "severe": N, "suggestion": N},
      "issues_fixed": {"blocker": N, "severe": N, "suggestion": N},
      "regression_issues": 0
    }
  ],
  "converged": true,
  "convergence_round": 2
}
```

### §14.6 完成检查表

declare done 前逐项确认：

```
[ ] leaves ≥ 7（1 root + 4 审查 + 2 攻击 + 1 fix 修正员，**强制必须**，与 §14.2 一致）
[ ] 阶段一：4 个审查子会话全部 done，产出结构化问题列表
[ ] 阶段二：2 个攻击子会话全部 done，产出漏洞列表
[ ] ≥ 2 轮迭代，audit_rounds 记录完整
[ ] 收敛三条件全部满足
[ ] tree-state validate() = {ok: true, issues: []}
[ ] 修正后 git commit 完成
[ ] 最终报告头部标注审计轮次和审查子会话 ID 列表
```

---

## §15 修订历史

| 日期 | 版本 | 主要变更 |
|------|------|---------|
| 2026-07-28 | v2.9.8-audit-fix | **审计驱动修订（7 项，auditor MiniMax-M3 要求前置）**：① **P0-3** §13.3a 删除冗余的 root done 备用分支（引擎 L1765 已豁免 root milestone 非空门禁，macp4 P0-E），§13.3a.3 诊断保留原编号 + §13.7 E_SCHEMA_INVALID 行同步更新 ② **P1-1** §11 标题计数 12→17（实际条目数） ③ **P0-5** §14.6 删除修正员 leaf 的 optional 标注，与 §14.2 强制统一 ④ **P1-3** §14.3 补第 7 个 fix 修正执行员 in_scope 模板（序言 6→7 角色） ⑤ **P1-4** §13.7 补 6 个错误码（E_CHILDREN_NOT_DONE / E_AUDITOR_NOT_DONE / E_AUDITOR_NO_EVENTS / E_MAX_SESSIONS / E_CALLER_REQUIRED[P0-1 新增] / E_STATE_INTEGRITY[P0-2 新增]） ⑥ **P1-5** §13.6 idle 多维核验补第 5 项 communication_log 检查（4 项→5 项，判定规则同步） ⑦ 配合引擎 P0-1 关闭 CLI 兼容通道：删 §13.3b CLI 应急通道段（含 CLI 直调引擎的可执行 bash 代码块），改为"生产构建已禁用 / caller 缺省抛 E_CALLER_REQUIRED / 仅 TREE_ENGINE_ALLOW_CLI=1 测试模式放行"，清理身份继承矩阵表格 + 旧 root 失联预案中的 CLI 应急引用 |
| 2026-07-29 | v2.9.9-macpaf-closeout | **macpaf 实战后续（3 轮迭代，配合引擎轮1-2）**：① §13.4 步骤 C 补 **root minimum activity guard**（冷启动 root 背书 auditor 前先发 plan event，macpaf 实证 root.events 空撞 `E_AUDITOR_NOT_INDEPENDENT`）② 新增 **§13.8 leaf 主动性收尾**（每 leaf 每轮对照 `leaf_dod.accept_criteria` + 查 `child_done` 事件[轮1引擎新增] + 自己能闭环的立即 done，不等外部触发；root 不因单轮边界推后收尾）|
| 2026-07-25 | v2.9.3 | **macp4 harness 改进（5 项）**：① **P1-F** §13.3a root done 路径扩展为三子节（正常/备选/诊断）——教 root 用 milestone_add 绕过 L1767 milestone 门禁 ② **P1-G** §13.4.0a 待审 worker 清单维护流程——6 步防 C2 类异厂商审遗漏 ③ **P1-H** §6 brief_echo 回填完成确认清单——5 项硬 checklist 防并发遗漏 alignment 回填 ④ **P2-C** §4 Step2.1a 层级选择指导——3 层 vs 4 层条件表 ⑤ §13.7 加 E_SCHEMA_INVALID root done 门禁说明 + §11 加 #16（漏待审清单）/ #17（漏回填 alignment） |
| 2026-07-25 | v2.9.2 | **macp2 改进（3 项）**：① **P1-C** set-status caller=owner 讲透——§3.4 autonomy 预置 `final_step` 字段 + §13.3 八步末尾加警示（步骤7 worker 自己调，commander 代调→E_BORROWED_IDENTITY）② **P1-A** comm_log 硬 checklist——§4 Step3 必须紧接 tree_log_communication + §11 新增 #15 禁止漏记 + §6 措辞从 advisory 升级为硬要求 ③ **P0-A** 建 auditor 流程——§13.4.0 四步协议教 commander 建独立 auditor leaf（引擎闸门2→闸门3 零改动已支持），auditor done 后可给全树配门禁 |
| 2026-07-25 | v2.9.1 | **合并 Gap B（fix leaf 反馈闭环）自 Pro v0.22**：Pro tree-commander 在 2026-07-17 Gap B 后停止同步，独有 §13.4.6 fix leaf 闭环（auditor 发现 non-green findings → commander 派 fix leaf 修复 → auditor 复审）。本次合并到 release（§13.4.6），保留 release 的 P0-1/P1-1/P1-2（v2.7-v2.9）+ Pro 的 Gap B。修复 nanjuS1 实战暴露的"non-green findings 进已知但未修复真空"系统 gap。 |
| 2026-07-24 | v2.9 | **P1-2 send_message 可观测性**（macp 实战后改进）：macp 实战 root 用 send_message 驱动 worker 但 tree call-log 看不到 → 心跳误判 worker 冻结。新增 `tree_log_communication` / `tree_communication_list` 工具（tree-engine `communication log/list` 命令 + patches.cjs 注册，双渲染器共用 buildTreeTable）。记录 caller→target 活动（**不截内容**），自动定位 target leaf + 更新 last_event_ts（心跳可感知）。方案：tree 工具 + SKILL 协议教化（不自动 hook 核心 IPC，留作观察点）。§5 加 2 工具、§6 加外部通信记录协议、§15 v2.9。 |
| 2026-07-24 | v2.8 | **P1-1 Worker progress 实时反映**（macp 实战后改进）：① 引擎 cmdEventAppend 在 worker 写首条 brief_echo 时自动 `status: pending_brief → active`（解决状态滞后，commander 心跳不再误判 worker 没动；幂等，只在 pending_brief 触发）；② EVENT_TYPE_ENUM 新增 `progress`（11 种），worker 长任务可主动报中间进度 meta={step,outputs_so_far?,eta?,percent?}，不强制 schema 轻量；③ §6 事件路由表加 progress 行 + brief_echo 状态联动说明 + progress 用法；§5 event_list 类型数 8→11。 |
| 2026-07-24 | v2.7 | **P0-1 星形退化软约束**（macp 实战后改进）：新增 §4 Step2.1 层级委派协议（root→commander→worker 三分规则 + 越级反模式 + 单层树例外）；§11 加禁止行为 #14（root 越级 leaf_add worker）；tree-engine.cjs cmdLeafAdd 加 W_STAR_DEGRADATION 软约束（parent=root + role=worker + 已有 active commander 时返回 warning + leaf.delegation_hint 标记，不拦死）。解决 macp 实战中 3 commander 沦为孤儿、6 worker 越级直连 root 的星形退化。 |
| 2026-07-23 | v2.6 | **v0.20 补丁**（pi 运行时彻底兼容）：patches.cjs 抽象"工具数据表+双渲染器"（renderClaude/renderPi），新增 `__proma_getPiCustomTools__` 钩子 + main.cjs 补丁P 在 pi IIFE 注入 customTools。pi 运行时（deepseek 等）现在也能拿到 mcp__tree__/session__/remote-session__（dev 实证 deepseek-v4-pro 三组工具全有、tree_help 正常，claude 零回归）。§4 Step2 更新——v0.20+ 上 pi 模型也可做 tree 参与者。用 zod 原生 toJSONSchema（zod-to-json-schema 包与 zod v4 不兼容）。 |
| 2026-07-23 | v2.5 | **v0.18 补丁**（create_session 推断 agentRuntime）：remote_create_session 对 claude 兼容 provider 直接产出 claude 会话（dev 实证：ZLM/GLM-5.2 → 30 个 tree 工具）。§4 Step2 / §11 规则13 更新——v0.18+ 上 create_session 派生 tree 参与者也可行，fork_session 仍是跨版本安全默认。实例隔离 env 更正为 `PROMA_INSTANCE_ISOLATED=1`（非 PROMA_INDEPENDENT_PROFILE）。 |
| 2026-07-22 | v2.4 | **运行时约束**：tree/session/remote-session MCP 仅 claude 运行时会话可用（pi 运行时只有 automation/collaboration/proma_cloud）。§2 前置检查加 pi 诊断（"Tool not found" 非 bug）；§4 Step2 强制 fork_session 派生 tree 参与者（继承运行时）、禁 create_session（默认 pi）；§11 加规则 13。根因见 memory tree-mcp-pi-runtime-incompat。 |
| 2026-07-04 | v2.3 | ISS-003：§4 Step4 加 review_required=true 验收核查（核 review_round event + 抽查 findings 真实性，引擎只防格式，commander 抽查是内容真实性的真实防线） |
| 2026-06-19 | v2.2 | 审计驱动修订：requires 中 commander-methodology.md 版本引用从 v1.0 更新为 v1.2 |
| 2026-06-19 | v2.1 | 新增 §14 审计工作流（铁律 5、最小 7 leaf 结构、审计 5 件套模板、迭代收敛流程、完成检查表）；§0 引用 tree-audit-methodology.md；铁律从 4 条扩展到 5 条 |
| 2026-06-18 | v2.0 | 首次创建。合并 v0.1 契约/事件/剪枝 + v0.2 心跳/内审/三档纠偏/哨兵 Agent/验收 Agent。所有 tree-state.js 子命令引用来自附录 A 实现。 |
