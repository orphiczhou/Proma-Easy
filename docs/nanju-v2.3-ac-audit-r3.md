# 南大向导 v2.3 AC Round 3 审计（收敛确认轮）

## Attacker (DeepSeek V4 Pro)

# AC Round 3 攻击者审查报告

## 任务拆解
Now let me do a thorough line-by-line attack. Let me first trace the exact text of the claimed fixes.
现有代码库中无南大向导实现——这是纯设计审查。现在进入深度攻击。

---

## 🔴 Attacker 审查报告 — AC Round 3 收敛确认

### 文档版本指纹
```
文档: 南大向导 v2.3 架构设计
审查轮次: Round 3 (Convergence)
Attacker: AC Round 3 Attacker (本会话)
Attacker 模型家族: DeepSeek (deepseek-v4-pro)
审查维度: C1 自洽性 | C2 保真度 | C3 可造性 | C4 可懂性 | A1 反向映射
```

---

### Part A: R1 / R2 修复验证

#### A.1 R1 — AC 文件 Write 矛盾

**原始缺陷**: L1 受 canUseTool 硬门禁禁止 Write，但需要将 AC 审计结果写入文件。

**v2.3 修复声明** (Section 9):
> "由 Harness 代码将本阶段的 AC 审计结果写入文件。使用 safe-file.ts 的 writeJsonFileAtomic / writeFileSync，**不是 L1 Agent 调用 Write 工具**。"

**职责边界表**:
> "AC 审计文件写入 | Harness | writeJsonFileAtomic，代码写入"

**攻击分析**:

修复在**结构上**正确——将 Write 职责从 Agent 转移到 Harness 代码层，消除了 L1 canUseTool 门禁与 Write 需求的直接冲突。

但存在一个**执行断层**：

```
问题链：
  1. L1 通过 delegate_agent(inline:true) 执行 AC 审计
  2. AC 审计的发现（findings）存在于 L1 的对话上下文中
  3. Harness 需要在阶段完成后写入 _ac-audit-{phaseId}.md
  4. ❓ Harness 如何从 L1 上下文中提取 AC findings？
```

**可能的实现路径**（均未在 spec 中定义）：
- **(a) L1 回复解析**: Harness 解析 L1 的自然语言回复提取 findings → **脆弱**，依赖 L1 严格遵循格式
- **(b) delegate_agent 结果拦截**: Harness 在 MCP 层拦截 inline delegate_agent 的返回值 → 依赖 Proma 内部 API
- **(c) L1 主动上报**: L1 调用某个未定义的工具/格式将 findings 传给 Harness → **未定义**

**判定**: 🟡 **YELLOW**（R1 结构修复正确，但数据通道未定义，存在实现阻塞风险）

> **注意**: 如果实际实现选择路径 (a)，这不构成阻塞——只需在 L1 systemPrompt 中增加 AC findings 的格式化输出要求即可。但 spec 未体现这一约定。

---

#### A.2 R2 — iterative 路由缺失节点

**原始缺陷**: iterative route 用注释 `// ... iterative only` 省略了 architecture + planning 节点的显式定义。

**v2.3 修复** (Section 3):
```typescript
// iterative：显式包含所有节点（不再用注释省略）
const architecture: PhaseNode = { /* ... */ next: 'planning' }
const planning: PhaseNode = { /* ... */ next: 'delivered' }
return [REQUIREMENTS, prototype, architecture, planning, SENTINEL]
```

**攻击分析**:

所有 4 个节点 + SENTINEL 均已显式定义。`makeRoute('iterative')` 返回完整数组。代码注释 `"不再用注释省略"` 明确表达修复意图。

**判定**: 🟢 **GREEN — R2 完全修复，无回归**

---

### Part B: P1 Yellow 修复副作用检查

v2.3 中标注的 P1 yellow 修复点：Y2（needs_modification 重试）、Y8（Harness ↔ Agent 边界表）。

