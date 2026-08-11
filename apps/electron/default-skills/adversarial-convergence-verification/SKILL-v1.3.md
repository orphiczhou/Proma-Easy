---
name: adversarial-convergence-verification
description: 当用户需要审查/验证结构化文档时触发。核心能力：对抗-收敛范式（Attacker六维攻击→Defender接受/反驳/澄清→Arbiter争议裁决）+ DUAL-GATE双闸停止协议。v1.3新增：维度判定边界、Attacker轮换、双Arbiter交叉验证。
version: "1.3.0-draft"
status: "draft-not-published"
---

# 对抗-收敛文档审查方法论 (Adversarial Convergence, AC) V1.3

> ⚠️ 此文件为 v1.3 草案，v1.2 仍在批量测试中，本文档仅供内部测试，禁止发布。
> ℹ️ v1.3 是 v1.2 的 delta 文档：规则 1-7 及 DUAL-GATE 的 G1/G2 完整定义均继承自 v1.2，本文档仅记录 v1.3 相对 v1.2 的修订点。下方涉及 v1.2 内容处均显式标注继承关系。发布版将附规则 1-7 摘要附录。

## 核心洞察

**审查质量的提升不来自"更多眼睛看同一个东西"，而来自"迫使同一双眼睛从对立角度看同一个东西"。**

---

## ⚠️ 执行规则

### 规则1-7：与 v1.2 完全相同

（规则1-7 内容不变，详见 v1.2 SKILL.md。本 delta 草案不重复内联，发布版将附规则 1-7 摘要附录。）

### 规则8：Attacker 轮换（v1.3新增，防止注意力稀释）

**单Attacker持续多轮审查同一文档会导致注意力稀释**——后期倾向于"找不去了"而非"深度挖掘"。v1.1 实证：5 轮后发现率降至个位数，但无法区分"真没了" vs "找累了"。

**轮换分两级：硬轮换（跨家族）优先，软轮换（同家族跨版本）作降级补充。** 当前独立模型家族通常仅 3 个（DeepSeek / GLM / MiniMax），硬轮换在长轮次下必然耗尽异构性，软轮换用于填补。

```
【硬轮换 — 跨家族，异构性最强】（主模式，前提：3 家族可用）
每 2 轮强制轮换 Attacker 家族，3 家族循环复用：
  - 轮次 1–2：Attacker-A（如 DeepSeek V4 Pro）
  - 轮次 3–4：Attacker-B（如 GLM-5.2，与 A 不同家族）
  - 轮次 5–6：Attacker-C（如 MiniMax-M3，与 A、B 都不同家族）
  - 轮次 7+：回到 A→B→C 循环（标注 hard_rotation_cycle_reuse），
    但新 Attacker 的 Prompt 必须声明"此家族在第 N 轮已审查过，
    请刻意避免沿用当时的视角与攻击向量"

【软轮换 — 同家族跨版本，硬轮换降级补充】（v1.3 R3 修订，修复 P0-1）
当硬轮换无法提供新异构性时启用：
  - 触发条件（任一）：3 家族已完整循环 ≥1 轮（轮次 7+） / 某家族模型不可用 / 仅 2 家族
  - 做法：在同家族内切换不同版本，引入参数/对齐层面的差异
    · DeepSeek 族：V4 Pro ↔ V4 Flash GA
    · GLM 族：GLM-5.2 ↔ GLM-4.6（若可用）
    · MiniMax 族：M3 ↔ M2（若可用）
  - 标注 soft_rotation_within_family
  - ⚠️ 软轮换异构性远弱于硬轮换（同家族训练语料/对齐方法相近），
    报告必须声明 soft_rotation_active=true，并提示"注意力稀释缓解程度有限"

【降级模式 — 显式覆盖硬轮换的 3 家族前提】（v1.3 R3 修订，澄清降级与硬轮换的主备关系）
当可用家族 < 3 时，以下降级模式覆盖硬轮换主模式的 3 家族循环要求
（非矛盾，而是分层 fallback——降级模式为 <3 家族场景设计）：
【2 厂商降级】
  - A→B→A 交替（标注 attacker_rotation_2model），并在 A、B 内部尽量切换版本以增加差异

【1 厂商降级】
  - 仅在同家族内做版本轮换，标注 attacker_rotation_single_family，MIN_ROUNDS=3

轮换时的交接（硬/软轮换通用）：
  - 向新 Attacker 传递：Attack Log + 当前文档 + 前任审查摘要
  - Prompt 包含："你的前任 Attacker({前任模型})已经审查了 {k} 轮。请从新的视角继续审查。"
    （注：不传递具体发现数 D_k，仅传递轮次 k，减少锚定效应）
```

**⚠️ "V4 Flash GA 禁令"的作用域（v1.3 R3 修订，修复 P0-2 二阶回归实例）：**

R1 引入的"Attacker-A=DeepSeek 时 Attacker-B 禁用 V4 Flash GA"禁令，**仅适用于硬轮换的异构校验**——目的是防止"假异构"（把同属 DeepSeek 家族的 V4 Flash GA 当作异构家族来冒充"3 个不同家族"）。

该禁令**不适用于软轮换**：软轮换的本意就是"在同家族内切换版本"，此时 V4 Flash GA 相对 V4 Pro 的差异正是软轮换要利用的资源；若把禁令延伸到软轮换，DeepSeek 家族（V4 Pro + V4 Flash GA）排除后者后仅剩 1 个版本，软轮换无法操作（这正是 P0-2 的回归根源）。

| 场景 | V4 Flash GA 可用性 | 说明 |
|------|:---:|------|
| 硬轮换中充当"异构家族" | ❌ 禁用 | 同属 DeepSeek 家族，违反硬轮换异构约束 |
| 软轮换中作为"同家族另一版本" | ✅ 可用 | 软轮换本就依赖同家族版本差异 |
| Arbiter-B（要求与 Arbiter-A 不同家族） | ❌ 禁用（若 Arbiter-A 为 DeepSeek 族） | 见 §3.2.2，属异构校验，非软轮换 |

---

## 一、适用文档与进入条件

（与 v1.2 基本相同；v1.3 新增 §1.1 自指适用性声明）

### 1.1 自指适用性声明（v1.3 新增）

本方法论可审查任意结构化文档，而方法论自身（本 SKILL 文件）也是结构化文档——因此理论上可被自身审查。但**自指审查存在结构性限制**，使用者必须知晓：

1. **规则循环**：方法论中的规则（DUAL-GATE、Attacker 轮换、维度判定边界等）会被用来审查其自身的设计，存在"用规则证明规则"的循环风险。Attacker/Defender/Arbiter 的裁决不具备与非自指审查同等的独立性。
2. **二阶回归（结构性）**：对方法论自身的每一次修复都可能引入新缺陷（例：v1.3 规则8 为修复"注意力稀释"引入了"V4 Flash GA 禁令"，又为禁令引入了"软轮换需 ≥2 同家族版本"，二者交互又产生 P0-2 的二阶回归）。自指审查理论上可无限递归。**此类结构性二阶回归不可消除，仅可通过对抗审查控制。**区别于 R3 修复表中的**具体回归实例**（如 P0-2）——后者是可定位、可修复的单个 bug。
3. **收敛不可达**：基于上述两点，自指审查**不应期待统计收敛**——DUAL-GATE 的 G1/G2 在自指场景下可能反复触达 `escalate_human` 而非 clean converge，这是结构特性而非流程缺陷。

**DUAL-GATE 适用范围**：DUAL-GATE 收敛判定（§3.6）适用于**非自指**审查。对自指审查，因上列结构性限制，DUAL-GATE 仅作**咨询性信号**，终止形态以本节 (a)/(b)/(c) 为准。

**推荐终止形态**：自指审查应终止于以下之一，而非追求自洽收敛：
- **(a) 外部独立审查**：由独立于方法论设计者的第三方 Agent 集合（异构、未参与本版本设计）给出最终裁决；
- **(b) ESCALATE_HUMAN 强制收口**（自指审查专用终态）：把统计上无法收敛的争议升级人工裁决，不再追求自动收敛。**区别于 §3.5 的单次 `escalate_human` 事件**——后者为双 Arbiter 分歧时的正常升级路径单元。当 escalate_human 事件累计达 ≥3 次时，触发一次"暂停"状态（暂停审查并请求人工介入）。经人工裁定并 reset 计数后审查恢复；若再次累计 ≥3 次 escalate_human 触发第 2 次"暂停"，则立即升级为本终态（ESCALATE_HUMAN）。此措辞消除"累计 ≥3 次触发暂停"的结构性歧义——明确"暂停"由 escalate_human 事件触发（非暂停事件自身累计），"连续 2 次暂停"指两次独立的暂停事件。（v1.3 R6 修订，修复 ATK-U-001）
- **(c) 版本快照冻结**：在某一轮修复后冻结版本，把残留问题转为"已知限制清单"对外声明，不再追求该版本的自洽。

> 实证参考：同体系的 `structured-doc-multi-agent-verification-v2` 在自指审查时即终止于 ESCALATE_HUMAN 而非统计收敛（Track B 上界公式矛盾 + 捕-再捕封闭种群假设失效致 STOP 永不可达）。本方法论的自指审查预期同样终止于 (a)/(b)/(c) 之一。

