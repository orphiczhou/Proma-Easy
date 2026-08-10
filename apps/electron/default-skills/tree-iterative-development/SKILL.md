---
description: |
  树形任务迭代开发流程 — 从实战（macp）到改进（PR）再到实战的闭环 SOP。
  触发场景：macp 类树形实战后改进 / 树形体系迭代 / 接力会话（新会话接手树形项目）/
  评估树形任务 + 制定改进方案 / 多轮 macp（macp→macp2→macp3...）推进 /
  任何"实战→评估→改进→再实战"的树形项目迭代。
  核心能力：迭代闭环 + 角色分工（指挥官/观察员/调研员/实施/审计）+ 多源模型审计 + PR 流程。
  基于本工作区 macp/macp2/macp3 三轮迭代（2026-07-24~25）沉淀。
  工具：mcp__tree__* / mcp__session__* / mcp__remote-session__* / mcp__automation__*。
---

# tree-iterative-development SKILL

树形任务迭代开发流程 — 从实战（macp）到改进（PR）再到实战的闭环 SOP。

---

## §0 元数据

```yaml
skill_name: tree-iterative-development
version: 1.4
target: 接力会话（新会话接手树形项目迭代）/ 协调多轮 macp 的父会话
based_on: macp/macp2/macp3/macp4/macp5/macp6 六轮迭代（2026-07-24~27，本工作区）
related:
  - tree-commander SKILL v2.9.2（指挥官手册，3 层树推进）
  - tree-worker SKILL v2.6（worker 手册）
  - tree-auditor SKILL v1.0（审计手册，位于 D:/Codes/tree-harness/skills/tree-auditor/ + pro 实例 skills，不在 release 工作区 skills）
workspace: C:/Users/sir_c/.proma/agent-workspaces/proma（Proma改造探索）
```

---

### §0.1 术语表

| 术语 | 含义 |
|------|------|
| **macp** | Multi-Agent Collaboration Platform 树形实战代号。每轮 macp-N（macp/macp2/macp3...）是一次端到端的「树形任务执行 + 多模型评估 + 改进落地」迭代 |
| **A/B/C 链** | macp3 的 3 层树结构：A 链 = coder（实现），B 链 = judge（评审），C 链 = 集成测试 |
| **星形退化 (star degradation)** | root 越过 commander 直接给 worker 发 leaf_add，破坏 3 层树层级（macp 核心教训） |
| **drift** | 可恢复错误的自动偏差记录（引擎 run() catch 内自动 append） |
| **PENDING_ROOT** | tree_init 后 root 节点未绑 session 的过渡标记，可能导致死锁 |
| **Gap B** | tree-commander SKILL 中 §Gap B 章节，含历史遗留的引擎行为描述 |
| **auditor leaf** | 独立审计节点，负责审查 commander 输出并给出 verdict |
| **audit_gate** | 树形系统中的审计门禁机制，审查通过后才能 done |
| **leaf** | 树形系统中的叶子 worker 节点 |
| **Sprint** | 项目迭代周期（multi-agent-collab-platform 的开发周期） |

---

### §0.2 工具速查表

本 SKILL 全文使用完整 MCP 工具名 `mcp__server__tool`。关键工具速查：

| 场景 | 完整工具名 + 关键参数 |
|------|---------------------|
| release 派子会话 | `mcp__session__create_session({channel_id, model_id, title})` |
| 派 dev/pro 会话 | `mcp__remote-session__remote_create_session({instance, channel_id, model_id, title})` |
| 发消息到远程会话 | `mcp__remote-session__remote_send_message({instance, session_id, message, wait})` |
| 看远程会话消息 | `mcp__remote-session__remote_list_messages({instance, session_id, limit})` |
| 发现实例 | `mcp__remote-session__remote_discover_instances({refresh})` |
| 创建定时回收 | `mcp__automation__create_automation({name, prompt, scheduleType, scheduledAt})` |
| tree 操作 | `mcp__tree__tree_init / tree_leaf_add / tree_log_communication / ...`（详见 tree-commander SKILL） |