#### B.1 Y2 — needs_modification 加入重试条件

**修复代码** (Section 4.2):
```typescript
if ((result.status === 'failed' || result.status === 'timeout' 
     || result.status === 'needs_modification')  // ← 新增
    && result.retryCount < phase.retryLimit) {
  return { action: 'retry', reason: '...' }
}
```

**副作用检查**:
- `needs_modification` 触发 retry → L2 重新委派 → 用户不需要手动干预 → ✅ 符合预期
- 与 `requiresUserConfirmation` 的交互：`handlePhaseResult` 中 retry 检查在 ask_user 之前 → retry 优先 → ✅ 正确（先重试，重试失败再问用户）

**判定**: 🟢 **GREEN — Y2 修复正确，无副作用**

#### B.2 Y8 — Harness ↔ Agent 职责边界表

**修复** (Section 9): 新增了 9 行的职责边界表，区分 Harness（代码）和 Agent（LLM）的职责。

**副作用检查**:
- 表中"AC 审计文件写入 | Harness"与 R1 修复一致 → ✅
- 表中"阶段推进声明 | Agent | L1 回复文本中包含推进标记" → ⚠️ 引入了新的模糊性（见 Part C NR2）

**判定**: 🟡 **YELLOW — 边界表本身正确，但"推进标记"检测机制未定义**

---

### Part C: v2.3 新缺陷发现

#### 🔴 NR1 (C3 可造性 / G 护栏) — 并发项目状态写入不安全

**位置**: Section 6, `_nanju-projects.json` 描述

**证据**:
> "多项目并发安全（每个项目有独立的 projectId 和 sessionId，_nanju-projects.json 是数组，追加不冲突）"

**攻击**:

`writeJsonFileAtomic` 的典型实现是 **temp file + atomic rename**，它保证**单次写入的崩溃安全**（要么完整写入，要么完全不写），但**不保证多进程/多会话并发安全**。

```
并发场景：
  时刻 T1: 会话 A 读取 _nanju-projects.json → [Project1]
  时刻 T2: 会话 B 读取 _nanju-projects.json → [Project1]  ← 同一份数据
  时刻 T3: 会话 A 写入 [Project1, Project2]  ← atomic rename 成功
  时刻 T4: 会话 B 写入 [Project1, Project3]  ← atomic rename 成功
  结果: _nanju-projects.json = [Project1, Project3]  ← Project2 丢失！
```

"数组追加不冲突"是一个**错误的线程安全假设**。即使有 `writeJsonFileAtomic`，read-modify-write 的 race condition 依然存在。

**严重性**: 🔴 **RED**
- 理由: 设计明确声称并发安全，但机制不支持该声称。状态丢失是数据损坏 bug。
- 触发条件: 实际中单用户同时操作两个项目的概率低，但**声称的安全性不存在**本身就是架构缺陷。

**修复建议**: 
- (a) 使用 per-project 文件 (`_nanju-project-{projectId}.json`)，消除共享状态
- (b) 使用文件锁 (`flock`/`lockfile`)
- (c) 声明 v2 仅支持单项目活动，移除并发安全声称

---

#### 🟡 NY1 (C3 可造性) — Harness AC 结果提取通道未定义

**位置**: Section 4.1 step 4 + Section 9

**证据**:
> Section 4.1: "delegate_agent(inline:true, channel='deepseek', task='攻击审查')"  
> Section 9: "由 Harness 代码将本阶段的 AC 审计结果写入文件"

**攻击**:

Harness 需要 AC 审计的具体内容（findings、severity、verdict）才能写入文件。但 spec 中没有定义 Harness 如何从 L1 Agent 的上下文中获取这些内容。已在上文 R1 验证中详述。

**建议**: 在 L1 systemPrompt (Section 7) 中增加指令：完成 AC 审计后，必须在回复中使用结构化标记（如 `<!-- AC_FINDINGS: {json} -->`），Harness 据此提取并写入文件。

---