> **与 §3.6 early_stop 的关系**（v1.3 R4 增补，修复 ATK-I-006）：自指审查的 early_stop（§3.6, MAX_ROUNDS=2）仅作为触发本节终止路径评估的信号，不构成独立的强制收口。Executor 在收到 early_stop 信号后必须在本节 (a)/(b)/(c) 中选择其一并显式记录，禁止以 MAX_ROUNDS 到期为由直接关闭审查。

---

## 二、六维攻击面

| 维度 | 攻击策略 | Prompt关键词 |
|------|---------|-------------|
| **I**(自洽) | 找文档内部矛盾，原文对原文 | "找出文档中所有自相矛盾或不一致之处，引用矛盾的原文" |
| **F**(保真) | 对照上游spec逐条检查偏离和遗漏 | "对照上游文档逐项检查一致性，标记所有偏离和遗漏" |
| **Z**(可造) | 找技术上不可实现的需求 | "评估每个需求的技术可行性，标记不现实的要求" |
| **U**(可懂) | 找歧义、未定义术语、模糊表述 | "找出所有可能引起误解的表述、未定义术语、过于模糊的描述" |
| **L**(闭环) | 找未闭合的状态路径、越界操作 | "画出角色-状态图，标记所有未闭合的路径和越界操作" |
| **G**(护栏) | 找不可测试/不可追溯的需求 | "对每个需求判断可测试性，标记无法客观验证的验收条件" |

### 维度判定边界（v1.3新增：澄清可操作性）

**I (自洽) 判定边界：**
- ✅ 同一状态/字段在不同位置枚举不同 → BLOCKING 矛盾
- ✅ 相互引用的段落之间存在逻辑冲突 → MAJOR 矛盾
- ❌ 同一概念用不同名称表述（如"用户ID" vs "用户标识"）→ 不是矛盾，归入 U(可懂)
- ❌ 时间关系模糊但不冲突 → 不算矛盾，标记 SUGGESTION
- ❌ 使用"或"字列举的互斥选项 → 不是矛盾（是设计选择）

**F (保真) 判定边界：**
- ✅ 上游 spec 明确要求但本文档缺失 → BLOCKING 遗漏
- ✅ 本文档内容与上游 spec 明确冲突 → BLOCKING 偏离
- ❌ 上游 spec 未提及但本文档新增了内容 → 不是遗漏（是设计扩展）
- ❌ 术语在不同文档间有微调但语义一致 → 不算偏离
- ❌ delta 文档未内联上游已继承内容 → 不是遗漏（delta 文档的设计裁量；发布版需补附录）（v1.3 R3 增补）

**Z (可造) 判定边界：**
- ✅ 需求明确违反物理/工程约束（如"0延迟"）→ BLOCKING
- ✅ 需求需要不存在的技术前提 → MAJOR
- ❌ 需求"很难实现但有理论可能" → 不算不可造，标记 SUGGESTION
- ❌ 需求未给出技术方案 → 不是不可造（需求文档不需要实现方案）

**U (可懂) 判定边界：**
- ✅ 未定义就使用的术语 → MAJOR
- ✅ 一句话可读出 ≥2 种实质不同的理解 → BLOCKING 歧义
- ❌ 术语有定义但定义不够详细 → 不算未定义
- ❌ 需要领域知识才能理解 → 不算歧义（文档有目标读者假设）
- ❌ 术语在文档中未被使用 → 无从歧义（v1.3 R3 增补）

**L (闭环) 判定边界：**
- ✅ 状态机中某状态缺少出边/入边 → BLOCKING 未闭合
- ✅ 角色权限在某操作路径上未定义 → MAJOR
- ❌ 异常路径未完整覆盖 → 不算未闭合（正常路径优先），标记 SUGGESTION
- ❌ 并发/竞态场景未穷举 → 不算未闭合

**G (护栏) 判定边界：**
- ✅ 需求无客观度量标准（如"系统要快"）→ BLOCKING 不可测试
- ✅ 安全关键操作缺少鉴权/审计要求 → BLOCKING
- ❌ 验收条件不完整但已有核心度量 → 不算不可测试，标记 SUGGESTION
- ❌ 性能指标使用了相对词但上下文可推断 → 不算不可测试
- ❌ 指标在文档中未被声明 → 无可测性议题（v1.3 R3 增补）

**维度权重（按文档类型自适应）：**

| 文档类型 | I | F | Z | U | L | G |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|
| PRD | 10% | 30% | 10% | 20% | 15% | 15% |
| API规范 | 15% | 25% | 15% | 10% | 10% | 25% |
| 架构设计 | 10% | 15% | 25% | 10% | 25% | 15% |

> 注：权重来源于 v1.2 实验校准（n=12 文档样本的维度缺陷分布归一化），当前为经验值。本轮自指审查发现此表缺少来源标注——已在 v1.2 SKILL.md 中有完整推导，v1.3 发布版将内联来源说明。（v1.3 R3 增补，修复 ATK-F-002）

---

## 三、AC审查管线

### 3.1 完整管线

```
Step 0: 环境准备——Executor创建Attacker/Defender/Arbiter独立子会话（v1.2/v1.3: Executor不担任Agent角色）
Step 1: Attacker六维攻击 → 输出Attack JSON
Step 2: Defender逐条回应 → Accept(修复)/Refute(反驳)/Clarify(澄清)
Step 3: 双Arbiter裁决争议（v1.3: 两个异构Arbiter独立裁决）  ← v1.3 变更
Step 4: 收敛判定（DUAL-GATE + constant分支 + early_stop）
Step 5: 输出审查报告
```

### 3.2 环境准备 (Step 0)

**⚠️ v1.2/v1.3 关键规则：Executor（编排者）不担任任何Agent角色。**

**Executor（编排者）角色定义**（v1.3 R3 修订，修复 ATK-U-002 / ATK-G-003；**v1.3 R5 修订，修复 P0-1 / P0-3 / P1-3**）：
- **职责**：
  1. 创建独立子会话并分配模型和角色（Attacker / Defender / Arbiter-A / Arbiter-B）
  2. 在会话间传递：Attack Log + **完整原文文档（非压缩摘要，须内联至 Prompt 主体）** + Defender 独立信息源 + **SHA-256 文档指纹**（详见 §3.2.3 Step 0）
  3. 事后统计指标（含 Refute 率、escalate_human 计数、DUAL-GATE G1 状态）
  4. 执行升级阈值与暂停判定（累计 escalate_human ≥ 3、Refute 率越界等）
  5. **每轮结束前强制执行"Executor 越界自检"**（详见下方"角色隔离硬约束"）
- **文档传递完整性约束（适用所有 Agent，含 Attacker / Defender / Arbiter-A / Arbiter-B / Prober）**（v1.3 R3 增补 Defender；**v1.3 R5 扩展至 Arbiter，修复 P0-1 / P1-3**）：Executor 向**任一 Agent**传递的"当前文档"必须是完整原文，且**必须内联至该 Agent 的 Prompt 主体**，不可依赖"上文已传递""会话历史中已有""文件系统中存在""请自行查找"等间接引用方式。R2 实证：Arbiter-A 因被允许"自行查找审查目标文档"而定位到 v1.2.0 而非 v1.3，致 11/15 裁决基于错误版本。若因 token 限制需压缩或分片（Defender 超 >15K token 场景见 §3.4.1），必须显式标注 `doc_truncated=true` + 被省略/分片的章节列表——Agent 收到不完整文档时应拒绝就涉及被省略章节的攻击做出 Refute / 裁决。
- **角色隔离硬约束（无条件禁止，无任何例外）**（v1.3 R5 修订，修复 P0-3）：**Executor 在任何情况下——包括但不限于单点故障、复合故障、Arbiter 超时、模型不可用、降级模式、试运行、调试、人类操作员离线——都不得扮演、代行、模拟、代为产生或"暂代"Attacker / Defender / Arbiter / Prober 的实质性输出（攻击 JSON / Accept-Refuse-Clarify / verdict / Prober 回归判定）。** R1+R2 两次自指审查实证：即使 §3.2.1 L4 单点故障应急通道下授予"唯一例外"，Executor 仍在复合故障压力下越界扮演 Agent 角色（顽疾，两次重复）。因此本条款**取消所有"例外"措辞**，改为无条件禁止语句；原 R3/R4 授予 L4 的"Executor 基于原文执行降级裁决"权限在 R5 同步废止（见 §3.2.1 L4 修订）。
  - **每轮结束前强制"Executor 越界自检"**（v1.3 R5 增补，修复 P0-3）：Executor 在每轮 Step 1–5 结束后、进入收敛判定或报告生成前，必须执行并记录以下自检：
    1. 本轮所有 Attacker 攻击 JSON 是否来自 Attacker 子会话的 `list_messages` 产出（非 Executor 自拟）
    2. 本轮所有 Defender Accept / Refute / Clarify 是否来自 Defender 子会话的 `list_messages` 产出（非 Executor 自拟）
    3. 本轮所有 Arbiter verdict 是否来自 Arbiter-A / Arbiter-B 子会话的 `list_messages` 产出（非 Executor 自拟）
    4. 自检结果记入 `executor_overreach_check` 字段（结构：`{round_k, attacker_ok, defender_ok, arbiter_a_ok, arbiter_b_ok, all_verified, check_method: "list_messages"}`）；任一项为 false → 立即停止本轮并触发 §1.1(b) ESCALATE_HUMAN 强制收口终态，禁止"用 Executor 产出补齐后继续"