---

### §0.3 前置依赖

- 本 skill 依赖 MCP 工具：`mcp__session__*` / `mcp__remote-session__*` / `mcp__tree__*` / `mcp__automation__*`
- 需要 **claude 渐变运行时**（pi 运行时无这些工具）
- **验证方法**：枚举你的 `mcp__*` 工具列表，若无 `mcp__session__` / `mcp__remote-session__` / `mcp__tree__` 开头者 → 当前为 pi 运行时 → 需从 claude 母会话 `fork_session` 派生新会话来执行本 SKILL

---

## §1 迭代开发闭环（核心）

> **macp** = Multi-Agent Collaboration Platform 树形实战代号。每轮 macp-N（macp/macp2/macp3...）是一次端到端的「树形任务执行 + 多模型评估 + 改进落地」迭代。

树形项目（如 multi-agent-collab-platform）通过多轮 macp 迭代推进，每轮闭环：

```text
实战（macp-N）
  → 观察员验收（2 层团队 + 多模型对抗）
  → 改进建议（落盘 06_TESTS/macpN-tree-evaluation）
  → 拉团队论证（2-3 子会话，引擎/SKILL/项目分层）
  → 方案选项 → AskUserQuestion 给用户选（A 全做 / B 只 P0 / C 分批）
  → 实施（引擎 + SKILL，派子会话或父会话）
  → 部署 dev/pro（cp + restart）
  → 审计（独立子会话，7 维度）
  → 归档（pr/<date>-<topic>/results.md）+ git push
  → 再实战（macp-N+1）验证改进
```

每轮解决上一轮暴露的问题，累积收敛。

### 1.1 六轮迭代实证（本工作区）