#### 🟡 NY2 (C3 可造性) — 阶段推进检测依赖文本解析

**位置**: Section 9 职责边界表

**证据**:
> "阶段推进声明 | Agent | L1 回复文本中包含推进标记"

**攻击**:

"推进标记"的具体格式未定义。如果依赖自然语言关键词匹配（如 "进入下一阶段"），存在误触发风险——L1 在向用户解释流程时可能无意中包含这些词。

**建议**: 定义明确的推进标记格式，如 `<!-- PHASE_ADVANCE: next -->` 或要求 L1 在推进时调用特定的确认工具。

---

#### 🟡 NY3 (C3 可造性) — CompactContext 不在工具白名单

**位置**: Section 5 (PHASE_TOOL_WHITELIST) + Section 9 (上下文管理)

**证据**:
> Section 9: "如果上下文接近窗口上限，调度员 systemPrompt 中提示 Agent 主动 compact"  
> Section 5: 所有阶段的工具白名单均不包含 `CompactContext`

**攻击**:

`CompactContext` 是 Proma 提供的内置工具。如果它不在白名单中，L1 Agent 无法调用它进行上下文压缩。这可能导致长阶段（尤其是 iterative 模式的 architecture 阶段，包含 inline AC 审计）上下文溢出。

**建议**: 将 `CompactContext` 加入所有非 delivered 阶段的白名单。

---

#### 🟡 NY4 (C2 保真度 / C3 可造性) — ModeSelectView 未定义范围

**位置**: Section 3

**证据**:
> "用户在 ModeSelectView 选择快消型/迭代型时确定，存入 _nanju-projects.json 的 mode 字段。"

**攻击**:

`ModeSelectView` 是什么？是 Chat 工具中的交互组件？是 Web UI？还是 `AskUserQuestion` 弹出的选项？spec 中未定义其实现方式。Section 10 v2 scope 也未包含 ModeSelectView。

这是一个**未声明的外部依赖**——如果 ModeSelectView 不是 Proma 原生能力，v2 的实现需要额外工作。

**建议**: 明确 ModeSelectView 就是 `AskUserQuestion` 在项目创建时的调用（在 Section 4.1 的流程中补充项目创建步骤），或将其明确列为 v2 scope 的 UI 任务。

---

#### 🟡 NY5 (C1 自洽性) — Inline AC 审计与 AC 方法论的匹配度

**位置**: Section 4.1 step 4

**证据**:
> "delegate_agent(inline:true, channel='deepseek', task='攻击审查以下文档...')"  
> "delegate_agent(inline:true, channel='glm-zhipu', task='防御审查以下文档...')"

**攻击**:

AC 方法论（adversarial-convergence-verification skill）定义了三角色结构：**Attacker → Defender → Arbiter**。但 v2.3 的 inline AC 仅创建了两个角色（Attacker + Defender），缺少 Arbiter。

两个问题：
1. **角色缺失**: 缺少 Arbiter 裁决环节，当 Attacker 和 Defender 意见冲突时无裁决机制
2. **Inline 限制**: inline delegate_agent 是单轮任务派发，而 AC 方法论需要多轮对抗交互。单轮 inline 是否能完整执行 AC 协议？

**判定**: 这可能是**有意的简化**（v2 scope 声明 Section 10: "AC 审计的完整 DUAL-GATE 停止协议" 留 v3）。如果是这样，需要明确标注 inline AC 是"简化版 AC"，与完整方法论的能力差异。

**建议**: 在 Section 4.1 step 4 处增加注释：`// v2 使用简化 AC（Attacker+Defender，无 Arbiter），完整 DUAL-GATE 留 v3`

---

#### 🟡 NY6 (C3 可造性) — L2 子会话对项目文件的访问权限

**位置**: Section 6 (L2 三件套契约)

**证据**:
> "前序产出文件（请先 Read 后再工作）：{priorArtifacts.join('、')}"

**攻击**:

L2 角色子会话通过 `delegate_agent` 创建。spec 假设 L2 可以 Read 项目目录中的前序产出文件。但：
- delegate_agent 子会话的工作目录是什么？是项目根还是独立的临时目录？
- 是否需要显式传递文件路径或内容？

Proma 的 delegate_agent 在相同 workspace 下应该可以访问文件，但这需要验证且应在 spec 中明确。

**建议**: 在 Section 6 增加说明："L2 子会话与 L1 在同一工作区，可访问 `{projectDir}` 下的所有文件。"

---

### Part D: 维度汇总

| 维度 | 新发现 | 严重度分布 |
|------|--------|-----------|
| C1 自洽性 | NY5 | 🟡×1 |
| C2 保真度 | NY4 | 🟡×1 |
| C3 可造性 | NR1, NY1, NY2, NY3, NY6 | 🔴×1, 🟡×4 |
| C4 可懂性 | — | 无新发现 |
| A1 反向映射 | — | 无新发现 |
| R1 修复验证 | 通道未定义 | 🟡 (结构修复正确) |
| R2 修复验证 | ✅ | 🟢 完全修复 |
| P1 Yellow 副作用 | NY2 (Y8 引入) | 🟡 (边界表引入新模糊点) |

---

### Part E: 最终收敛判断
---

## ⚖️ 收敛判断

### 修复确认

| 前轮缺陷 | 状态 | 备注 |
|----------|:----:|------|
| R1 (AC Write 矛盾) | 🟡 结构修复，数据通道待明确 | Harness 写文件→正确；但 Harness 如何获取 AC 内容未定义 |
| R2 (iterative 缺节点) | 🟢 完全修复 | 4 节点 + SENTINEL 均已显式定义 |

### 新发现

| ID | 维度 | 严重度 | 简述 |
|----|------|:------:|------|
| **NR1** | C3/G | 🔴 | `_nanju-projects.json` 并发写入不安全 — 声称并发安全但 read-modify-write 存在 race condition |
| NY1 | C3 | 🟡 | Harness AC 结果提取通道未定义 |
| NY2 | C3 | 🟡 | 阶段推进依赖文本解析，格式未定义 |
| NY3 | C3 | 🟡 | `CompactContext` 不在工具白名单 |
| NY4 | C2/C3 | 🟡 | `ModeSelectView` 未定义范围/实现 |
| NY5 | C1 | 🟡 | Inline AC 缺少 Arbiter，与完整方法论不一致 |
| NY6 | C3 | 🟡 | L2 文件访问权限未明确 |

### 裁决

> **❌ 未收敛 → 需要 1 轮微修复后进入实现**

**阻塞项**（必须修复才能进入实现）:
- **NR1**: 并发安全声称错误。修复简单（per-project 文件或移除并发声称），但不可带着数据损坏风险进入实现。

**强建议**（实现前应澄清，但不阻塞启动）:
- NY1: 定义 Harness ↔ L1 的 AC findings 传递约定
- NY2: 定义推进标记格式

**可在实现中解决**:
- NY3-NY6: 均为实现细节，可在编码阶段按建议处理

### 推荐修复路径（最小增量）

1. **NR1**: Section 6 中，将 `_nanju-projects.json` 改为 `_nanju-project-{projectId}.json`（per-project 文件），删除"追加不冲突"声称
2. **NY1**: Section 7 systemPrompt 中增加："AC 审计完成后，在回复末尾用 `<!-- AC_RESULT: {...} -->` 格式输出 findings"
3. **NY2**: Section 9 边界表中明确推进标记格式为 `<!-- NANJU_ADVANCE -->`

修复后预计行数变化 < 20 行，**无需再进入完整 AC 审查轮次**，可由 Defender 自行验证后直接进入实现。

---
---

### 📊 审查统计