- **担任者**：可由人类操作员或自动化编排脚本担任；操作可由 Arbiter 对照本定义审计
- **审计**：Executor 的角色隔离合规性由 Arbiter 在每轮结束后抽查（检查 Executor 是否在任意 Agent 的输出中扮演了实质性裁决/攻击/辩护角色；`executor_overreach_check` 字段为抽查必查项，缺失即视为越界）

#### 3.2.1 子会话创建方式（v1.3新增）

**使用 `remote-session` 而非 `collaboration` 创建子会话。**

`collaboration` 创建的子会话无法再创建子会话——这会导致 Attacker/Defender/Arbiter 无法进一步派生子 Agent。必须使用 `mcp__remote-session__remote_create_session` 创建独立会话，每个会话可指定不同渠道（channel_id）以使用不同厂商模型。

```
正确做法：
  remote_create_session(instance="pro", channel_id="<DeepSeek渠道>", model_id="deepseek-v4-pro")  → Attacker
  remote_create_session(instance="pro", channel_id="<ZLM渠道>", model_id="GLM-5.2")                → Defender
  remote_create_session(instance="pro", channel_id="<MiniMax渠道>", model_id="MiniMax-M3")          → Arbiter

> **渠道命名约定**（v1.3 R4 增补，修复 ATK-U-006）：ZLM = 智谱 GLM 系列模型在 Proma remote-session 中注册的编程适配渠道实例（承载 GLM-5.2/GLM-4.6 等模型）；MiniMax-CodingPlan 承载 MiniMax-M3/M2.7 等模型；DeepSeek官方 承载 V4 Pro/V4 Flash 等模型。具体 channel_id 值由部署环境配置。

错误做法：
  delegate_agent(...) → 子会话无法再创建子会话，AC 管道断裂

降级路径（分层，分离基础设施与模型异构；**v1.3 R5 修订，修复 P0-2 升级为 N-fault 模型**）：

以下 L1–L4 描述的是**单点故障**（同一时刻仅 1 个角色不可达）的分层 fallback。**复合故障（≥2 角色同时不可达）不在此处处置，统一走文末"N-fault 模型"直通 ESCALATE_HUMAN。**

  L1: 有 Pro 实例 → remote-session（完整模式，多厂商异构）
  L2: 无 Pro 实例，但 ≥2 厂商可用 → collaboration delegate_agent + 显式 model_id
      - 标注 session_mode=degraded_collab_multivendor
      - 保留多厂商异构：通过 model_id 参数指定不同模型
      - 限制：子会话不可再派生子会话（单轮审查，Executor 串行收集）
  L3: 无 Pro 实例 + 仅 1 厂商 → 同底座顺序
      - 标注 same_base_degraded_collab，MIN_ROUNDS=3
  L4: 远程 Arbiter 超时（单点 Arbiter 故障）→ 不再由 Executor 执行降级裁决
      - 触发条件：remote_send_message(wait=true) ≥3 次超时或单次 >10min 无响应
      - 处置链：标注 `arbiter_unavailable_remote_timeout` → retry 换 Arbiter 组合（不同厂商/版本，至多 2 次）→ 仍超时则触发 §1.1(b) ESCALATE_HUMAN 强制收口终态
      - ⚠️ **v1.3 R5 修订**：取消 R3/R4 授予的"Executor 基于原文执行降级裁决（标注 `arbiter_degraded_remote_timeout`）"应急权限——该权限在 R1+R2 自指审查中成为 Executor 越界扮演 Arbiter 的入口（与 §3.2 角色隔离硬约束的无条件禁止语句冲突）。Arbiter 不可达属于角色故障，按 N-fault 计数；若仅 Arbiter 单点故障，retry 后仍不可达即升级 ESCALATE_HUMAN，**不尝试 Executor 补偿**
      - 原 `arbiter_degraded_remote_timeout` 标注在 R5 起替换为 `arbiter_unavailable_remote_timeout`（语义从"已降级裁决"改为"不可达，待 ESCALATE"）

**N-fault 模型（v1.3 R5 新增，修复 P0-2 / 覆盖 R4 记录的 P0-3 复合故障未覆盖）**：

L1–L4 是单点故障模型，存在结构性盲区：R1+R2 自指审查实证，≥2 个角色同时故障时（如 Arbiter 超时 + Defender 卡顿），Executor 会在"补救"压力下越界扮演 Agent——这是单点 fallback 路径无法覆盖的场景。R5 引入 N-fault 计数与终止规则：

| 同时故障角色数 N | 处置 | 标注 |
|:---:|------|------|
| N=0 | 正常推进 | — |
| N=1 | 走 L1–L4 单点 fallback（但 L4 不再由 Executor 代裁） | 见各 L 标注 |
| **N≥2** | **立即触发 §1.1(b) ESCALATE_HUMAN 强制收口终态，不尝试任何 Executor 补偿** | `n_fault_escalation` + 故障角色清单 + 各角色首次故障时间 |

N-fault 判定与处置规则：
- **故障定义**：角色子会话在 L1–L4 fallback 后仍不可达（超时 / 拒绝响应 / 产出无效 JSON 经 1 次 retry 仍失败 / 文档版本指纹不匹配经重置重传仍失败）
- **触发后 Executor 必做的事**（三件，缺一不可）：
  1. 停止本轮所有 Agent 调度（不再发新 Prompt）
  2. 在报告中记录：故障角色清单 + 各角色首次故障时间戳 + 已尝试的 fallback + N 计数
  3. 直接进入 §1.1(b) ESCALATE_HUMAN 终态——**禁止"先让 Executor 顶替其中一个角色再继续"**
- **与 §3.2 角色隔离硬约束的关系**：N-fault 模型是无条件禁止语句的**补强**——即使没有 N-fault 规则，Executor 也不得扮演任何 Agent 角色（P0-3）；N-fault 规则进一步明确了"复合故障下不得补偿"的终止路径，关闭"复合故障→Executor 越界"的顽疾入口
- **与 R4 L4 权限的关系**：R4 授予的 `arbiter_degraded_remote_timeout`（Executor 降级裁决）在 R5 废止；R4 时代标注的 `defender_processing_slow_854s` 在 R5 被 §3.4.1 的 `defender_processing_slow` / `defender_failed` 二分替代
```

#### 3.2.2.1 可行性配置矩阵（v1.3 R2修复）

| 角色 | 首选模型 | 备选模型 | 关键能力要求 | 渠道 |
|------|---------|---------|------------|------|
| **Attacker** | DeepSeek V4 Pro | V4 Flash GA⚠️ / GLM-5.2 | 推理深度 ≥0.80，指令遵循 ≥32 | DeepSeek官方 |
| **Attacker轮换** | GLM-5.2 | MiniMax-M3（硬轮换语境：V4 Flash GA⚠️仅 2 厂商降级时可用、标注同家族；软轮换语境：V4 Flash GA 可用作同家族另一版本，详见规则8 作用域表） | 与主Attacker不同家族 | 对应渠道 |
| **Defender** | GLM-5.2 | — | 可靠度 ≥80%，领域适配 | ZLM-CodingPlan |
| **Arbiter-A** | MiniMax-M3 | V4 Flash GA | 事实准确度优先 | MiniMax-CodingPlan |
| **Arbiter-B** | V4 Flash GA | GLM-5.2（如未用于Defender） | **必须与Arbiter-A不同厂商** | DeepSeek官方 或 ZLM |
| **Prober** | V4 Flash GA | GLM-5.2（复用） | 可靠度 ≥Attacker水平 | DeepSeek官方 或 ZLM |
| **Executor** | 任意可用 | 复用Prober | 能调用API和读取JSON | 当前会话，不另建 |

**强制异构**：Attacker、Defender、Arbiter-A 必须使用 3 个不同模型家族。Arbiter-B 必须与 Arbiter-A 不同家族。

**降级场景**：
- 仅 2 个厂商可用 → Attacker(厂A) + Defender(厂B) + Arbiter(厂B复用)，标注 `dual_arbiter_degraded` + `l2_vendor_overlap`
- 仅 1 个厂商可用 → 同底座顺序模式，MIN_ROUNDS=3，标注 `same_base=true`

**可行性矩阵**（多数用户只有 2-3 个厂商，此矩阵覆盖最常见场景）：

| 可用家族 | Attacker | Defender | Arbiter-A | Arbiter-B | Prober | 标注 |
|:---:|------|------|------|------|------|------|
| 3 | DeepSeek V4 Pro | GLM-5.2 | MiniMax-M3 | V4 Flash GA(同DeepSeek族) | GLM-5.2复用 | `arbiter_b_same_family_as_attacker` |
| 2 | DeepSeek V4 Pro | GLM-5.2 | DeepSeek V4 Flash(同族) | 退化为单Arbiter | GLM-5.2复用 | `dual_arbiter_degraded` |
| 1 | DeepSeek V4 Pro | DeepSeek V4 Flash（同家族第二版本，T2 = Tier-2 备选）| DeepSeek V4 Pro(同族) | 退化为单Arbiter | 复用Arbiter | `same_base=true` |