| 轮次 | 实战 | 暴露问题 | 改进（已落地）|
|------|------|---------|---------------|
| **macp**（tests/002）| 3 commander + 6 worker | 星形退化（root 越级 worker + 不发 brief）+ 24 次失败零 drift + 状态滞后 + send_message 不可见 | P0-1 W_STAR_DEGRADATION + P1-3 drift 自动 + P1-1 brief_echo 转 active + P1-2 communication_log |
| **macp2** | 3 层树（root→cmd→sub→worker）| audit 全回流 root + L3→L2 链路断裂 + commander 仅执行委派 + set-status worker 等 root + comm_log 10% 漏 + 全 GLM 同质化 | 方案 A：P0-B tree_init 绑 caller + P2-A tree_id 校验 + P1-C set-status 讲透 + P1-A comm_log 硬 checklist + P0-A 建 auditor 流程 |
| **macp3** | coder/judge 接 LLM（3 层树 A/B/C 链）| root done 门禁 + E_NO_OWNERSHIP 中转 + C2 遗漏异厂商审 + alignment 漏回填 | 复用 Proma LLM 模块 + B 链 DeepSeek/MiniMax 多源 + peer audit；**C1 68/100 MiniMax 独立签字**，整树闭环（10:05 root done 即时验证 P0-E）|
| **macp4**（harness 改进 + 实战验证）| 3 层树（root→cmd→worker+auditor）验证 harness 4 改进 | macp3 暴露的 root done 门禁 + E_NO_OWNERSHIP 中转；**新发现** root idle gap（平台 SDK 死锁）+ V10 多层级张力（L2 commander done 三路径撞墙）| P0-E root done 门禁 + P1-B R7-sibling-send + P1-G 待审清单 + P1-H alignment + SKILL v2.9.3；**实战 5/5 验证 PASS**；root idle gap + V10 张力记 memory，macp5 候选 |
| **macp5**（V10 张力纯 SKILL 解 + 实战验证）| 3 层树（root→cmd→worker+auditor）验证 §13.3b | macp4 V10 多层级张力（L2 commander done 三路径）+ root idle gap | §13.3b L2 commander 多层级 done 路径（正确树结构 auditor 挂 root 子节点 + root 代调协议 + 3 道防线）+ SKILL v2.9.4；**实战 5/5 验证 PASS 全树闭环**（观察员 MiniMax 异厂商核验认同）；2 重大发现（commander done 不需 audit_gate 初始 skip / L3061 优先 L3091）；macp6 候选删 commander audit_gate 步骤 |
| **macp6**（项目层推进 + §13.3b 实战检验）| 2 层 5 leaf（root→cmd×2+auditor，J2 接力 J）| macp5 §13.3b 落地后实战检验；**新发现** segment_add 接力不改 added_by + idle 探测"No usage"误判 + v2+旧 root emergent 协作 | 缺陷1 Judge LLM + 缺陷2 Coder CWE-22 真修根因（双绿 + 探针 + 异厂商双审 pass）+ §13.3b 双 commander done 零 V10 撞击；**C1 推断 80-83**（观察员异厂商，macp3 68→+12~15）；macp7 候选接力协议 + idle 多维核验 |
| **macp7-9**（SKILL v2.9.5→v2.9.7 + 引擎 v0.21）| 论证 + 改 SKILL（无实战树）| macp6 segment_add gap + audit_log schema + emergent 协作教化 | P0 接力协议补章 §13.3b + idle 多维核验 + audit_log severity（red\|yellow\|green v0.21）+ auditor ≥2 events + segment_add 评估（A3 SKILL 绕过 / A2 leaf_transfer_owner 留候选）；3 轮 collaboration 论证 + 审计 pass_with_minor |
| **macp10**（项目层缺陷3/4 + C1 权威复评）| 3 层 6 leaf（root→cmd×2→worker×2 + auditor 兄弟挂 root）| macp6 GLM 自评 76 乐观偏差待异厂商复核 + 项目层缺陷3 runGwt 假修复 + 缺陷4 evaluateCode 假通过 | 缺陷3 真修（applyGwtAutofixPatch 三道路径安全 + patchError break + 探针 2/2 pass）+ 缺陷4 真修（codeDir/classDiagramPath 拦截 + verdict=null + 探针 5/5 pass）；**§13.3b 多层级 done 零 V10 撞击实战验证**（root 代调 milestone + commander done 直接放行 + auditor 兄弟结构）；**C1=79/100 MiniMax-M3 异厂商独立签字**（未达 85+ 6 分，诚实标注拖分项 featuresMissingSteps + judge 占位 + 真系统 E2E）；macp7-9 改进全 PASS；3 yellow 待清 |
| **macp11**（综合实战 + C1→85+ 收口）| 3 层 6 leaf（root→cmd×2→worker×2 + auditor 兄弟挂 root）| macp10 C1=79 拖分项攻击 + §13.3b 在 root idle 复发下的鲁棒性 | G1 featuresMissingSteps 参与 verdict 阈值（>50% reject / 0-50% soft，探针 17/17）+ G2 跨层 E2E（IPC handler 注册表→main→factory→真引擎→mock LLM→envelope，3/3 vitest）+ G3 三 yellow 全清；**C1=86/100 MiniMax-M3 异厂商签字达 85+ 目标**（macp10 79→+7：Judge +2 / 自动化测试 +1 / 端到端 +4 保守）；**root idle 复发 + CLI 兼容通道兜底**（tree-engine.cjs 省略 callerSessionId 代调 milestones）+ 父会话补发 auditor brief；harness 完成标准 7/7 全达成 → `pr/20260728-harness-final/FINAL-REPORT.md` |

---

## §2 角色与子会话（拉团队）

每轮迭代涉及多角色（子会话），父会话（你）协调：