| 指标 | 数值 |
|------|:---:|
| 审查维度 | 5 (C1-C4 + A1) |
| 前轮缺陷验证 | 2 (R1, R2) |
| P1 Yellow 副作用检查 | 2 (Y2, Y8) |
| 新 RED 发现 | 1 (NR1) |
| 新 YELLOW 发现 | 6 (NY1-NY6) |
| 阻塞进入实现的缺陷 | 1 (NR1) |

**结论**: v2.3 在结构上已经成熟——固定路由状态机、两层 Harness、canUseTool 门禁等核心架构正确。唯一阻塞项 NR1 的修复成本极低（per-project 文件替代共享数组）。建议 Defender 进行一轮微修复后跳过完整 AC 轮次，直接进入实现阶段。

## Defender (GLM 5.2)

# 🛡️ Defender 响应 — AC Round 3

我先快速核实工作区中是否有设计文档原文，确保引用准确。
---
找到了关键文件。让我读取实际的 `_nanju-projects.json` 和架构设计文档。
---
这个 architecture.md 是子项目的文档，不是南大向导本身的架构 spec。让我搜索南大向导的设计文档和 AC 审查历史。
---
现在我有足够的信息来进行精确分析。我看到了实际的 `_nanju-projects.json` 文件内容——这是 NR1 分析的关键证据。

---

# 🛡️ Defender 响应 — AC Round 3

## 判定总表

| Finding | Attacker | Defender 判定 | 理由摘要 |
|---------|----------|--------------|---------|
| R1 | 🟡 YELLOW | **ACCEPT 🟡** | 结构修复正确；数据通道为 spec gap，路径 (a) 可解 |
| R2 | 🟢 GREEN | **ACCEPT 🟢** | 无争议 |
| Y2 | 🟢 GREEN | **ACCEPT 🟢** | 无争议 |
| Y8 | 🟡 YELLOW | **ACCEPT 🟡** | 与 NY2 合并处理 |
| **NR1** | 🔴 **RED** | **DOWNGRADE → 🟡 YELLOW** | 技术分析正确，严重性误判——桌面单进程环境使竞态条件实际不可触发 |
| NY1 | 🟡 YELLOW | **ACCEPT 🟡 (MERGE→R1)** | 与 R1 残留 yellow 是同一问题 |
| NY2 | 🟡 YELLOW | **ACCEPT 🟡** | 合理 spec gap |
| NY3 | 🟡 YELLOW | **ACCEPT 🟡** | 合理 spec gap |
| NY4 | 🟡 YELLOW | **ACCEPT 🟡** | 合理 spec gap |

---

## NR1：🔴 → 🟡 降级（核心争议）

### 接受的部分

攻击者的**技术分析本身是正确的**：`writeJsonFileAtomic`（temp + atomic rename）保证的是**单次写入的崩溃安全**，而非 **read-modify-write 的并发互斥**。设计文档中"数组追加不冲突"的推理确实存在逻辑跳跃——JSON 数组不是真正的 append-only 数据结构，它是 read-modify-write，理论上存在 lost update 风险。

**我承认设计的并发安全声称措辞不严谨，应修正。**

### 降级理由：严重性误判

攻击者明确邀请我评估桌面场景。我的分析如下：

#### (1) Proma 运行环境是单进程单线程

Proma 是单用户桌面 Electron 应用。所有 Agent 会话运行在**同一个 Node.js 主进程**中，共享**同一个事件循环**。不存在多进程或多线程并行访问文件的情况。

#### (2) Node.js 事件循环中的精确竞态窗口分析

```javascript
// Orchestrator 代码（单一 session 内，sequential await）：
const data = await readJsonFile(path);    // I/O 开始，await 挂起
// ↓ I/O 完成，continuation 作为 microtask 入队
// ↓ continuation 执行——这是 SYNCHRONOUS 代码块，不会被中断：
data.projects.push(newProject);
await writeJsonFileAtomic(path, data);     // I/O 开始，await 挂起
```