> **T1/T2 命名约定**（v1.3 R4 增补，修复 ATK-U-004）：T1 = 家族内主版本（首选），T2 = 家族内第二版本（备选），二者构成软轮换对。如 DeepSeek 族 T1=V4 Pro、T2=V4 Flash GA。

#### 3.2.3 其余环境准备（v1.3 R5 修订，修复 P1-5 文档版本指纹）

1. 为Defender准备**真正的独立信息源**（写入文件或显式传递，不是同一模型的训练数据召回）
2. 初始化Attack Log为空
3. 确认 v1.2 SKILL.md 和 v1.3 SKILL.md 文件路径可访问
4. **文档版本指纹生成（强制，v1.3 R5 新增）**：对审查目标文档（完整原文）计算 SHA-256 指纹，记为 `doc_sha256`，并记录文档版本标识三元组 `{version, filename, mtime}`（如 `{version: "1.3.0-draft", filename: "SKILL-v1.3.md", mtime: <ISO8601>}`）。**所有 Agent（Attacker / Defender / Arbiter-A / Arbiter-B / Prober）的首次消息 Prompt 必须内联该指纹与版本标识**，供 Agent 在审查前自验。
   - **Prompt 内联段落**（置于完整原文之前，所有 Agent 通用）：
     ```
     【文档指纹】doc_sha256=<hex>; version=1.3.0-draft; filename=SKILL-v1.3.md; mtime=<ISO8601>
     请在开始审查前核验：你收到的文档原文与上述指纹/版本一致。首轮响应须回显 doc_sha256_echo=<同一 hex>。
     若不一致，立即在首轮输出中标注 document_version_mismatch 并停止审查——
     不要尝试自行在文件系统中查找"正确版本"，不要回退到任何"上文/历史/同名"版本。
     ```
   - **Agent 首轮响应须包含** `doc_sha256_echo=<hex>`；Executor 核验回显与 Step 0 指纹一致。
   - **不一致处置（`document_version_mismatch`）**：Executor 重新内联传递正确版本 + 重置该 Agent 子会话（非 retry 原会话，避免历史污染）后重跑；若同一 Agent 经 1 次重置重传仍报告不一致，按 N-fault 模型计入角色故障（见 §3.2.1）。
   - **R2 实证先例**：Arbiter-A 因缺少指纹核验步骤，被允许"自行查找"而定位到 v1.2.0 而非 v1.3，致 11/15 裁决基于错误版本（标注 `arbiter_a_wrong_document_version`）。R5 指纹机制从源头关闭此入口。

### 3.3 Attacker回合 (Step 1)

（与 v1.2 基本相同，增加轮换规则：）

**v1.3 Attacker 轮换**：详见规则8。每 2–3 轮更换 Attacker 模型。轮换时新 Attacker 接收：
- Attack Log（结构化数据）
- 当前文档
- 前任审查摘要：`"你的前任 Attacker({model})已经审查了 {k} 轮。请从新的视角继续审查。"`（注：不传递具体发现数，仅传递轮次数，减少锚定效应）

**规则8.2：轮换边界回归判定（防止规则7误触发）**

Attacker 轮换后首轮，新 Attacker 在 ±3 段内发现的缺陷可能是**前任遗漏**而非 Defender 修复引入的回归：
- ±3段内发现 → 计为 new_discovery 而非 regression
- 回归率分母 = 由前任 Attacker 已审查过的修复区域缺陷数
- 标注 rotation_boundary=true，不计入 REPAIR_MODE_RESET 触发判定（规则7）
- 轮换后第二轮起：回归率计算恢复正常

**攻击规则**（与 v1.2 相同）：
- 每维每轮最多3个缺陷
- 每个缺陷必须引用原文证据
- 不能提出修复方案
- 不能重复Attack Log中已记录的缺陷
- 某维找不到新缺陷→报告`DIM_CLEAN`
- **v1.3**：攻击时必须对照 §二·维度判定边界，确保攻击符合对应维度的 ✅/❌ 标准

（输出格式与 v1.2 相同）

### 3.4 Defender回应 (Step 2)

（与 v1.2 完全相同；包含 Refute 率 5% 下限 + 40% 上限）

**Refute 率约束的强制机制**（v1.3 R3 修订，修复 ATK-Z-001）：

Defender 自身是 LLM Agent，不具备运行时自我配额能力。Refute 率约束通过以下**事后审计**强制：

- 该区间由 **Executor 在每轮 Defender 回应结束后事后统计**（Defender 不自行计数）
- 若本轮 Refute 率 <5%（过度顺从，几乎全盘 Accept）：
  → Executor 标记本轮 Defender 倾向 `overly_compliant`，触发 `escalate_human` 事件
- 若本轮 Refute 率 >40%（过度防备，几乎全盘 Refute）：
  → Executor 标记本轮 Defender 倾向 `overly_defensive`，触发 Defender re-prompt 或 `escalate_human` 事件
- 事后审计不要求 Defender LLM 具备运行时自我配额能力——仅要求 Executor 在回合结束后统计和判定

#### 3.4.1 Defender 超长文档分片（v1.3 R5 新增，修复 P1-4）

R2 自指审查实证：Defender 收到 20K+ token 的完整文档后耗时 854s 才产出（SDK 10min 窗口与模型处理耗时竞态，原标注 `defender_processing_slow_854s`），Executor 当时无法区分"模型仍在处理（应继续等）"与"真正失败（应 retry / ESCALATE）"。R5 起对 Defender 输入引入分片策略与状态二分：

1. **分片阈值**：待审文档 >15K token（约 6 万字符；CJK 文档按字符数估算，英文按 1 token ≈ 4 字符）→ 按章节自然边界分片传递，每片 ≤15K token。
2. **分片传递规则**：
   - 每片独立进入 Defender 子会话，Prompt 头部携带 `doc_sha256` + `shard_id` + `shard_total` + `shard_range`（章节范围，如 `§3.2–§3.4`）
   - Defender 对每片独立产出 Accept / Refute / Clarify，攻击 ID 标注所属片（如 `ATK-X-XXX@shard2`）
   - 跨片攻击（涉及 ≥2 片的章节，如某概念在 §3.2 定义、在 §3.5 使用）由 Executor 在汇总阶段合并，提示 Defender 复核合并后的连贯性（标注 `cross_shard_consolidation`）
3. **状态二分（替代原单一标注 `defender_processing_slow_854s`）**：
   - `defender_processing_slow`（等待，非失败）：Defender 子会话在 SDK 窗口内有**部分产出**（partial flush——不完整 JSON、占位符、中途文件）**或** 产出文件 mtime 在持续更新 → Executor 继续等待，每 5min 核验一次产出增长（参见工作区 Memory `auditor-token-limit-stall` 的 partial-flush 增长判定 SOP）
   - `defender_failed`（真失败）：Defender 子会话 **≥20min 无任何产出增长**、或返回明确错误、或产出无效 JSON 经 1 次 retry 仍失败 → 计入角色故障；若同时其他角色也故障则 N≥2 → 触发 §1.1(b) ESCALATE_HUMAN
   - **区分依据**：以 `list_messages` 核验入库内容 + 产出文件 mtime 双信号判定，**不以 SDK 单次"处理中"状态为依据**（SDK "处理中" ≠ 真在产出，参见 `auditor-token-limit-stall` 实战：MiniMax-M3 单 turn 57min、18min 后完整产出的误判复盘）
4. **与 §3.2 文档传递完整性的关系**：分片传递仍属"完整原文"传递（每片都是真实原文切片，仅切分未省略），**不触发 `doc_truncated=true`**；`doc_truncated` 仅用于因 token 限制**省略**章节的场景，不用于**分片**场景。分片场景下 Defender 仍须就所属片的攻击做完整 Accept / Refuse / Clarify。

### 3.5 双 Arbiter 裁决 (Step 3) ← v1.3 核心变更

**v1.2**：单一 Arbiter。v1.1 实证发现单一 Arbiter 存在 conformity bias（知道 Defender 已反驳 → 倾向于认同 Defender），且无交叉验证。

**v1.3 双 Arbiter 机制**（v1.3 R5 修订，修复 P0-1 Arbiter 输入管控）：

```
Step 3a: Arbiter-A（模型 X，如 MiniMax-M3）独立裁决
Step 3b: Arbiter-B（模型 Y，如 V4 Flash GA，必须与 X 不同厂商）独立裁决

Arbiter-A 和 Arbiter-B 收到相同输入（原始攻击 + Defender反驳 + 原文），
但互不可见对方的裁决。
```

**⚠️ Arbiter 输入管控（无条件内联，禁止"自行查找"，v1.3 R5 新增，修复 P0-1）**：

R2 自指审查实证：Arbiter-A 被允许"自行在文件系统中查找审查目标文档"，结果定位到 `SKILL-v1.2.0.md` 而非 `SKILL-v1.3.md`，致 11/15 裁决基于错误版本（标注 `arbiter_a_wrong_document_version`）。R5 起对 Arbiter 输入施加与 Defender 同等的完整性约束（与 §3.2 文档传递完整性约束 + §3.2.3 指纹机制协同）：