| 角色 | 结构 | 职责 | 派法 |
|------|------|------|------|
| **调研员** | 1 层（独立）| 摸项目/部署状态，为规划做准备 | `mcp__session__create_session` 或 `remote_create_session`（目标实例）|
| **根指挥官** | 3 层树（root→cmd→sub→worker）| 推进项目实现，多层指挥官主动性 | `remote_create_session(pro)` + 派遣（wait=false）|
| **观察员** | 2 层树（root→评估 worker）| 独立验收指挥官过程 + 改进建议落盘 | `remote_create_session(pro)` + 派遣 |
| **论证子会话** | 1 层（2-3 个并行）| 评估改进建议可行性/风险/工作量 | `mcp__session__create_session`（DeepSeek 渠道）|
| **实施子会话** | 1 层 | 改 source（引擎/SKILL）| `mcp__session__create_session` |
| **审计子会话** | 1 层（独立）| 审查改动 + verdict | `mcp__session__create_session` |

### §2.1 渠道选择（避坑，实测）

| 渠道 | id | 模型 | release `create_session` | pro/dev `remote_create_session` |
|------|----|------|:-:|:-:|
| **DeepSeek 官方** | `56ecefd2-8e22-4c62-add5-16e8992c987d` | deepseek-v4-pro | ✅ | ✅ |
| **MiniMax-CodingPlan** | `b7e25505-c972-49e7-9173-ef14df3eaa3f` | MiniMax-M3 | ✅ | ✅ |
| ZLM-CodingPlan | `cbb12a0b-3d21-476d-9812-d37bb5642cda` | GLM-5.2 | ❌ Channel not found | ✅（pro/dev 实例）|

> release 派子会话用 DeepSeek/MiniMax；pro/dev 实战指挥官用 ZLM/GLM-5.2（claude 渐变，有 mcp__tree__*）。
> 多源审计刻意混用厂商（DeepSeek + MiniMax + GLM），避免单模型同质化（macp2 全 GLM 被对抗审查批评）。

### §2.2 send_message busy 处理
指挥官/观察员在 pro 跑（wait=false 派遣）。`remote_send_message` 可能报"上一条消息仍在处理中"——消息**已入队**（`remote_list_messages` 能看到），等当前 turn 结束后处理。补充指令直接 send（入队即可），不用重试。

---

## §3 实例管理

| 实例 | 颜色 | 用途 | 数据目录 |
|------|------|------|---------|
| **release** | Proma-blue | 宿主（你 + 调研/论证/实施/审计子会话）| ~/.proma |
| **dev** | Proma-white | 测试（小改动先 dev 验证）| ~/.proma-dev |
| **pro** | Proma-green | macp 实战（指挥官 + 观察员）| ~/.proma-pro |

- dev/pro 共享 `D:/Proma-dev/resources/app/dist/`
- 启动：`tree-harness/restart-{dev,pro}.ps1`（已固化 `PROMA_INSTANCE_ISOLATED=1`）
- **绝不 kill release**（杀当前会话）；release 部署需用户手动重启
- discover：`mcp__remote-session__remote_discover_instances`（release:19876 / dev:19877 / pro:19878）

---

## §4 PR 流程（每轮改进，7 步）

每项改进（引擎/SKILL）按：

1. **design** → `D:/Codes/tree-harness/pr/<date>-<topic>/design.md`（根因 + 改动点 + 测试计划）
2. **implement** → 派实施子会话改 source（tree-harness/）；确定性小改动可父会话直接改
3. **deploy** → cp source → `D:/Proma-dev/resources/app/dist/` + `node --check` + restart dev/pro
4. **audit** → 派独立审计子会话（代码 + 功能 + 回归，给 verdict）
5. **归档** → `pr/<date>-<topic>/results.md`
6. **git push** → `cd /d/Codes/tree-harness && git add + commit + push origin release-0.13.16-hardening`
7. **测试记录** → 跨实例测试进 `D:/Codes/tree-harness/tests/<NNN>-<topic>/`

### §4.1 部署细节
- **main.cjs**：sed 补丁（apply-patches.sh 编排）或直接 Edit 部署版（Proma 工作区 CLAUDE.md `C:/Users/sir_c/.proma/agent-workspaces/proma/CLAUDE.md` 允许两种方式；tree-harness CLAUDE.md 侧重 apply-patches.sh 编排）
- **tree-engine.cjs / proma-dev-patches.cjs**：cp 整文件
- **SKILL**：cp 到 `~/.proma-pro/agent-workspaces/default/skills/`（pro）；release 是 source
- **proma-tree-view.js**：部署到 `dist/renderer/assets/`（不是 dist 根）
- `.ps1` 必须 ASCII；Bash 新 shell 需 `export PATH="/c/Program Files/nodejs:$PATH"`