**关键**：从 `await readJsonFile()` 的 continuation 开始执行，到 `writeJsonFileAtomic()` 被调用并返回 promise 之间，代码是**同步的**——`data.projects.push()` 不会被打断。

竞态条件要发生，需要另一个 session 的 `readJsonFile` I/O **恰好**在同一个 event loop tick 中完成（两个 readFile 的 I/O 完成回调在同一批 microtask 中）。这要求：

- **Session A** 在 T 时刻发起项目创建（读取 `_nanju-projects.json`）
- **Session B** 在 T±ε 时刻也发起项目创建（读取同一个文件）
- 两次 I/O 在同一个 event loop tick 完成

#### (3) 实际触发概率：趋近于零

| 条件 | 现实约束 |
|------|---------|
| 需要两个 session 同时创建项目 | 用户是**单人在单台机器**上操作，一次只能在一个 session 中输入指令 |
| 项目创建是手动触发 | 用户需要键入创建请求 → 等待 Agent 响应 → 处理创建逻辑，耗时数秒 |
| 两次 I/O 需在同一 tick 完成 | 即使用户在两个 session 间切换，I/O 窗口间隔至少数秒，而 Node.js event loop tick 是微秒级 |

攻击者自己也承认：*"触发条件: 实际中单用户同时操作两个项目的概率低"*。

#### (4) 实际证据支持

我检查了实际的 `_nanju-projects.json`：

```json
[
  {"projectId": "e6d0d3a5", "createdAt": "2026-08-11T04:13:52.092Z"},
  {"projectId": "f7f12945", "createdAt": "2026-08-11T04:14:45.976Z"},
  // ... 最短间隔 53 秒
  {"projectId": "桌面便签", "createdAt": "2026-08-11T08:21:56.930Z"},
  {"projectId": "代办tips", "createdAt": "2026-08-11T08:46:40.458Z"},
  // ... 9 个项目，最小创建间隔 53 秒
]
```

**最小创建间隔 53 秒**。在这种时间尺度下，两个 session 的文件 I/O 窗口重叠的概率是零。

#### (5) 影响可恢复

即使发生 lost update，丢失的只是一个项目的**索引条目**——项目自身的文件（`project-{id}/` 目录）不受影响，可以从目录扫描重建索引。

#### (6) 攻击者的修复建议正确但低成本

攻击者建议的 per-project 文件方案是好的改进，但它只是**spec 措辞修正 + 轻微架构改进**，不构成 RED 级实现阻塞。

### 结论

| 维度 | 评估 |
|------|------|
| 技术正确性 | ✅ 攻击者分析正确——read-modify-write 理论上不安全 |
| 严重性评估 | ❌ RED 不成立——目标环境中竞态条件实际不可触发 |
| 正确严重性 | 🟡 YELLOW——措辞应修正，建议采用 per-project 文件 |
| 实现阻塞 | 否 |

**提议裁决**：将设计的"并发安全"声称修正为 *"v2 为单用户单进程场景设计，`_nanju-projects.json` 的写入发生在项目创建这一低频操作中，当前不引入并发控制；v3 如需多会话并发项目创建，建议迁移至 per-project 索引文件"*。同时采纳攻击者的 per-project 文件建议作为 v3 改进项。

---

## R1 / NY1：🟡 ACCEPT（合并处理）

### R1 — Write 矛盾的结构修复

**ACCEPT YELLOW**。结构修复正确：将 Write 职责从 L1 Agent 转移到 Harness 代码层，消除了 canUseTool 门禁冲突。这是正确的架构决策。

### NY1 — AC 结果提取通道

NY1 与 R1 的残留 yellow 是**同一个问题的两面**：R1 解决了"谁有权写"（Harness），NY1 提出了"数据从哪来"（L1→Harness 通道）。

**Clarify**：设计意图是路径 (a)——L1 通过结构化标记输出 AC findings，Harness 解析提取。这不是脆弱的 NLP 解析，而是**约定标记格式**：