1. **强制内联完整原文**：Executor 向 Arbiter-A / Arbiter-B 的 Prompt 必须**内联完整原文**（攻击 + Defender 反驳 + 待审文档原文），不依赖"上文传递""会话历史中已有""请自行查找"。Arbiter 子会话**不假定**继承自父会话或文件系统的文档可见性——这一假定正是 R2 实证中 Arbiter-A 漂移到 v1.2.0 的根因。
2. **文档版本指纹核验**：Arbiter Prompt 头部必须包含 §3.2.3 Step 0 生成的 `doc_sha256` 与版本标识三元组；Arbiter 首轮响应须回显 `doc_sha256_echo`，Executor 核验不一致即触发 `document_version_mismatch` 处置（重置该 Arbiter 子会话 + 重新内联传递，**非 retry 原会话**——避免历史污染）。
3. **`document_version_mismatch` 标注与 tainted 处置**：当 Arbiter 报告收到版本不一致、指纹不匹配、或检测到内联文档与外部可见版本冲突时，立即标注 `document_version_mismatch`，该 Arbiter **本轮所有裁决标记为 `tainted_by_version_mismatch`**——不计入 G1 阻塞清单、不计入 G4 一致性统计（不污染指标）——Executor 重新内联正确版本并重置该 Arbiter 子会话后重跑；同一 Arbiter 经 1 次重置重传仍报告不一致，按 N-fault 模型计入角色故障（§3.2.1）。

裁决格式（每个 Arbiter，v1.3 R5 增补 `doc_sha256_echo` 字段）：
```
{
  "doc_sha256_echo": "<hex, 须与 Prompt 头部一致>",
  "attack_id": "ATK-X-XXX",
  "verdict": "attack_upheld | attack_dismissed | escalate_human",
  "reasoning": "...",
  "confidence": 0.0-1.0
}
```

**双 Arbiter 结果合并规则**：

| Arbiter-A | Arbiter-B | 最终判决 |
|:---:|:---:|------|
| upheld | upheld | **attack_upheld**（一致确认） |
| dismissed | dismissed | **attack_dismissed**（一致驳回） |
| upheld | dismissed | **escalate_human**（分歧 → 升级人工） ⚠️ |
| escalate_human | * | **escalate_human** |
| * | escalate_human | **escalate_human** |

**关键改进**：v1.2 的单一 Arbiter 误判（尤其是 conformity bias 导致的 upheld→dismissed 错判）在 v1.3 中需要 Arbiter-B 也同意才能生效。不一致时自动升级人工。

**成本影响**：双 Arbiter增量成本 ≈5–10%（仅争议时 +1 调用/争议，争议占比 15–30%）

**升级阈值**：累计 `escalate_human` ≥ 3（v1.3 调低阈值以适应双 Arbiter 更多分歧）→ 暂停审查，请求人工裁决。

**暂停状态恢复机制**（v1.3 R3 修订，修复 ATK-L-003）：

```
暂停触发（累计 escalate_human ≥ 3）后：
  1. 暂停审查，请求人类操作员介入审查累计 escalate 原因
     （模型能力不足 / 文档本身存在深度缺陷 / 流程设计缺陷）
  2. 人类操作员裁定后，Executor 将 escalate_human 计数清零，审查重新进入 Step 0
  3. 再次触发暂停（第二轮累计 escalate_human ≥ 3）
     → 不再进入人类操作员介入，直接升级为 §1.1 (b) ESCALATE_HUMAN 强制收口终态
  4. 单次 escalate_human 事件计数与 24h 超时路径独立计数，互不叠加
```

**escalate_human 恢复路径（v1.3 R2修复，防止死锁）**：

```
争议标为 pending_human，保留在 Attack Log 中：
  1. 单个争议不阻塞本轮推进（本轮剩余攻击正常继续）
  2. pending_human 争议计入 G1 阻塞清单（G1 要求"争议列表为空"）
  3. 累计 pending_human ≥ 3 → 暂停审查，请求人工裁决
  4. 超 24h 人工未响应 → Executor 执行：
     a. retry: 换 Arbiter 组合重新裁决争议
     b. 或 downgrade: 标 unresolved_dispute
        - downgrade 语义：将 pending_human 争议标记为 unresolved_timeout，在终态报告中以"争议未决（人工超 24h 未响应）"客观呈现；Executor 仅做事实性记录（保留原始攻击 JSON、Defender 响应、等待时长），不产出 upheld/dismissed/escalate 任何裁决。本路径受 §3.2 角色隔离硬约束——Executor 在此路径中只做状态迁移与事实记录，不代行 Arbiter 裁决职能。（v1.3 R6 修订，修复 ATK-I-001：原"Executor 基于原文证据独立裁决"与 §3.2 无条件禁止语句死锁）
        - retry 和 downgrade 的选择条件：优先 retry（换 Arbiter 组合）；若两次 retry 均超时则 downgrade
  5. 标为 unresolved_dispute 的争议（原 4.c，v1.3 R4 修订修复 ATK-L-006 编号歧义）：
     - Attack Log 中标记 status=unresolved_dispute + 原因
     - 报告中归入"未解决争议（降级）"专区
     - 后续轮次 Attacker 收到提示："{n} 个争议因超时降级，若再次发现相关问题请重新攻击"
     - 不计入跨轮缺陷重发现统计（避免与首轮发现重复计数，防止 R_comp 等指标虚高）
  6. 最终 all disputes resolved（含 unresolved_dispute 已闭环）→ G1 恢复（原 5）
```

### 3.6 收敛判定：DUAL-GATE（v1.3 修订）

**G1/G2 定义继承自 v1.2 §收敛判定**（v1.3 R3 修订，修复 ATK-L-001）。

v1.3 仅标注 DUAL-GATE 修订而未展开 G1/G2 细则，二者完整定义以 v1.2 为准。简述（以 v1.2 为权威定义）：

- **G1（争议清单清空）**：所有 Arbiter 已裁决争议必须为空（attack_upheld / attack_dismissed / escalate_human 均为终态）+ 所有 pending_human 争议必须已解决（通过人工裁决 / retry / downgrade 转为终态）
- **G2（发现率收敛）**：连续 2 轮 D_k ≤ ε（新发现数低于阈值），且无新 BLOCKING 缺陷
- **G3（修复验证通过）**：Defender Accept 项的修复经 Prober 验证未引入回归
- **G4（Arbiter 一致率）**：双 Arbiter 一致率 ≥ 70%（分歧率 ≤ 30%）

> **DUAL-GATE 命名说明**（v1.3 R4 增补，修复 ATK-I-004）："DUAL-GATE"名称源于 v1.2 的 G1（争议清空）/G2（发现收敛）双轨收敛信号——二者构成停止协议的核心判定逻辑。v1.3 新增 G3（修复验证）/G4（Arbiter 一致）为交叉验证闸——G3 防止修复引入回归、G4 防止单一 Arbiter 误判。四闸按功能分为两组：**收敛组**（G1+G2，决定"何时停"）+ **验证组**（G3+G4，决定"停得对不对"）。协议名称保留"DUAL-GATE"以兼容 v1.2 生态，但四闸均须通过方可判定收敛。

#### 3.6.1 Prober 验证程序（G3 操作化定义）（v1.3 R4 增补，修复 ATK-Z-006）

G3 "Defender Accept 项的修复经 Prober 验证未引入回归"的操作化执行程序：

```
对每个 Defender Accept 项：
  1. 定位修复区域：以修复位置为中心，前后各扩展 3 个段落（或最近的小节边界）
  2. 重跑受影响维度的攻击 Prompt：从 Attack Log 中筛选与该修复区域相关的原始攻击维度，
     对修复后文档重新执行该维度的攻击 Prompt（仅限受影响维度，非全维度重跑）
  3. 产出判定：
     - PASS：修复区域内无任何维度判定边界 ✅ 级的新缺陷
     - FAIL：修复区域内发现 ≥1 个满足维度判定边界 ✅ 级的缺陷（即回归）
  4. FAIL 时，新缺陷自动加入 Attack Log（attack_id 标注 regression_from_{原始ATK-ID}），
     不计入 Attacker 当轮的每维 3 条限额
  5. Prober 输出：{accept_id, pass/fail, new_defects: [...], confidence}
```

Prober 的 **能力要求补充**（v1.3 R4 修订）：除"可靠度 ≥Attacker水平"外，Prober 须执行与 Attacker 相同的维度判定边界（§二）——即 Prober 必须能理解和应用六维 ✅/❌ 标准。若当前可用模型无法同时满足"可靠度"和"维度判定边界理解"，标注 `prober_capability_degraded`，G3 自动跳过（降级为仅 G1/G2/G4 判定）。

**v1.3 修订**：触发阈值的两阶段化（详见 §七 预期效果验证方案）。G1 在 v1.3 新增 pending_human 阻塞条件（双 Arbiter 分歧可能产生 escalate_human → pending_human 中间状态）。

**constant 场景分支**：
- G1 永不触发 → constant 场景 → 不追求统计收敛，终止于 §1.1 (a)/(b)/(c)
- G1 触发但 G2 不触发 → 继续下一轮（Attacker 可能有新发现）
- early_stop：MAX_ROUNDS = 5（非自指）/ 2（自指）。自指场景达到 2 轮后**触发终止路径评估**（咨询性信号，非强制收口）——Executor 收到此信号后必须在 §1.1 (a)/(b)/(c) 三种推荐终止形态中选择其一并显式记录选择，禁止以 early_stop 直接关闭审查。自指场景下 early_stop 的强制力归 §1.1 推荐终止形态所有，本身不再施加额外硬约束。（v1.3 R4 修订，修复 ATK-I-006）