### §4.2 PR 档案位置（不放工作区 .context）
- `D:/Codes/tree-harness/pr/<date>-<topic>/`（跟代码同 git 仓）
- `D:/Codes/tree-harness/tests/<NNN>-<topic>/`

---

## §5 改进方案制定（拉团队论证 → 用户选）

基于观察员改进建议（`06_TESTS/macpN-tree-evaluation` §改进建议）：

1. **派 2-3 论证子会话**（并行，按层）：
   - 引擎层（tree-engine.cjs / patches.cjs）
   - SKILL 层（tree-commander/worker）
   - 项目层（multi-agent-collab-platform src/）
2. **每个评估**：可行性 + 风险 + 工作量（行数/小时）+ 优先级 + 实施大纲（改哪 + 怎么改）
3. **汇总 + 分优先级**：P0（必做）/ P1（应做）/ P2（可做）；区分 proma 改造 vs 项目改进
4. **AskUserQuestion 给用户选**：方案 A/B/C（如全做 / 只 P0 / 分批），推荐项放第一

### §5.1 改进 vs 项目边界
- **proma 改造**（`D:/Codes/tree-harness/`）：引擎 + SKILL + 补丁（影响所有树形项目）
- **项目改进**（`D:/Codes/multi-agent-collab-platform/`）：src/ 实现（只影响该项目，下个 Sprint）

---

## §6 关键约束（引擎 + SKILL 协议，实战必须遵循）

> 本 §6 的约束编号（P0-1 等）对应本 skill 自洽描述；详细协议在 tree-commander/worker SKILL，若未加载，本 §6 摘要足够执行。约束矩阵中「层」列同时给出本 skill 内解释和原 SKILL 章节引用。

tree-commander v2.9.2 + tree-worker v2.6 已教，引擎硬/软约束支持：

| 约束 | 层（本 skill 解释 + 原 SKILL 引用）| 作用 |
|------|----|------|
| **P0-1 W_STAR_DEGRADATION** | 引擎软约束（禁止 root 越级 leaf_add worker）+ SKILL §4 Step2.1（层级委派协议）| root 不越级 leaf_add worker（消星形退化，macp 教训）|
| **P0-A 建 auditor leaf** | SKILL §13.4.0（四步建审计节点协议，引擎零改动）| audit 不全回流 root，commander 真自主 done（macp2 教训）|
| **P0-B tree_init 绑 caller** | 引擎 cmdInit（创建树时自动绑定发起 session，消 PENDING_ROOT 过渡标记）| 消 PENDING_ROOT 死锁 |
| **P2-A tree_id prefix 校验** | 引擎 cmdInit（前置拦截：拒绝含连字符 / 超长 tree_id）| 前置拦截连字符/超长 tree_id |
| **P1-C set-status caller=owner** | SKILL §3.4 final_step（worker 自己调 set-status 报告状态）+ worker §1 #10（不等 root 代调）| worker 自己调，不等 root（macp2 4/5 worker 卡这）|
| **P1-A comm_log 硬 checklist** | SKILL §4 Step3（每次 send_message 后必须立即 tree_log_communication）+ §11 #15（禁止漏记）| send_message 后必须 tree_log_communication |
| **P1-1 brief_echo 转 active** | 引擎 cmdEventAppend（worker 收到 brief 后自动更新状态为 active）| worker 状态实时反映 |
| **P1-2 communication_log** | 引擎 cmdCommunicationLog（send_message 调用自动记录到树日志）| send_message 可观测 |
| **P1-3 drift 自动记录** | 引擎 run() catch（可恢复错误自动 append drift 到事件流）| 可恢复错误自动 append drift |
| **§13.4.6 fix leaf 闭环** | SKILL（auditor 发现 non-green → 创建 fix leaf 修复 → 复审，完整闭环）| auditor 发现 non-green → fix leaf 修复 → 复审 |