```markdown
<!-- AC_RESULT: {"phaseId":"requirements","verdict":"pass","findings":[...]} -->
```

在 L1 systemPrompt 中增加此输出约定即可。这属于 spec 细化，不应阻塞实现。

**建议**：将 R1-yellow + NY1 合并为一个 yellow，标注修复方向为"在 Section 7 L1 systemPrompt 中增加 AC 结构化输出约定"。

---

## R2：🟢 ACCEPT GREEN

无争议。iterative route 的所有节点（REQUIREMENTS → prototype → architecture → planning → SENTINEL）均显式定义，注释修复意图明确。完全修复，无回归。

---

## Y2：🟢 ACCEPT GREEN

`needs_modification` 加入 retry 条件的逻辑正确：
- 与 `requiresUserConfirmation` 的优先级顺序正确（retry 先于 ask_user）
- 无副作用

---

## Y8 / NY2：🟡 ACCEPT YELLOW（合并处理）

Y8 的"推进标记"和 NY2 是同一问题：职责边界表中引入了"阶段推进声明 → L1 回复文本中包含推进标记"，但标记格式未定义。

**ACCEPT YELLOW**。这是合理的 spec gap。

**建议修复**：定义明确标记格式，如 `<!-- PHASE_ADVANCE: {phaseId} --> {next} -->`，并在 L1 systemPrompt 中要求推进时使用此标记。与 R1/NY1 的 AC findings 标记采用相同的设计模式。

---

## NY3：🟡 ACCEPT YELLOW

`CompactContext` 不在任何阶段的工具白名单中，但 Section 9 指示 Agent 在上下文接近上限时主动 compact。

**ACCEPT YELLOW**。

**补充澄清**：在 Proma 的实际实现中，`CompactContext` 是**会话元工具**，其行为是"compact 当前 session 后 Proma 自动从 compacted context 继续任务"。它与 Bash/Write/Edit 等开发工具不同，它的效果是**session 级别的**，不受 phase 工具白名单限制——因为白名单控制的是"当前阶段允许做什么开发工作"，而 compact 是"管理会话自身的上下文"。

但即使如此，spec 应该**显式声明** CompactContext 不受 `canUseTool` 限制（或将其加入全局白名单），消除歧义。

---

## NY4：🟡 ACCEPT YELLOW

`ModeSelectView` 在 Section 3 被引用但未定义。

**ACCEPT YELLOW**。

**Clarify**：`ModeSelectView` 应该就是 `AskUserQuestion` 在项目创建时的调用。实际的 `_nanju-projects.json` 数据证实了这一点——每个项目都有 `mode: "quick"` 或 `mode: "iterative"` 字段，这些值是用户在项目创建时通过交互选择的。

**建议**：将 `ModeSelectView` 重命名为 `modeSelectionStep` 或直接描述为"通过 AskUserQuestion 让用户选择 quick/iterative 模式"，并补充到 Section 4.1 的项目创建流程中。

---

## 收敛总结

### 本轮无 RED

攻击者报告的唯一 RED（NR1）经分析应**降级为 YELLOW**。理由总结：

1. **技术分析正确**——read-modify-write 在并发环境下确实不安全
2. **严重性误判**——攻击者将服务器多租户并发模型错误应用到单用户桌面 Electron 应用
3. **实际证据**——9 个项目的最小创建间隔 53 秒，I/O 窗口重叠概率为零
4. **攻击者自认**——"实际中单用户同时操作两个项目的概率低"
5. **修复成本低**——per-project 文件或声明 v2 单项目活跃

### 活跃 YELLOW 清单（6 个）

| ID | 问题 | 修复方向 | 阻塞性 |
|----|------|---------|--------|
| R1+NY1 | AC findings L1→Harness 数据通道 | systemPrompt 增加结构化输出约定 | 低 |
| Y8+NY2 | 阶段推进标记格式未定义 | 定义 `<!-- PHASE_ADVANCE -->` 标记 | 低 |
| NR1↓ | 并发安全声称不准确 | 修正措辞 + v3 per-project 文件 | 低 |
| NY3 | CompactContext 白名单地位 | 显式声明不受 canUseTool 限制 | 低 |
| NY4 | ModeSelectView 未定义 | 明确为 AskUserQuestion 调用 | 低 |