**禁止过早总结 + 最少 2 轮硬约束**（v1.3 R5 新增，修复 P1-6）：

R1+R2 自指审查实证：Executor 在单轮结束后即生成"完成总结"关闭审查，绕过了双 Arbiter 交叉验证与多轮对抗。R5 起施加以下硬约束（与 §3.2 `executor_overreach_check` 互为补强——后者防"Executor 代产"，本节防"Executor 早退"）：

1. **最少 2 轮硬约束**：任一审查（自指或非自指）必须完成 **≥2 轮完整 Step 1–5** 才允许进入 Step 5 报告生成阶段；第 1 轮结束后**禁止**以"已无新发现""early_stop 信号""Defender 全盘 Accept""Attacker 报告 DIM_CLEAN"等理由单轮终止。自指场景下 MAX_ROUNDS=2 的 early_stop 与本约束方向一致（都要求 ≥2 轮），但本约束把"≥2 轮"提升为**独立硬约束**，不再依附于 early_stop 语义。
2. **early_stop 仅咨询性（强化重申）**：所有 early_stop 信号（含自指 MAX_ROUNDS=2 触发的终止路径评估、非自指 MAX_ROUNDS=5）**仅作为咨询性信号**，绝不构成单轮终止理由；其强制力归 §1.1 推荐终止形态（自指）或 DUAL-GATE G1+G2 收敛判定（非自指）所有。Executor 不得以"early_stop 已触发"为由跳过第 2 轮——这正是不被允许的单轮终止理由。
3. **报告生成前强制 `list_messages` 核验（`report_precheck`）**：Executor 在进入 Step 5（输出审查报告）前，必须对每个 Agent 子会话执行 `list_messages` 核验并记入 `report_precheck` 字段：
   - Attacker / Defender / Arbiter-A / Arbiter-B 子会话均有 **≥2 轮**的完整 `list_messages` 入库记录
   - 所有入库记录的 `doc_sha256_echo` 一致（无 `document_version_mismatch` 未闭环项）
   - `executor_overreach_check` 字段在 ≥2 轮中均为 `all_verified=true`
   - 核验结果记入 `report_precheck = {rounds_completed, sha256_consistent, overreach_check_all_verified, ready_to_report}`；任一项不满足 → **禁止生成报告**，回退至对应轮次补完
4. **与自指场景的兼容**：自指场景的推荐终止形态（§1.1 (a)/(b)/(c)）仍可在 ≥2 轮完成后被选择——本节不改变自指审查的终态选择权，仅强制"做选择之前必须先跑完 ≥2 轮"。

---

## 四、Prompt模板

（与 v1.2 相同，Attacker Prompt 增加维度判定边界引用）

---

## 五、降级模式

（与 v1.2 相同）

---

## 六、注意事项

（与 v1.2 相同，新增：）

9. **Attacker 轮换是 v1.3 的关键改进**：至少准备 2 个异构 Attacker 模型。若仅 1 个可用，标注 `attacker_rotation_degraded`，并在报告中说明。
10. **双 Arbiter 需要 2 个不同厂商模型**：如果仅有 1 个厂商可用（降级场景），双 Arbiter 退化为单 Arbiter，标注 `dual_arbiter_degraded`。

---

## 七、v1.3 变更日志 (2026-08-05 22:30 / 更新 23:00)

基于 v1.2 实证测试和 v1.2 多维度分析报告的三个未解决问题：

### v1.3 新增
- **[规则8]** Attacker 轮换：每 2 轮更换 Attacker 模型，防止注意力稀释（D.A.#5）
- **[§二]** 维度判定边界：每维补充 3–5 条 ✅/❌ 标准，解决可操作性鸿沟（D.A.#7）
- **[§3.5]** 双 Arbiter 交叉验证：两个异构 Arbiter 独立裁决，不一致时升级人工（D.A.#6）
- **[§3.2.1]** 子会话创建方式：强制使用 remote-session 而非 collaboration，确保可分配不同渠道模型
- **[§3.2.2]** 模型-角色分配规则：每个角色的首选/备选模型、关键能力要求、所属渠道

### 预期效果验证方案（v1.3 R3修订，替代 [待验证] 声称）

验证采用 v1.2 vs v1.3 配对 A/B 对照，**分两阶段、累计 ≥5 个文档样本**：

**可测量替代指标**（v1.3 R3 修订，补充定义和测量程序）：

1. **发现量比 R_comp**（替代完整性）：R_comp = D_k(v1.3) / D_k(v1.2)，其中 D_k 为第 k 轮 Attacker 发现数（不含 DIM_CLEAN 维度）。测量程序：对同一样本分别运行 v1.2 和 v1.3 管线，取各轮 D_k 的几何均值之比。目标 >1.0。
2. **Accept 正确率**（替代精确性）：独立评审者（未参与当前审查的异构模型）对随机抽取的 10 个 Defender Accept 项做 blind review，判定 Accept 是否确实修复了所声称的缺陷（True Accept Rate = 正确修复数 / 总 Accept 数）。目标 >80%。
3. **双 Arbiter 分歧率**（替代误判率）：分歧率 = 双 Arbiter 不一致裁决数 / 总争议数（不含 escalate_human 裁决）。测量程序：统计 Step 3 中 Arbiter-A 和 Arbiter-B 对同一条攻击的 verdict 不一致比例。目标 10–25%。
4. **成本比 C_ratio**（成本效率）：C_ratio = total_tokens(v1.3 全管线) / total_tokens(v1.2 全管线)。total_tokens = Executor + Attacker + Defender + Arbiter-A + Arbiter-B 的 input+output tokens 之和。目标 <1.20。

**两阶段发布标准（v1.3 R3 修订，修复 P1-2：n=3 探索性 vs 正式生效的歧义）：**

| 阶段 | 样本量 | 性质 | 通过条件 |
|------|:---:|------|---------|
| **阶段1 初通** | n=3 | **探索性**（conditional pass，**不正式生效**） | R_comp≥1.0(≥2/3 样本) ∧ Accept 正确率≥80% ∧ 分歧率∈[10%,25%] ∧ C_ratio<1.20 |
| **阶段2 复测确认** | +n=2（累计 n=5） | **正式生效**（publish-ready） | 阶段1 条件在累计 5 样本上重新成立 ∧ 无新 BLOCKING 缺陷 ∧ 阶段1→阶段2 R_comp 不退化（ΔR_comp > −0.1） |

**"不正式生效"语义边界**（v1.3 R3 修订，澄清 ATK-I-003）：
- "不正式生效"指阶段 1 的 DUAL-GATE 判定**仅作探索性信号**，不触发发布决策（publish-ready 判定）
- DUAL-GATE 在阶段 1 仍正常运行并产出判定（**有运行效力**：门禁被评估），但其结果**不做出发布放行决定**（**无发布效力**）
- 发布约束力仅在阶段 2 复测确认后生效

**阶段 1 初通验收标准**（v1.3 R3 修订，修复 ATK-G-002）：
- 3 次运行均完成完整 Step 0–5 管线，且无 Executor 层异常（子会话崩溃、消息丢失、模型拒绝响应等）
- 阶段 2 进入条件：阶段 1 的 DUAL-GATE 在 3 次运行中**至少 2 次**产出有效判定信号（G1/G2 可计算且未报错）
- 阶段 1→阶段 2 间必须有变更冻结期（≥24h），期间不对方法论做任何修改

⚠️ **n=3 的统计检验功效不足**（小样本下置信区间过宽、易受单个异常样本支配），阶段1 结果**仅作探索性参考，不可单独作为发布依据**。只有阶段2 累计 n=5 通过，才可解除 `draft-not-published` 状态。若阶段1 通过但阶段2 复测不通过，回退为 draft 并触发根因分析（不可仅凭阶段1 发布）。

### R2 修复 (2026-08-06)
⚠️ 此文件为草案（draft-not-published），v1.2 仍在批量测试中。本文件仅供内部自指审查测试。

### R3 修复 (2026-08-06，针对自指审查发现的 P0/P1)

**P0-1：规则8 在 3 家族场景失效（D.A.#5 未解决）**
- 问题：原规则8 仅定义硬轮换（跨家族），要求"与 A、B 都不同家族"。当前独立模型家族仅 3 个（DeepSeek/GLM/MiniMax），轮次 7+ 无第 4 家族可换，硬轮换中断；最常见的 3 家族场景下注意力稀释缓解实际未生效。
- 修复：引入两级轮换——硬轮换（3 家族 A→B→C 循环复用 + "已审过"声明）优先，**软轮换（同家族跨版本，如 DeepSeek V4 Pro ↔ V4 Flash GA）作降级补充**；新增 1/2 家族降级路径；报告中声明 `soft_rotation_active` 提示异构性减弱。