---

## §7 多源模型审计（核心，避免同质化）

macp2 全 GLM 被对抗审查批评"认知同质化 + 递归同质化（GLM 评 GLM）"。每轮 macp 必须：

1. **B 链（judge）指定 DeepSeek/MiniMax 渠道**（与 A/C 链 GLM 交叉）
2. **观察员评估 worker 多模型**（W1 GLM / W2 DeepSeek / W3 MiniMax / W4 GLM）
3. **跨模型 peer audit**（A↔B↔C 互审，补 audit_gate 全 skip 漏洞）
4. **final done 前异模型签字**
5. **C1 量化用异厂商独立打分**（避免自评美化：macp2 GLM 58-65 → MiniMax 独立 47）

> 方法论启示：树形任务评估本身亦需多模型交叉，单模型评估单模型产出 = 递归同质化。

---

## §8 复用优先（项目基于 Proma 升级）

multi-agent-collab-platform 基于 Proma 开源升级。LLM 基础层等模块**优先复用 Proma 已有实现**：

- `mcp__proma_cloud__get_credentials`（LLM 凭据网关）
- Proma 的 `runAgentHeadless` / `createSession`（完整 LLM 调用路径：渠道 + 鉴权 + 重试 + 流式）
- `D:/Proma-dev/resources/app/dist/main.cjs`（minified 但可 grep LLM 逻辑）
- sandbox/snapshot/router 已真实成熟（macp2 确认），可直接复用

**策略**：先派调研 worker 摸"Proma 可复用模块清单" → 再实现（不从零写已有模块）。

---

## §9 文件索引

### 改造工程（`D:/Codes/tree-harness/`，git: orphiczhou/proma-patches, branch release-0.13.16-hardening）
- `tree-engine.cjs`（引擎 source）
- `proma-dev-patches.cjs`（补丁 source：MCP 工具 + IPC + pi customTools）
- `apply-patches.sh`（补丁编排 A-Q + 3 + L）
- `pr/<date>-<topic>/`（PR 档案：design + results + 单测）
- `tests/<NNN>-<topic>/`（跨实例测试记录）
- `restart-{dev,pro}.ps1`（实例重启，ISOLATED=1）
- `skills/`（引擎 SKILL 的 git-tracked 副本：tree-commander / tree-worker / tree-auditor / session-management）

### 部署（`D:/Proma-dev/resources/app/dist/`，dev/pro 共享）
- `main.cjs`（补丁 Q 等 sed）
- `tree-engine.cjs` / `proma-dev-patches.cjs`
- `renderer/assets/proma-tree-view.js`

### SKILL（工作区）
- release（source）：`C:/Users/sir_c/.proma/agent-workspaces/proma/skills/{tree-commander,tree-worker,tree-iterative-development}/`
- tree-auditor：`D:/Codes/tree-harness/skills/tree-auditor/`（git-tracked source）+ `C:/Users/sir_c/.proma-pro/agent-workspaces/default/skills/tree-auditor/`（pro 实例同步）
- pro：`C:/Users/sir_c/.proma-pro/agent-workspaces/default/skills/`（cp 同步）

### 项目（`D:/Codes/multi-agent-collab-platform/`）
- `src/`（coder/judge/sandbox/electron）
- `.context/`（设计 + 审计 + macp3-survey 调研）
- `06_TESTS/`（macp2/macp3 树形评估报告）

### 指令 + 记忆
- `C:/Users/sir_c/.proma/agent-workspaces/proma/CLAUDE.md`（项目指令：PR 流程 + 实例管理 + 约束）
- `.claude/memory/MEMORY.md`（长期记忆索引：渠道/陷阱/经验）
- `workspace-files/.context/handoff-*.md`（接力交接文档）

---

## §10 接力会话第一步（新会话必读）