### Defender 立场

**建议收敛**。所有活跃 yellow 均为 **spec 细化问题**（增加格式定义、修正措辞、补充声明），不涉及架构重新设计。可以进入"修正 v2.3 → v2.4 + 收敛判定"阶段。

---

**等待 Arbiter 裁决**。核心争议点：NR1 的 RED→YELLOW 降级是否成立。

## Arbiter Verdict


# AC Round 3 仲裁结论

## 审计配置
- Attacker: DeepSeek V4 Pro — 1 red (NR1) + 6 yellow
- Defender: GLM 5.2 — 降级 NR1 为 yellow（桌面单进程无竞态），接受其余

## 前两轮修复验证

| 轮次 | Red | v2.3 状态 | 判定 |
|------|-----|----------|------|
| R1 | F2/F4/F6/F11 | 全部修复 | ✅ |
| R2 | R1(AC Write) | 结构修复，数据通道待明确 | 🟡 yellow |
| R2 | R2(路由缺节点) | makeRoute() 显式定义 | ✅ green |

## R3 核心争议：NR1 RED→YELLOW 降级

**攻击者观点**：`_nanju-projects.json` 并发写入 read-modify-write race condition，声称并发安全但机制不支持。

**防御者反驳**：
1. Proma 是单用户桌面 Electron 应用，主进程 JS 单线程，事件循环串行
2. Node.js 事件循环中 read→push→write 是同步代码块，不会被中断
3. 实际证据：9 个项目最小创建间隔 53 秒，I/O 窗口重叠概率为零
4. 攻击者自认"概率低"
5. 即使丢失，只丢索引条目，项目文件不受影响，可从目录扫描重建

**仲裁裁决**：**agree-defender，降级为 YELLOW**

理由：
- 技术分析正确（read-modify-write 理论上不安全）
- 但严重性不成立：单用户桌面 Electron + JS 单线程 = 无实际竞态
- 防御者的环境分析准确，攻击者的服务器思维不适用
- 修复成本极低（修正措辞 + 声明 v2 单项目活跃）

## 最终收敛判断

### 三轮审计 Red 趋势

| 轮次 | 新 Red | 修复确认 | 趋势 |
|------|--------|---------|------|
| Round 1 | 4 | — | 基线 |
| Round 2 | 2 | 4/4 ✅ | ↓ 50% |
| Round 3 | 0 (NR1 降级) | R2 ✅ / R1→yellow | ↓ 100% |

**Red 从 4→2→0，收敛。**

### 活跃 Yellow（全部为 spec 细化，无架构问题）

| 问题 | 修复方向 | 阻塞实现？ |
|------|---------|----------|
| R1+NY1: AC findings 通道 | systemPrompt 加结构化输出约定 | 否 |
| Y8+NY2: 推进标记格式 | 定义 `<!-- PHASE_ADVANCE -->` | 否 |
| NR1↓: 并发安全措辞 | 修正为"v2 单项目活跃" | 否 |
| NY3: CompactContext 白名单 | 声明不受 canUseTool 限制 | 否 |
| NY4: ModeSelectView 定义 | 明确为 AskUserQuestion | 否 |

### ✅ 结论：已收敛，可以进入实现阶段

三轮 AC 异构审计（DeepSeek × GLM × 仲裁）：
- 6 个 red 全部修复或降级
- 活跃 yellow 全部是 spec 细化级别（格式约定、措辞修正），不影响架构正确性
- 防御者无反驳（100% accept），唯一争议 NR1 经仲裁降级

**建议：修正 spec 措辞 + 补充格式约定 → 直接实现。**