**P0-2：V4 Flash GA 禁令与软轮换的二阶回归实例**（注：此为可定位、可修复的具体回归实例，区别于 §1.1(2) 的结构性二阶回归限制）
- 问题：R1 禁令（Attacker-A=DeepSeek 时禁用 V4 Flash GA）本为防硬轮换"假异构"，但若延伸到软轮换，DeepSeek 族排除 V4 Flash GA 后仅剩 V4 Pro 1 个版本，不满足软轮换"≥2 同家族版本"，软轮换不可操作。
- 修复：明确**禁令作用域仅限硬轮换异构校验**，软轮换中 V4 Flash GA 可用作"同家族另一版本"；以作用域对照表（硬轮换 / 软轮换 / Arbiter-B）消除歧义。

**P1-1：自指适用性声明缺失**
- 问题：方法论可审查结构化文档、自身也是结构化文档，但全文未声明自指审查的结构限制（规则循环 / 二阶回归 / 收敛不可达）。
- 修复：新增 **§1.1 自指适用性声明**，列出 3 项结构限制 + 3 种推荐终止形态（外部独立审查 / ESCALATE_HUMAN 强制收口 / 版本快照冻结），并引用 v2 自指审查的 ESCALATE_HUMAN 实证先例。

**P1-2：n=3 发布标准与统计检验矛盾**
- 问题：发布标准允许 n≥3，但 n=3 统计检验功效不足、结果"仅作探索性"——使用者无法判断 n=3 通过是否正式生效。
- 修复：改为**两阶段发布**——阶段1 n=3 初通（探索性，conditional pass，不正式生效）+ 阶段2 +n=2 复测确认（累计 n=5，publish-ready）；阶段1→阶段2 须无新 BLOCKING 且 R_comp 不退化；仅阶段2 通过才解除 `draft-not-published`。

### R3 Round-1 自指审查追加修复 (2026-08-06，Defender Accept / Clarify 项)

本轮自指审查中，Defender (GLM-5.2) 对 18 条攻击的 Accept/Clarify 项修复已写入本文档：

- **ATK-I-001** → §1.1 增加 DUAL-GATE 适用范围说明（自指审查仅作咨询性信号）
- **ATK-I-002** → §1.1(b) 区分 ESCALATE_HUMAN 终态 vs `escalate_human` 单次事件
- **ATK-I-003** → §七 增加"不正式生效"语义边界（运行效力 vs 发布效力）
- **ATK-Z-001** → §3.4 增加 Refute 率事后强制机制（Executor 统计 + 越界处置）
- **ATK-Z-003** → 规则 8 增加降级模式显式覆盖说明
- **ATK-U-002 / ATK-G-003** → §3.2 增加 Executor 角色定义+审计+文档传递完整性约束
- **ATK-U-003** → §1.1(2) 与 R3 P0-2 区分结构性 vs 实例性二阶回归
- **ATK-L-001** → §3.6 增加 G1/G2 继承说明及简述
- **ATK-L-003** → §3.5 增加暂停状态恢复机制
- **ATK-L-002** → §3.5 增加 downgrade 语义定义 + retry/downgrade 选择条件
- **ATK-G-002** → §七 增加阶段 1 初通客观验收标准
- **ATK-F-002** → §二 维度权重表增加来源标注（v1.2 实验校准，n=12）
- **ATK-Z-002** → 分歧率指标保留，补充说明 n=5 时离散粒度限制（仅 20% 可达；阶段 2 使用 ±5% 容差区间）
- **ATK-U-001 / ATK-G-001** → §七 四指标补充定义和测量程序

**被 Refute 且经裁决维持的攻击（3 条）**：
- ATK-F-001（delta 草案作用域合理）
- ATK-I-002（经 Clarify 消歧后维持）
- ATK-Z-003（经 Clarify 消歧后维持）

**流程级修复（本轮自指审查最重要的发现）**：
- **Executor→Defender 文档传递完整性约束**写入 §3.2：Executor 必须传递完整原文，不可传压缩摘要；若截断须显式标注 `doc_truncated=true`；Defender 收到不完整文档时应拒绝 Refute 涉及被省略章节的攻击

**状态**：仍为 `draft-not-published`，不发布。本轮追加修复为 Defender 视角对自指审查产出的回应。原声明"已通过 Executor 基于原文证据的独立裁决验证（标注 `arbiter_degraded_remote_timeout`）"在 **v1.3 R5 后不再成立**——R5 判定该验证手段（Executor 降级裁决）正是 Executor 越界扮演 Arbiter 的入口，相关权限已废止（见 §3.2 角色隔离硬约束 / §3.2.1 L4 / §七 R5 P0-2/P0-3）。因此 R3 修复的闭环须重新依赖外部独立审查，本段原结论"待外部独立审查通过后方可解除 draft"在 R5 后反而更必要。待外部独立审查（§1.1 推荐终止形态 a）通过后方可解除 draft 状态。

### R4 修复 (2026-08-06，针对自指审查 Round 2 的 Defender Accept 项)

**Defender (GLM-5.2) 产出**: 13 Accept + 2 Refute（Refute 率 13.3%，在 5%–40% 约束区间内）。完整回应见 `.context/self-audit-r2.md` Addendum A。

**已内联应用的修复**（7 条）：

- **ATK-I-004** → §3.6：DUAL-GATE 命名说明（"收敛组 G1+G2" + "验证组 G3+G4"，名称保留以兼容 v1.2 生态）
- **ATK-I-005** → §3.2：Executor 禁止条款增加显式例外声明（L4 降级裁决为唯一例外 + 后续 Arbiter 复核要求）（⚠️ **v1.3 R5 已修订**：该"唯一例外"措辞在 R5 被判定为越界入口并废止，改为无条件禁止语句，见 §3.2 角色隔离硬约束 / §七 R5 P0-3）
- **ATK-I-006** → §3.6 early_stop 自指行（"触发终止路径评估"替代"强制收口"）+ §1.1 反向引用
- **ATK-Z-006** → §3.6.1 新增 Prober 验证程序操作化定义
- **ATK-U-004** → §3.2.2 可行性矩阵：T2 内联展开 + T1/T2 命名约定
- **ATK-U-006** → §3.2.1：ZLM/MiniMax/DeepSeek 渠道命名约定
- **ATK-L-006** → §3.5：恢复路径重新编号（4.c→5, 5→6）+ Chapman m₁₂ 引用改写为"跨轮缺陷重发现统计"

**已内联应用 + 需二次确认的修复**（1 条）：

- **ATK-U-005**（Chapman m₁₂）→ §3.5 恢复路径中的 Chapman 引用已改写为"跨轮缺陷重发现统计"。Defender 提出备选方案（保留 Chapman 并补充定义），由人工裁决选择其中一种

**待人工应用的修复**（Defender 已给出完整 fix 文案，因改动范围大需人工审核后应用）（5 条）：

- **ATK-Z-005**（软轮换版本不足降级）→ 规则8 软轮换末尾增补版本级降级路径：(a) ≥2 家族仍可硬轮换→回退硬轮换复用；(b) 仅剩 1 家族且单版本→标注 `single_model_no_rotation`
- **ATK-L-005**（1-family 降级门禁替代规则）→ §3.2.2 新增专节：异构性门禁标注 + 单 Arbiter 收紧 escalate 阈值 + G4 替代指标（Attacker 轮换内重发现率 <15%）+ 终止建议
- **ATK-G-004**（测量责任主体）→ §七 四指标末尾新增 Executor 负责 R_comp/C_ratio/分歧率统计、独立评审者负责 Accept 正确率
- **ATK-G-005**（变更冻结期验证）→ §七 阶段1→阶段2 增补 SHA-256 哈希验证 + freeze_record.json + git tag 建议
- **ATK-G-006**（G4 降级场景规则）→ §3.6 G4 后新增降级规则：2-family 用 Arbiter-A 跨轮一致性替代、1-family 标注不可用 + escalate 阈值收紧

**确认为误报的攻击**（Defender + 双 Arbiter 一致驳回）：
- ATK-Z-004（硬轮换"刻意避免视角"不可执行）

**Defender + Arbiter-A 一致驳回、Arbiter-B 维持的实质分歧**：
- ATK-L-004（暂停期间 escalate_human 事件出边）→ 已升级人工裁决（§1.1(b)）

**本轮新发现的方法论缺陷**（同前，未改变）：

**P0-3**（复合故障未覆盖）、**P1-3**（Arbiter 文档传递完整性）、**P1-4**（Defender 超长文档分片策略）→ 均已记录在 `.context/self-audit-r2.md`，由人工裁决是否纳入 v1.3 正式修复。

**本轮执行标注**：Defender 实际在 854s 后成功产出（非真正"超时失败"，而是 SDK 10min 窗口与模型处理耗时竞态），标注修正为 `defender_processing_slow_854s`。`arbiter_a_wrong_document_version`、`self_referential=true` 不变。

### R5 修复 (2026-08-06，针对 R2 自指审计观察员 GLM-5.2 的 P0/P1 强制修复)

**R2 观察员（GLM-5.2）评估结论**：R4 修复解决了 R2 Defender 的 Accept 项，但 R2 观察员独立指出 3 项 P0 + 3 项 P1 必须修复——核心顽疾是"Executor 越界扮演 Agent"在 R1+R2 两次自指审查中反复出现。根因诊断：§3.2 的"绝对禁止+唯一例外"措辞在复合故障压力下约束力不足，且 L4 单点故障应急通道授予的"Executor 降级裁决权限"成为越界入口。