> **路径前缀**：本 SKILL 中所有相对路径（如 `workspace-files/`）均相对于工作区根 `C:/Users/sir_c/.proma/agent-workspaces/proma/` 解析。

1. **读核心文件**：
   - 本 skill（当前文件）
   - CLAUDE.md：`C:/Users/sir_c/.proma/agent-workspaces/proma/CLAUDE.md`
   - 长期记忆：`C:/Users/sir_c/.proma/agent-workspaces/proma/.claude/memory/MEMORY.md`
2. **读交接 + PR + 测试**：
   - 最近交接：`ls C:/Users/sir_c/.proma/agent-workspaces/proma/workspace-files/.context/handoff-*.md` 找最新
   - 最近 PR：`ls -t D:/Codes/tree-harness/pr/` 找最新日期目录
   - 测试：读 `D:/Codes/tree-harness/tests/` 下最新编号目录
3. **检查实例 + 部署**：
   - 发现实例：`mcp__remote-session__remote_discover_instances({refresh: true})` — 确认 release(19876) / dev(19877) / pro(19878) 在线
   - 引擎同步：`diff D:/Codes/tree-harness/tree-engine.cjs D:/Proma-dev/resources/app/dist/tree-engine.cjs`
   - SKILL 版本：`grep '^version:' C:/Users/sir_c/.proma/agent-workspaces/proma/skills/tree-commander/SKILL.md`
   - pro SKILL 同步：`diff C:/Users/sir_c/.proma/agent-workspaces/proma/skills/tree-commander/SKILL.md C:/Users/sir_c/.proma-pro/agent-workspaces/default/skills/tree-commander/SKILL.md`
4. **看进行中的 macp**：
   - 查 §10.1 拿指挥官/观察员 session_id（如 macp3：指挥官 `c7494c62` + 观察员 `27f6346f`）
   - 拉最近消息：`mcp__remote-session__remote_list_messages({instance: "pro", session_id, limit: 10})`
   - 在返回消息中找关键字：`done` / `blocked` / `error` / `milestone` / `evaluation` — 判断是否卡住
5. **基于现状定下一步（四选一）**：
   - **继续观察**：给观察员发消息 → `mcp__remote-session__remote_send_message({instance: "pro", session_id: "<观察员>", message: "当前评估进度如何？有哪些初步发现？"})`
   - **回收评估**：拉观察员完整报告 → `mcp__remote-session__remote_list_messages({instance: "pro", session_id: "<观察员>", limit: 30})`，提取改进建议
   - **拉团队改进**：跳到 §5 执行（派论证子会话 → AskUserQuestion 给用户选 → 实施 → 审计）
   - **新一轮 macp**：跳到 §1 闭环，从「再实战（macp-N+1）」开始

### §10.1 当前进度快照（2026-07-28 00:30 — 🎉 harness 完成）
- **C1 演进**：macp3 68 → macp6 推断 76 → macp10 79 → **macp11 86（MiniMax-M3 异厂商独立签字，达 85+ 目标）**
- **macp7-9 ✅** SKILL v2.9.5→v2.9.7 + 引擎 v0.21（接力协议 §13.3b + idle 多维 + audit_log severity + segment_add 评估 A3）；3 轮 collaboration 论证
- **macp10 ✅** 缺陷3 runGwt + 缺陷4 evaluateCode 真修 + C1=79（MiniMax 签字）+ §13.3b 多层级 done 零 V10 撞击验证
- **macp11 ✅** G1 featuresMissingSteps verdict（Judge +2，探针 17/17）+ G2 跨层 E2E（端到端 +4 保守）+ G3 三 yellow 清 + 自动化测试 +1 → **C1=86 收口**；root idle 复发 + CLI 兼容通道兜底 + 父会话补发 auditor brief。详见 `D:/Codes/tree-harness/pr/20260727-macp11/results.md`
- **🎯 harness 完成标准 7/7 全达成** → `D:/Codes/tree-harness/pr/20260728-harness-final/FINAL-REPORT.md`
- **后续 roadmap**（超出本轮 scope）：A2 leaf_transfer_owner 引擎轻改 / Sandbox OS 级 / Electron IPC stub 实装 / judge 占位减 5 / 真实 Electron 进程级 E2E / SKILL §13 补 root idle 标准流程
- **GLM-5.2 context 计算不准**（用户纠正）：usage_pct 虚高，判 session 卡死必须 ping 核实，记 `.claude/memory/glm-context-calc-inaccurate.md`

---

## §11 常见陷阱

1. **release 派子会话**：ZLM 渠道报 Channel not found → 用 DeepSeek（`56ecefd2`）
2. **Bash 新 shell**：PATH 不持久，需 `export PATH="/c/Program Files/nodejs:$PATH"`
3. **push 报 lock 错**（"cannot lock ref: is at X but expected Y"）：实际成功，`git fetch + git rev-parse` 验证 local=remote 即可
4. **SKILL 部署**：release 是 source；pro 要 cp（`~/.proma-pro/.../skills/`）；dev 用 release 同步
5. **send_message busy**：消息已入队（list_messages 可见），不用重试
6. **tree_id 含连字符**：P2-A 拦截（`oeval-macp2` 被拒，用 `oeval3` 不含 `-`）
7. **Gap B 等历史内容**：cp release→pro 前先 backup pro 独有段（如 §13.4.6 fix leaf 闭环）

---

## §12 修订历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-07-25 | v1.1 | 洁净室改进：P0 致命修正（macp 定义 §1 / 绝对路径 §10 / 工具名统一 §0.2 速查表 / 前置依赖 §0.3）+ P1 重要改进（术语表 §0.1 / 可执行命令 §10 / §6 约束矩阵自包含）+ 工程 FAIL 修正（tree-auditor 路径纠错 §0/§9 / tree-harness skills/ 补录 §9 / CLAUDE.md 绝对路径指明 §4.1）。基于洁净室测试 P0-1~4 + P1-1~7 + 工程审计 E1~E4。 |
| 2026-07-27 | v1.4 | macp6 闭环：§0 版本/based_on → 1.4 + §1.1 加 macp6 行（项目层推进 + §13.3b 实战检验 + C1 80-83 + 3 新发现）+ §10.1 进度快照更新（macp6 完成 + macp7 候选 + GLM-5.2 context 纠正）。基于 macp6 实战（双目标达成：缺陷1+2 真修 + §13.3b 零 V10 撞击）+ 观察员 MiniMax 异厂商完整评价（7 新发现）+ `pr/20260727-macp6/results.md`。 |
| 2026-07-26 | v1.3 | macp5 闭环：§0 版本/based_on → 1.3 + §1.1 加 macp5 行（V10 张力纯 SKILL 解 §13.3b + 实战 5/5 全树闭环 + 2 重大发现）+ §10.1 进度快照更新（macp5 完成 + macp6 候选删 audit_gate 步骤）。基于 macp5 实战验证（5 验收点 PASS 全树闭环）+ 观察员 MiniMax-M3 异厂商独立核验（认同主体 + 修正发现 1 机制：commander 初始 skip 非 auto_upgrade）+ `pr/20260726-macp5-v10-multi-layer/results.md`。 |
| 2026-07-26 | v1.2 | macp4 闭环：§0 版本/based_on → 1.2 + §1.1 加 macp4 行（harness 5/5 验证 + 2 新工程问题）+ §10.1 进度快照更新（macp3 完成 + macp4 完成 + macp5 待开 + 项目层 4 缺陷边界）。基于 macp4 实战验证（5 验收点 4 PASS + 1 BLOCKED）+ memory `macp4-root-idle-v10-tension.md`。 |
| 2026-07-25 | v1.0 | 首次创建。基于 macp/macp2/macp3 三轮迭代沉淀（P0-1/P1-1/P1-2/P1-3 + 方案 A P0-B/P2-A/P1-C/P1-A/P0-A + 子会话机制 + list_messages full_text）。|