**P0 修复（3 项，强制）**：

- **P0-1：Arbiter 输入管控（文档传递完整性扩展至 Arbiter）** → §3.5 双 Arbiter 机制新增"⚠️ Arbiter 输入管控"小节：强制 Arbiter Prompt 内联完整原文（不依赖"上文传递"）+ SHA-256 指纹核验 + `doc_sha256_echo` 字段 + `document_version_mismatch` 标注与 `tainted_by_version_mismatch` 处置。修复 R2 实证：Arbiter-A 自行查找文件系统定位到 v1.2.0 而非 v1.3，致 11/15 裁决基于错误版本（`arbiter_a_wrong_document_version`）。
- **P0-2：L1-L4 降级路径升级为 N-fault 模型** → §3.2.1 降级路径 L4 取消"Executor 基于原文执行降级裁决"权限（该权限成为 Executor 越界入口），改为 retry → ESCALATE_HUMAN；新增"N-fault 模型"小节：N≥2 角色同时故障立即触发 §1.1(b) ESCALATE_HUMAN，不尝试 Executor 补偿。覆盖 R4 记录但未修复的 P0-3（复合故障未覆盖）。
- **P0-3：强化角色隔离硬约束** → §3.2 Executor 角色定义的"禁止"条款从"绝对禁止+唯一例外"改为**无条件禁止语句**（取消所有例外）；新增"每轮结束前强制 Executor 越界自检"（`executor_overreach_check` 字段，per-round 核验 Attacker / Defender / Arbiter 产出均来自对应子会话 `list_messages`，任一 false 即 ESCALATE_HUMAN）。

**P1 修复（3 项，建议）**：

- **P1-4：Defender 超长文档分片** → 新增 §3.4.1：>15K token 文档按章节分片传递（每片携带 `doc_sha256` + `shard_id` + `shard_total` + `shard_range`）；区分 `defender_processing_slow`（partial flush / mtime 增长，继续等待）vs `defender_failed`（≥20min 无增长，计入 N-fault）；以 `list_messages` + mtime 双信号判定，不以 SDK "处理中"为依据。修复 R2 实证 854s 延迟下"超时 vs 处理中"无法区分。
- **P1-5：文档版本指纹** → §3.2.3 Step 0 强制生成 `doc_sha256` + 版本标识三元组 `{version, filename, mtime}`；所有 Agent 首次消息 Prompt 必须内联指纹供 Agent 自验，首轮响应须回显 `doc_sha256_echo`，不一致触发 `document_version_mismatch` 处置（重置子会话 + 重新内联）。与 P0-1 协同形成"指纹生成—内联传递—Agent 回显—Executor 核验"闭环。
- **P1-6：禁止过早总结 + 最少 2 轮硬约束** → §3.6 新增"禁止过早总结 + 最少 2 轮硬约束"小节：任一审查必须 ≥2 轮完整 Step 1–5；early_stop 仅咨询性，不得作为单轮终止理由；报告生成前强制 `list_messages` 核验（`report_precheck` 字段，含 rounds_completed / sha256_consistent / overreach_check_all_verified / ready_to_report）。修复 R1+R2 实证 Executor 单轮即生成"完成总结"。

**R5 引入的强制字段清单**（供 Executor 实现 / Arbiter 抽查）：

| 字段 | 位置 | 用途 |
|------|------|------|
| `doc_sha256` + `{version, filename, mtime}` | §3.2.3 Step 0 生成 | 文档版本指纹（P1-5） |
| `doc_sha256_echo` | 所有 Agent 首轮响应 | Agent 自验回显（P1-5 / P0-1） |
| `executor_overreach_check` | §3.2 每轮结束 | 防 Executor 代产（P0-3） |
| `report_precheck` | §3.6 报告生成前 | 防 Executor 早退（P1-6） |
| `document_version_mismatch` / `tainted_by_version_mismatch` | §3.5 Arbiter | 版本漂移处置（P0-1） |
| `defender_processing_slow` / `defender_failed` | §3.4.1 Defender | 状态二分（P1-4） |
| `n_fault_escalation` + 故障角色清单 | §3.2.1 N-fault 触发 | 复合故障终止（P0-2） |
| `arbiter_unavailable_remote_timeout` | §3.2.1 L4 | 替代 R4 的 `arbiter_degraded_remote_timeout`（P0-2） |

**与 R3/R4 的关系**：
- R3/R4 已将 P0-3（复合故障）、P1-3（Arbiter 文档传递）、P1-4（Defender 超长文档分片）记录为"待人工裁决是否纳入正式修复"——R5 在 R2 观察员强制要求下**正式纳入并实施**，从"待人工"转为"已修复"。
- R4 授予 L4 的 `arbiter_degraded_remote_timeout`（Executor 降级裁决）权限在 R5 **废止**，替换为 `arbiter_unavailable_remote_timeout`（语义从"已降级裁决"改为"不可达，待 ESCALATE"）。
- R4 标注的 `defender_processing_slow_854s` 在 R5 被 §3.4.1 的 `defender_processing_slow` / `defender_failed` 二分替代。

**自指适用性声明更新（§1.1 结构性限制自我套用）**：本轮 R5 修复本身是自指审查产物（用方法论审查方法论自身），受 §1.1 结构性限制约束——R5 修复可能引入新的二阶回归（示例：N-fault 阈值 N=2 是否在所有场景合理、分片阈值 15K token 是否普适于非 CJK 文档、`doc_sha256_echo` 缺字段时是拒绝还是降级处理）。按 §1.1(2)"结构性二阶回归不可消除，仅可通过对抗审查控制"原则，R5 修复的正确性须经 §1.1(a) 外部独立审查（异构、未参与 v1.3 设计的第三方 Agent 集合）确认，**不依赖本方法论的 DUAL-GATE 自指收敛判定**（§1.1 已声明自指场景 DUAL-GATE 仅作咨询性信号）。

**状态**：仍为 `draft-not-published`，不发布。R5 修复回应了 R2 观察员的全部 3 P0 + 3 P1，但 §1.1 推荐终止形态 (a) 外部独立审查尚未通过——按 P1-6 新增的"最少 2 轮硬约束"与 §1.1 自指终态规则，本轮自指审查须在外部独立审查或 ESCALATE_HUMAN 强制收口处终止，不以本方法论的 DUAL-GATE 自洽收敛为终止依据。

### R6 修复 (2026-08-06，针对 R5 自指审查 Round 1 的 BLOCKING 级 Defender Accept 项)

**R5 自指审查执行**：完整 2 轮 AC 管线（3 家族异构：Attacker=DeepSeek V4 Pro, Defender=GLM-5.2, Arbiter-A=MiniMax-M3, Arbiter-B=V4 Flash GA）。Round 1 发现 13 条攻击（2 BLOCKING），Round 2 发现 10 条攻击（2 BLOCKING）。详细报告见 `.context/self-audit-r5-convergence.md`。

**R6 已内联应用的修复（2 条 BLOCKING）**：

- **ATK-I-001（P0）** → §3.5 step 4.b downgrade 语义：将"Executor 基于原文证据独立裁决"替换为"unresolved_timeout 标记 + Executor 仅做事实性记录、不产出裁决"，与 §3.2 角色隔离硬约束一致。**已知遗留**：step 5 的 `unresolved_dispute` 标签未同步改为 `unresolved_timeout`（见 R7 候选）。
- **ATK-U-001（P0）** → §1.1(b) 终态触发条款：改写为单一解析措辞，消除"累计 ≥3 次触发'暂停'"的结构性歧义——明确暂停由 escalate_human 事件触发（非暂停事件自身累计），"连续 2 次暂停"指两次独立暂停事件。**已知遗留**："审查恢复"未显式交叉引用 §3.5 暂停恢复机制（见 R7 候选 ATK-U-005）。

**R6 引入的新缺陷（二阶回归实例，验证 §1.1(2) 结构性限制）**：
- **ATK-I-006**（MINOR）：R6 的 `unresolved_timeout` 与 step 5 `unresolved_dispute` 命名不一致
- **ATK-U-004**（MAJOR）：`unresolved_timeout` 术语未在文档任何位置定义
- **ATK-U-005**（MAJOR）：§1.1(b) R6 修订中"审查恢复"可读出 resume vs restart 两种执行路径

**R5 自指审查关键发现**：
- 23 条缺陷（4 BLOCKING, 15 MAJOR, 4 MINOR）——DUAL-GATE 在自指场景未收敛（G1/G2/G4 均未通过），验证 §1.1(3) "自指审查不应期待统计收敛"
- 双 Arbiter 分歧 1 条（ATK-I-005：§3.6 P1-6 最少 2 轮与 §3.2.1 N-fault 报告义务互斥）——已 escalate_human，待人工裁决
- R5 机制有效性：P0-1（Arbiter 输入管控✅）、P0-3（角色隔离✅）、P1-5（文档指纹✅）生效；P0-2（N-fault 与 P1-6 交互盲区⚠️）、P1-4（分片未触发—）
- 终止形态：§1.1(c) 版本快照冻结 + 建议 (a) 外部独立审查。P0 BLOCKING 待修复（ATK-I-004: §3.2 vs §3.4.1 doc_truncated 矛盾, ATK-G-004: G4 降级不可计算）
