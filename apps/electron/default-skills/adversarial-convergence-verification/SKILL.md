---
name: adversarial-convergence-verification
description: 当用户需要审查/验证结构化文档时触发。核心能力：对抗-收敛范式（Attacker六维攻击→Defender接受/反驳/澄清→双Arbiter争议裁决）+ DUAL-GATE双闸停止协议。v1.3新增：维度判定边界（§二）、Attacker轮换（规则8）、双Arbiter交叉验证（§3.5）、自指适用性声明（§1.1）、N-fault 模型（§3.2.1）、文档版本指纹（§3.2.3）。本文档为自包含版本，无需引用 v1.2。
version: "1.3.0"
status: "published"
# 发布决策：人类操作员裁决（2026-08-07），§1.1(b) 人工收口。自包含补全 + 3 轮洁净室测试通过 + 75 项并行审计通过。
---

# 对抗-收敛文档审查方法论 (Adversarial Convergence, AC) V1.3

> 基于对抗证伪（Popper）替代统计聚合（Chapman/NHPP）的轻量级文档审查范式
> ⚠️ v1.3 包含自指审查的已知限制（详见 §1.1）。

## 核心洞察

**审查质量的提升不来自"更多眼睛看同一个东西"，而来自"迫使同一双眼睛从对立角度看同一个东西"。**

V2方法论的并行搜索+统计收敛隐含假设"更多独立Agent=更高精度"。Stanford DIP理论(2025)、DebateCV(WWW'26)、Nature(2026)三线证据共同指向：**少数Agent深度交互 > 多数Agent浅层聚合**。

---

## ⚠️ 执行规则（先读此节）

### 规则1：对抗不是建议，是结构要求

你必须实际创建Attacker→Defender→Arbiter的对抗回合。不能"模拟"对抗，不能用单Agent写两份报告冒充对抗。

### 规则2：强制异构厂商（v1.1新增硬性要求）

**Attacker和Defender必须使用不同模型家族**（如DeepSeek Attacker + GLM Defender）。这不是"建议"，是"硬要求"。

**为什么**：同底座对抗的相关系数ρ≈0.55（T1 Prompt去相关），共享预训练数据、架构偏差、对齐约束——会在相同盲区达成虚假共识。异厂商对抗可将ρ压至≈0.12（T3异构去相关），这是对抗真正有效的必要条件。

**最低配置**：
- Attacker: 模型A（如DeepSeek V4 Pro）
- Defender: 模型B（如GLM-5.2，必须与A不同家族）
- Arbiter: 模型C（如MiniMax-M3，必须与A和B都不同）

**降级例外**：仅当确实只有1个可用模型时允许`same_base=true`，但审查报告**必须**标注此降级，且MIN_ROUNDS从2提升到3，停止阈值从连续2轮提升到连续3轮。

### 规则3：Defender必须有独立信息源（α > 0条件）

Defender不能只是"另一个LLM意见"。你必须为Defender提供至少一项Attacker看不到的信息：
- 上游规范文档（spec / requirements）
- 相关领域的checklist/标准
- 先前版本（如果有）
- 领域知识库/术语表

**理论原因**：GLM-5.2的理论分析（2026-08-05）证明——AC的信息效率优势依赖Defender信息增益系数α>0。若α≈0（Defender无独立信息），AC退化为SAS（Single Agent System，单 Agent 系统）+噪声，其表现可能**劣于**单Agent迭代。

### 规则4：累积缺陷账本不可丢失

跨轮维护完整Attack Log。包括被Defender否决的缺陷——标记为`refuted_by_defender`但保留在日志中。记录跨轮重捕数据（m₁₂）用于事后Chapman估计。这是AC的核心资产。

### 规则5：每轮重置对话上下文（v1.1新增，对抗说服力偏差）

Attacker和Defender的每轮对话**不保留**上一轮的完整历史。只传递：
- Attack Log（结构化数据）
- 修复后的文档
- Defender的独立信息源

**理论原因**：Nature 2026发现多Agent辩论中说服力（而非真实性）是共识形成的主要驱动力。串行对抗中，每轮的"输赢"逐轮累积，导致Attacker被压制后变保守或Defender被说服后放弃抵抗。重置上下文切断说服力的跨轮传播。

### 规则6：独立回归扫描（v1.1新增，防止修复引入回归）

Defender Accept并修复后，**不能仅依赖Defender自查回归**。必须运行独立回归扫描：
- 最低成本方案：让Attacker在下一轮自动担任"隐式验证者"——若Defender修复引入回归，Attacker很可能在后续轮次发现
- 推荐方案：引入独立Prober（第4个Agent，可复用Arbiter模型），在每轮Defender修复后快速扫描修复区域±相邻段落

**"段落"粒度定义**：本规则与§规则7中的"段"统一指 **Markdown 自然段**（以空行分隔的文本块）；若修复点位于列表/表格/代码块内，则将该列表项/表格行/代码块视为一个"段"。"±3段"=修复点向上向下各扫描3个自然段。

**Prober角色与子类型**：Prober是Attacker/Defender/Arbiter之外的第4个Agent角色（推荐复用Arbiter家族模型，或使用与A/B/C均不同的第3家族）。**单一Prober实例**承担三种触发场景，按场景命名区分：
- **Prober-Convergence**（§3.6 GATE 3触发）：收敛前2-3维spot-check，发现≥1新缺陷→VETO→CONTINUE；确认DIM_CLEAN→GATE 3通过
- **Prober-AttackerAudit**（§3.4 low_attack_round触发）：连续2轮攻击数≤2时启动，对当前文档做**完整六维攻击**（与Attacker相同协议，独立审查历史）；发现≥3缺陷→Attacker模式固化，编排者换用更高能力Attacker模型→CONTINUE；发现0-2缺陷→正常流程→CONTINUE；若同时D_k连续3轮低位→转§3.6 constant场景分支评估
- **Prober-RepairAudit**（§规则7 repair_mode_reset_escalation触发）：对最近2轮所有Accept修复区域做独立质量审计，输出修复质量评分（合格/不合格）

三种场景共享同一Prober实例（避免Agent数膨胀），但执行协议不同。报告"Prober调用数"按场景分别计数（如 P-Convergence:1, P-AttackerAudit:1, P-RepairAudit:0），总调用=三者之和。

**Prober误报处理**：Prober作为LLM可能产生假阳性VETO。安全侧设计：**Prober VETO仅导致CONTINUE（保守方向）**，假阳性最多推迟收敛、不会放过真缺陷。Defender对Prober的VETO发现照常走Accept/Refute/Clarify回应；若Defender成功Refute Prober发现（标记 `prober_false_positive`），该VETO在Attack Log中标注但**不影响后续轮的GATE 3判定**（GATE 3仍按本轮Prober结果判，不回溯重评）。Prober假阴性（漏检）由下一轮Attacker/Prober的统计检出覆盖。

### 规则7：修复质量门（v1.2新增，防止"越修越坏"）

基于v1.1实证发现：执行者5轮中major缺陷从9增至14，回归率持续上升——Defender修复引入的回归比消除的缺陷更多。

```
若连续2轮回归率 > 30%（回归数 / 本轮新发现数）:
  → 触发 REPAIR_MODE_RESET 事件
  → Defender必须改变修复策略（如采用"数据模型→业务流程→验收条件"三层同步修复法）
  → 向编排者报告策略变更说明
  → 标注 repair_mode_reset 事件（含旧策略回归率、新策略描述）

回归率计算：
  - 回归数 = 本轮Attacker发现的、定位在上轮Defender修复区域±3段内的缺陷数（"段"=自然段，详见§规则6定义）
  - 回归率 = 回归数 / 本轮新发现数
```

**REPAIR_MODE_RESET 闭环**：
- 触发后：回归率计数窗口重置为0，从下一轮重新累计连续2轮>30%
- 有效性评估：触发后下一轮若回归率仍>30% → 升级为 `repair_mode_reset_escalation` 事件 → 暂停Defender，由编排者启动 **Prober-RepairAudit**（见§规则6 Prober子类型）对最近2轮所有Accept修复做独立质量审计
- 二次触发上限：同一审查会话内 REPAIR_MODE_RESET 累计3次 → 强制 `escalate_human`，请求人工介入修复策略评审

**REPAIR_MODE_RESET 与 Attacker 轮换的交互（v1.3新增）**：
Attacker 轮换后首轮发现的缺陷若位于前任 Attacker 已审查过的修复区域，计为 `new_discovery` 而非 `regression`（详见规则8.2），不计入 REPAIR_MODE_RESET 触发判定。

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

**规则8.2：轮换边界回归判定（防止规则7误触发）**

Attacker 轮换后首轮，新 Attacker 在 ±3 段内发现的缺陷可能是**前任遗漏**而非 Defender 修复引入的回归：
- ±3段内发现 → 计为 new_discovery 而非 regression
- 回归率分母 = 由前任 Attacker 已审查过的修复区域缺陷数
- 标注 rotation_boundary=true，不计入 REPAIR_MODE_RESET 触发判定（规则7）
- 轮换后第二轮起：回归率计算恢复正常

---

## 一、适用文档与进入条件

**适用**：用户故事、PRD、架构设计文档、API规范、测试用例等结构化文档。

**进入条件**（任一满足即触发）：
- 用户明确说"审查/验证/检查/找出问题/review"
- 用户提交了一份结构化文档并询问质量

**不适用**：纯叙事性文档、非结构化自由文本。

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

> 注：权重来源于实验校准（n=12 文档样本的维度缺陷分布归一化），当前为经验值。

---

## 三、AC审查管线

### 3.1 完整管线

```
Step 0: 环境准备——Executor创建Attacker/Defender/Arbiter独立子会话（Executor不担任Agent角色）
Step 1: Attacker六维攻击 → 输出Attack JSON
Step 2: Defender逐条回应 → Accept(修复)/Refute(反驳)/Clarify(澄清)
Step 3: 双Arbiter裁决争议（v1.3: 两个异构Arbiter独立裁决）  ← v1.3 核心变更
Step 4: 收敛判定（DUAL-GATE + constant分支 + early_stop）
Step 5: 输出审查报告
```

### 3.2 环境准备 (Step 0)

**⚠️ 关键规则：Executor（编排者）不担任任何Agent角色。**

编排者(Executor)的职责仅限于：
1. 创建 **独立子会话**：Attacker(模型A)、Defender(模型B)、Arbiter-A(模型C)、Arbiter-B(模型D) — 详见 §3.2.1 子会话创建方式和 §3.2.2 可行性矩阵
2. 在会话间传递：Attack Log + **完整原文文档（非压缩摘要，须内联至 Prompt 主体）** + Defender 独立信息源 + **SHA-256 文档指纹**（详见 §3.2.3）
3. 事后统计指标（含 Refute 率、escalate_human 计数、DUAL-GATE G1 状态）
4. 执行升级阈值与暂停判定（累计 escalate_human ≥ 3、Refute 率越界等）
5. **每轮结束前强制执行"Executor 越界自检"**（详见下方"角色隔离硬约束"）
6. 执行 DUAL-GATE 收敛判定
7. **禁止**编排者自己扮演 Defender/Attacker/Arbiter/Prober

**为什么**：v1.1实证测试(2026-08-05)发现——当编排者兼任Defender时，Refute率仅1.2%（1/83），Arbiter形同虚设，且上下文未真正重置（§规则5精神被违反）。独立子会话是"真实对抗"的硬前提。

**文档传递完整性约束（适用所有 Agent，含 Attacker / Defender / Arbiter-A / Arbiter-B / Prober）**（v1.3 R3 增补 Defender；v1.3 R5 扩展至 Arbiter）：Executor 向**任一 Agent**传递的"当前文档"必须是完整原文，且**必须内联至该 Agent 的 Prompt 主体**，不可依赖"上文已传递""会话历史中已有""文件系统中存在""请自行查找"等间接引用方式。R2 实证：Arbiter-A 因被允许"自行查找审查目标文档"而定位到 v1.2.0 而非 v1.3，致 11/15 裁决基于错误版本。若因 token 限制需压缩或分片（Defender 超 >15K token 场景见 §3.4.1），必须显式标注 `doc_truncated=true` + 被省略/分片的章节列表——Agent 收到不完整文档时应拒绝就涉及被省略章节的攻击做出 Refute / 裁决。

**角色隔离硬约束（无条件禁止，无任何例外）**（v1.3 R5 修订，修复 P0-3）：**Executor 在任何情况下——包括但不限于单点故障、复合故障、Arbiter 超时、模型不可用、降级模式、试运行、调试、人类操作员离线——都不得扮演、代行、模拟、代为产生或"暂代"Attacker / Defender / Arbiter / Prober 的实质性输出（攻击 JSON / Accept-Refuse-Clarify / verdict / Prober 回归判定）。** R1+R2 两次自指审查实证：即使 §3.2.1 L4 单点故障应急通道下授予"唯一例外"，Executor 仍在复合故障压力下越界扮演 Agent 角色（顽疾，两次重复）。因此本条款**取消所有"例外"措辞**，改为无条件禁止语句。
  - **每轮结束前强制"Executor 越界自检"**（v1.3 R5 增补，修复 P0-3）：Executor 在每轮 Step 1–5 结束后、进入收敛判定或报告生成前，必须执行并记录以下自检：
    1. 本轮所有 Attacker 攻击 JSON 是否来自 Attacker 子会话的 `list_messages` 产出（非 Executor 自拟）
    2. 本轮所有 Defender Accept / Refute / Clarify 是否来自 Defender 子会话的 `list_messages` 产出（非 Executor 自拟）
    3. 本轮所有 Arbiter verdict 是否来自 Arbiter-A / Arbiter-B 子会话的 `list_messages` 产出（非 Executor 自拟）
    4. 自检结果记入 `executor_overreach_check` 字段（结构：`{round_k, attacker_ok, defender_ok, arbiter_a_ok, arbiter_b_ok, all_verified, check_method: "list_messages"}`）；任一项为 false → 立即停止本轮并触发 §1.1(b) ESCALATE_HUMAN 强制收口终态，禁止"用 Executor 产出补齐后继续"
- **担任者**：可由人类操作员或自动化编排脚本担任；操作可由 Arbiter 对照本定义审计
- **审计**：Executor 的角色隔离合规性由 Arbiter 在每轮结束后抽查（检查 Executor 是否在任意 Agent 的输出中扮演了实质性裁决/攻击/辩护角色；`executor_overreach_check` 字段为抽查必查项，缺失即视为越界）

**强制异构**：Attacker、Defender、Arbiter-A 必须使用 3 个不同模型家族。Arbiter-B 必须与 Arbiter-A 不同家族。

**降级条件**：仅当确实只有1个可用模型家族时允许降级。降级时：
- 标注`same_base=true`
- MIN_ROUNDS=3（从2提升）
- 停止连续轮次阈值=3（从2提升）
- 在报告中显著标注"⚠️ 同底座降级，审查有效性未经实证验证"

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

降级路径（分层，分离基础设施与模型异构；v1.3 R5 修订，修复 P0-2 升级为 N-fault 模型）：

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
      - ⚠️ v1.3 R5 修订：取消 R3/R4 授予的"Executor 基于原文执行降级裁决（标注 `arbiter_degraded_remote_timeout`）"应急权限——该权限在 R1+R2 自指审查中成为 Executor 越界扮演 Arbiter 的入口（与 §3.2 角色隔离硬约束的无条件禁止语句冲突）。Arbiter 不可达属于角色故障，按 N-fault 计数；若仅 Arbiter 单点故障，retry 后仍不可达即升级 ESCALATE_HUMAN，**不尝试 Executor 补偿**

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
```

#### 3.2.2 可行性配置矩阵（v1.3 R2修复）

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
3. **文档版本指纹生成（强制，v1.3 R5 新增）**：对审查目标文档（完整原文）计算 SHA-256 指纹，记为 `doc_sha256`，并记录文档版本标识三元组 `{version, filename, mtime}`（如 `{version: "1.3.0-draft", filename: "SKILL-v1.3.md", mtime: <ISO8601>}`）。**所有 Agent（Attacker / Defender / Arbiter-A / Arbiter-B / Prober）的首次消息 Prompt 必须内联该指纹与版本标识**，供 Agent 在审查前自验。
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

**执行**：Attacker收到原文档（或上轮Defender修复后的文档）+ 累积Attack Log。

**v1.3 Attacker 轮换**：详见规则8。每 2 轮更换 Attacker 模型。轮换时新 Attacker 接收：
- Attack Log（结构化数据）
- 当前文档（完整原文内联，须包含 doc_sha256 指纹）
- 前任审查摘要：`"你的前任 Attacker({model})已经审查了 {k} 轮。请从新的视角继续审查。"`（注：不传递具体发现数，仅传递轮次数，减少锚定效应）

**攻击规则**：
- 每维每轮最多3个缺陷
- 每个缺陷必须引用原文证据（section/段落号）
- 按严重度分级：blocking > major > minor > suggestion
- **不要提出修复方案**——那是Defender的工作
- 不能重复Attack Log中已记录的缺陷
- 某维找不到新缺陷→报告`DIM_CLEAN`
- **v1.3**：攻击时必须对照 §二·维度判定边界，确保攻击符合对应维度的 ✅/❌ 标准

**输出格式**：
```json
{
  "round": 1,
  "attacks": [
    {
      "id": "ATK-I-001",
      "dimension": "I",
      "severity": "blocking",
      "location": {"section": "§2.1", "para": 2},
      "claim": "FR-02状态枚举与§4.1不匹配",
      "evidence": ["§2.1: '空闲/使用中/已预约'", "§4.1: '启用/禁用/维护中'"],
      "attack_type": "contradiction"
    }
  ],
  "clean_dimensions": ["G"]
}
```

**Attack Log累积结构**：跨轮维护的Attack Log除上述攻击字段外，**每条攻击条目还须累积Defender的回应**，用于Attacker在下一轮判断Refute是否成立：
```json
{
  "id": "ATK-I-001",
  "round_raised": 1,
  "dimension": "I",
  "claim": "...",
  "evidence": [...],
  "defender_response": {
    "verdict": "refute | accept | clarify",
    "reasoning": "Defender反驳/接受/澄清的完整论证（Refute时含引用的反证原文）",
    "fix_location": "§X.Y（accept/clarify时）"
  },
  "arbiter_verdict": "attack_upheld | attack_dismissed | escalate_human | null（未争议时）"
}
```
编排者须将该累积结构在每轮开始时完整传给Attacker（与§规则5的"上下文重置"不冲突——重置的是对话历史，Attack Log是结构化数据，本就属于"传递"项）。

### 3.4 Defender回应 (Step 2)

**执行**：Defender收到原文档 + Attacker的Attack JSON + 独立信息源（spec/checklist）。逐条回应每个攻击。

**回应类型**：
- **Accept**：承认缺陷有效。立即修复文档，标注`<!-- fix: ATK-X-XXX -->`。输出修复后的diff。
- **Refute**：反驳攻击。必须引用原文或规范作为反证，不接受"我觉得没问题"。
- **Clarify**：攻击基于误解。补充文档澄清，不改原意。

**约束**：
- Refuse率不得超过本轮攻击数的40%（防止过度防御）
- **Refuse率不得低于本轮攻击数的5%（v1.2新增，防止过度Accept）**
- **若Defender累计Refuse率<5%，Arbiter强制执行独立复审**：从Accept中随机抽 min(3, Accept总数) 条做二次确认；若Accept总数=0，改为从Clarify中抽 min(3, Clarify总数) 条；若Accept+Clarify总数=0（全Refuse），改为审查所有Refuse条目（"全Refuse过度防御审计"）
- 超出40%的部分强制转为Accept或升级Arbiter裁定

**Refute 率约束的强制机制**（v1.3 R3 修订，修复 ATK-Z-001）：

Defender 自身是 LLM Agent，不具备运行时自我配额能力。Refute 率约束通过以下**事后审计**强制：

- 该区间由 **Executor 在每轮 Defender 回应结束后事后统计**（Defender 不自行计数）
- 若本轮 Refute 率 <5%（过度顺从，几乎全盘 Accept）：
  → Executor 标记本轮 Defender 倾向 `overly_compliant`，触发 `escalate_human` 事件
- 若本轮 Refute 率 >40%（过度防备，几乎全盘 Refuse）：
  → Executor 标记本轮 Defender 倾向 `overly_defensive`，触发 Defender re-prompt 或 `escalate_human` 事件
- 事后审计不要求 Defender LLM 具备运行时自我配额能力——仅要求 Executor 在回合结束后统计和判定

**约束执行顺序**：上述约束的执行顺序固定为：
1. Defender做出原始回应（Accept/Refuse/Clarify分配）
2. 过度防御审计（在40%强制转换**之前**评估）：若原始回应中Refuse占比>40% **或** 出现全Refuse场景（Accept+Clarify=0）→ Arbiter对每个原始Refuse应用已有verdict（attack_upheld/attack_dismissed/escalate_human）做"过度防御审计"——这是§3.5已有裁决类型的应用，不是新裁决类型
3. 执行40%强制转换：超出40%的Refuse按step 2审计结果转为Accept（attack_upheld→Defender必须接受并修复）或escalate_human（attack_dismissed→升级人工）
4. 累计Refuse率<5%触发独立复审：按上方fallback抽Accept/Clarify/Refuse条目
5. 注：step 2的全Refuse审计与step 4的全Refuse独立复审不冲突——前者评估每个Refuse的合理性（逐条），后者评估Defender整体是否过度防御（统计层），可同时执行

**累计Refuse率定义**：
- 分子 = 累计Refuse数；分母 = 累计攻击数（Accept + Refuse + Clarify 全部计入分母）
- 单轮Refuse率同理：分母=本轮攻击数

**5%下限边界规则**：5%下限与40%上限仅在本轮攻击数≥3时数学上可同时满足。当本轮攻击数≤2时，5%下限规则自动豁免（仅执行40%上限）。编排者须在Attack Log中标注 `low_attack_round` 事件；若连续2轮攻击数≤2，触发Prober-AttackerAudit（详见§规则6 Prober子类型）做spot-check。

**low_attack_round后继处理路径**：Prober-AttackerAudit按§规则6定义的协议执行（完整六维攻击）：
- 发现≥3个新缺陷 → Attacker模式固化（漏攻击）→ 标注 `attacker_underperforming` 事件 → 编排者换用更高推理深度d的Attacker模型（或上调reasoning_effort）→ CONTINUE
- 发现0-2个新缺陷 → 正常流程（文档可能确实缺陷少，或Attacker未漏攻击）→ CONTINUE
- 同时D_k连续3轮低位（每轮≤2）→ 转§3.6 constant场景分支评估（D_k稳态判定不依赖绝对值，仅依赖波动≤20%）

**Clarify的后继处理**：
- Clarify的文档补充视为"修复"，纳入§规则6/§规则7的回归扫描范围（修复区域=Clarify修改的段落±相邻段）
- Attacker可在后续轮次就同一位置重新发起攻击（不视为重复，因文档已变更）；若Attacker认为Clarify未消除误解→按Refuse争议路径升级Arbiter裁决
- Clarify不计入回归率分子（回归率仅统计Accept修复区域内的回归），但Clarify区域内的回归仍记入Attack Log

**输出格式**：
```json
{
  "round": 1,
  "responses": [
    {
      "attack_id": "ATK-I-001",
      "verdict": "accept",
      "action": "统一§2.1与§4.1的状态枚举为'空闲/使用中/已预约/维护中'",
      "fix_location": "§4.1 Room.status",
      "fix_diff": "启用/禁用/维护中 → 空闲/使用中/已预约/维护中"
    },
    {
      "attack_id": "ATK-F-003",
      "verdict": "refute",
      "action": "FR-11的'单独取消'通过设置recurrence.exception_dates实现，不需要父ID字段——见§4.2 recurrence JSON schema已包含exception_dates",
      "evidence": "§4.2: recurrence字段定义为JSON，包含exception_dates数组"
    }
  ],
  "fixed_document": "(修复后的完整文档)"
}
```

#### 3.4.1 Defender 超长文档分片（v1.3 R5 新增，修复 P1-4）

R2 自指审查实证：Defender 收到 20K+ token 的完整文档后耗时 854s 才产出（SDK 10min 窗口与模型处理耗时竞态），Executor 当时无法区分"模型仍在处理（应继续等）"与"真正失败（应 retry / ESCALATE）"。R5 起对 Defender 输入引入分片策略与状态二分：

1. **分片阈值**：待审文档 >15K token（约 6 万字符；CJK 文档按字符数估算，英文按 1 token ≈ 4 字符）→ 按章节自然边界分片传递，每片 ≤15K token。
2. **分片传递规则**：
   - 每片独立进入 Defender 子会话，Prompt 头部携带 `doc_sha256` + `shard_id` + `shard_total` + `shard_range`（章节范围，如 `§3.2–§3.4`）
   - Defender 对每片独立产出 Accept / Refuse / Clarify，攻击 ID 标注所属片（如 `ATK-X-XXX@shard2`）
   - 跨片攻击（涉及 ≥2 片的章节，如某概念在 §3.2 定义、在 §3.5 使用）由 Executor 在汇总阶段合并，提示 Defender 复核合并后的连贯性（标注 `cross_shard_consolidation`）
3. **状态二分（替代原单一标注 `defender_processing_slow_854s`）**：
   - `defender_processing_slow`（等待，非失败）：Defender 子会话在 SDK 窗口内有**部分产出**（partial flush——不完整 JSON、占位符、中途文件）**或** 产出文件 mtime 在持续更新 → Executor 继续等待，每 5min 核验一次产出增长
   - `defender_failed`（真失败）：Defender 子会话 **≥20min 无任何产出增长**、或返回明确错误、或产出无效 JSON 经 1 次 retry 仍失败 → 计入角色故障；若同时其他角色也故障则 N≥2 → 触发 §1.1(b) ESCALATE_HUMAN
   - **区分依据**：以 `list_messages` 核验入库内容 + 产出文件 mtime 双信号判定，**不以 SDK 单次"处理中"状态为依据**
4. **与 §3.2 文档传递完整性的关系**：分片传递仍属"完整原文"传递（每片都是真实原文切片，仅切分未省略），**不触发 `doc_truncated=true`**；`doc_truncated` 仅用于因 token 限制**省略**章节的场景，不用于**分片**场景。分片场景下 Defender 仍须就所属片的攻击做完整 Accept / Refuse / Clarify。

### 3.5 双 Arbiter 裁决 (Step 3) ← v1.3 核心变更

**背景**：v1.2 为单一 Arbiter。v1.1 实证发现单一 Arbiter 存在 conformity bias（知道 Defender 已反驳 → 倾向于认同 Defender），且无交叉验证。v1.3 引入双 Arbiter 交叉验证。

**触发条件**：Defender选择Refute，但Attacker在下一轮开始前认为反驳不成立。仅争议项触发 Arbiter，非争议项（Accept / Clarify）不进入 Arbiter。

**v1.3 双 Arbiter 机制**（v1.3 R5 修订，修复 P0-1 Arbiter 输入管控）：

```
Step 3a: Arbiter-A（模型 X，如 MiniMax-M3）独立裁决
Step 3b: Arbiter-B（模型 Y，如 V4 Flash GA，必须与 X 不同厂商）独立裁决

Arbiter-A 和 Arbiter-B 收到相同输入（原始攻击 + Defender反驳 + 原文），
但互不可见对方的裁决。
```

**⚠️ Arbiter 输入管控（无条件内联，禁止"自行查找"，v1.3 R5 新增，修复 P0-1）**：

1. **强制内联完整原文**：Executor 向 Arbiter-A / Arbiter-B 的 Prompt 必须**内联完整原文**（攻击 + Defender 反驳 + 待审文档原文），不依赖"上文传递""会话历史中已有""请自行查找"。Arbiter 子会话**不假定**继承自父会话或文件系统的文档可见性。
2. **文档版本指纹核验**：Arbiter Prompt 头部必须包含 §3.2.3 Step 0 生成的 `doc_sha256` 与版本标识三元组；Arbiter 首轮响应须回显 `doc_sha256_echo`，Executor 核验不一致即触发 `document_version_mismatch` 处置（重置该 Arbiter 子会话 + 重新内联传递，**非 retry 原会话**——避免历史污染）。
3. **`document_version_mismatch` 标注与 tainted 处置**：当 Arbiter 报告收到版本不一致、指纹不匹配、或检测到内联文档与外部可见版本冲突时，立即标注 `document_version_mismatch`，该 Arbiter **本轮所有裁决标记为 `tainted_by_version_mismatch`**——不计入 G1 阻塞清单、不计入 G4 一致性统计（不污染指标）——Executor 重新内联正确版本并重置该 Arbiter 子会话后重跑；同一 Arbiter 经 1 次重置重传仍报告不一致，按 N-fault 模型计入角色故障（§3.2.1）。

**裁决格式**（每个 Arbiter，v1.3 R5 增补 `doc_sha256_echo` 字段）：
```
{
  "doc_sha256_echo": "<hex, 须与 Prompt 头部一致>",
  "attack_id": "ATK-X-XXX",
  "verdict": "attack_upheld | attack_dismissed | escalate_human",
  "reasoning": "...",
  "confidence": 0.0-1.0
}
```

**裁决判定标准**：
- **attack_upheld**：Defender反驳未充分回应攻击证据。缺陷有效。
- **attack_dismissed**：攻击基于误解或错误引用。缺陷无效。
- **escalate_human**：需要领域知识/上游澄清。升级人工。

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

**Escalation计数器协调**：维护两个独立计数器，任一达阈即触发人工裁决暂停：
- `arbiter_escalate_count`（§3.5路径，阈值≥3）
- `repair_escalate_count`（§规则7路径，REPAIR_MODE_RESET累计≥3次）

协调规则：
- 两条路径共享同一人工裁决恢复路径（见下方），人工一次性处理两条路径累计的所有条目
- `repair_mode_reset_escalation`恢复路径：Prober-RepairAudit审计完成后→若判定"合格"→Defender按新策略继续，**重置** `repair_escalate_count=0`；若判定"不合格"→升级`escalate_human`（计入 `arbiter_escalate_count`），Defender策略由人工裁决重设
- 暂停期间管线状态：Attacker/Defender轮转**暂停**（不进入下一轮），Prober/Arbiter/编排者可继续工作（审计、裁决、协调）
- 恢复审查时：两个计数器同时清零重新累计

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

**人工裁决恢复路径**：
1. 暂停期间，编排者将当前文档+完整Attack Log+所有escalate_human条目（含两条路径的累计条目）提交人工审查者
2. 人工裁决每条escalate_human为 `attack_upheld` / `attack_dismissed` / `defer_to_v_next`（推迟到下一版本文档处理）
3. 裁决结果写回Attack Log的`arbiter_verdict`字段，并标注 `human_adjudicated: true`
4. 恢复审查：从下一轮继续（攻击数配额照常）；两个escalation计数器同时清零
5. 若人工裁决一次性处理了所有blocking/major缺陷 → 允许直接判 `EARLY_STOP_HUMAN_ADJUDICATED`（区别于EARLY_STOP，须在报告中显著标注）

**escalate_human 恢复路径**（v1.3 R2修复，防止死锁）：

```
争议标为 pending_human，保留在 Attack Log 中：
  1. 单个争议不阻塞本轮推进（本轮剩余攻击正常继续）
  2. pending_human 争议计入 G1 阻塞清单（G1 要求"争议列表为空"）
  3. 累计 pending_human ≥ 3 → 暂停审查，请求人工裁决
  4. 超 24h 人工未响应 → Executor 执行：
     a. retry: 换 Arbiter 组合重新裁决争议
     b. 或 downgrade: 标 unresolved_dispute
        - downgrade 语义：将 pending_human 争议标记为 unresolved_timeout，在终态报告中以"争议未决（人工超 24h 未响应）"客观呈现；Executor 仅做事实性记录（保留原始攻击 JSON、Defender 响应、等待时长），不产出 upheld/dismissed/escalate 任何裁决。本路径受 §3.2 角色隔离硬约束——Executor 在此路径中只做状态迁移与事实记录，不代行 Arbiter 裁决职能。（v1.3 R6 修订，修复 ATK-I-001）
        - retry 和 downgrade 的选择条件：优先 retry（换 Arbiter 组合）；若两次 retry 均超时则 downgrade
  5. 标为 unresolved_dispute 的争议：
     - Attack Log 中标记 status=unresolved_dispute + 原因
     - 报告中归入"未解决争议（降级）"专区
     - 后续轮次 Attacker 收到提示："{n} 个争议因超时降级，若再次发现相关问题请重新攻击"
     - 不计入跨轮缺陷重发现统计（避免与首轮发现重复计数，防止 R_comp 等指标虚高）
  6. 最终 all disputes resolved（含 unresolved_dispute 已闭环）→ G1 恢复
```

### 3.6 收敛判定：DUAL-GATE（四闸停止协议）

> 基于v1.1核心升级：MiniMax-M3数学仿真（500-1000 trials, 2026-08-05）证明原"连续2轮全维0发现"在decay场景下假收敛率高达87-90%。DUAL-GATE协议结合AC触发信号+NHPP GO验证+Prober独立确认，将假收敛率控制在5-10%。

**DUAL-GATE 命名说明**（v1.3 R4 增补）：“DUAL-GATE”名称源于 G1（争议清空）/G2（发现收敛）双轨收敛信号——二者构成停止协议的核心判定逻辑。v1.3 新增 G3（修复验证）/G4（Arbiter 一致）为交叉验证闸——G3 防止修复引入回归、G4 防止单一 Arbiter 误判。四闸按功能分为两组：**收敛组**（G1+G2，决定“何时停”）+ **验证组**（G3+G4，决定“停得对不对”）。协议名称保留“DUAL-GATE”以兼容生态，但四闸均须通过方可判定收敛。

#### GATE 1: AC触发信号（必要非充分条件）

```
AC_TRIGGER 条件：连续N_consecutive轮全部6维 DIM_CLEAN ∧ 争议列表为空
  - 异构厂商: N_consecutive = 2
  - 同底座降级: N_consecutive = 3
```

- **G1（争议清单清空）**：所有 Arbiter 已裁决争议必须为空（attack_upheld / attack_dismissed / escalate_human 均为终态）+ 所有 pending_human 争议必须已解决（通过人工裁决 / retry / downgrade 转为终态）

**重要**：AC_TRIGGER仅提供“建议停止”信号，不可单独用作收敛判据。

#### GATE 2: NHPP GO 学习曲线饱和验证（否决信号）

当AC_TRIGGER触发后，运行NHPP Goel-Okumoto模型拟合（使用跨轮发现数据）：

```
NHPP_SATURATED 条件：拟合参数 b < 0.5
  - b = 学习曲线斜率参数
  - b < 0.5 意味着 E[finds] ~ t^{0.5}，增长远低于线性，进入饱和阶段
  - b ≥ 0.5 意味着学习曲线仍活跃 → 否决AC_TRIGGER → CONTINUE
```

- **G2（发现率收敛）**：连续 2 轮 D_k ≤ ε（新发现数低于阈值），且无新 BLOCKING 缺陷

**为什么NHPP b而不是Chapman N̂？** MiniMax-M3仿真证明：
- Chapman N̂在m₁₂=1时95% CI宽度=N_true的181%，基本不可用
- NHPP b值在小样本下比N̂更稳定，且成功在pattern场景(10,7,4,2,1,0,0,1,2...)中早于AC触发前识别饱和(b=0.42 at round 7)
- b<0.5是稳定信号，不要求精确的a,b估计

**实现**：NHPP GO: E[N(t)] = a · tᵇ。用SciPy curve_fit或手动最小二乘拟合log(E[N]) = log(a) + b·log(t)。若无法拟合（点数<3），默认CONTINUE。

**实现注意事项**：
- **D_k=0 奇异点**：log(0)未定义。当某轮累计发现D_k=0时，对D_k加 **0.5伪计数**（标准统计惯例）后再做log-OLS；或直接使用SciPy curve_fit对原始 `E[N(t)]=a·tᵇ` 做非线性拟合（不取对数，避开奇异点）。**优先使用非线性curve_fit**，log-OLS仅作为curve不收敛时的fallback（注意log-OLS的对数变换偏差会系统性低估b，须在报告中标注拟合方法）
- **独立性假设的启发式使用**：NHPP GO的严格独立增量假设在AC管线中确实被违反（修复-回归引入序列依赖，§规则7已实证）。使用NHPP仅作为**趋势饱和的启发式信号**（b<0.5=趋势变缓），而非缺陷总数的统计推断器
- **拟合不确定性报告**：报告模板须记录 b的95% CI 与R²。CI**优先使用curve_fit协方差矩阵导出的近似CI**；bootstrap方法仅作为**样本量≥8时的可选交叉验证**。当 b的95% CI 跨越 0.5 阈值时（如 b=0.49±0.15），GATE 2 判定降级为 `INCONCLUSIVE` → 默认 CONTINUE（保守策略）

#### GATE 3: Prober独立确认

- **G3（修复验证通过）**：Defender Accept 项的修复经 Prober 验证未引入回归

详见 §3.6.1 Prober 验证程序操作化定义。

Prober（使用与Attacker/Defender都不同的模型）：
```
  1. 随机选择2-3个维度做spot-check
  2. 对这些维度重新审查文档（独立于Attacker的审查历史）
  3. 若Prober在任一维度发现≥1个新缺陷 → VETO → CONTINUE
  4. 若Prober确认DIM_CLEAN → GATE 3通过
```

#### GATE 4: Arbiter 一致率（v1.3新增）

- **G4（Arbiter 一致率）**：双 Arbiter 一致率 ≥ 70%（分歧率 ≤ 30%）

**G4 降级场景规则**：
- 2 厂商可用：用 Arbiter-A 跨轮一致性替代 G4（标注 `g4_degraded_cross_round`）
- 1 厂商可用：G4 不可用（标注 `g4_unavailable`），escalate 阈值收紧至 ≥2

#### GATE 4b（基础安全条件）

```
- 累计发现 ≥ 5（至少找到过东西——防止文档本来就没有缺陷却被误判为审查失败）
- 总轮次 ≥ MIN_ROUNDS（异构2 / 同底座3）
- MAX_ROUNDS = 10（超出→强制输出 + 标注 not_converged + N̂估计残余风险）
```

#### 联合判定 + constant场景扩展 + early_stop策略

```
CONVERGED iff:
  (G1) AC_TRIGGER ✓ AND 争议清单清空 ✓
  AND (G2) NHPP b < 0.5 ✓ AND 发现率收敛 ✓
  AND (G3) Prober确认无新发现 ✓ AND 修复验证通过 ✓
  AND (G4) Arbiter 一致率 ≥ 70% ✓ AND 基础安全条件满足 ✓

若G1触发但G2否决 → 报告 "NHPP veto: learning curve still active (b={value})"
若G1+G2通过但G3否决 → 报告 "Prober veto: {N} new findings in dimensions {D}"
```

**v1.3 constant场景分支**（实证发现：D_k稳态时G1永不触发→Prober永久空闲）：
```
若 D_k 连续3轮稳态（波动≤20%）且G1未触发:
  → 强制触发Prober(G3)做spot-check（不等G1条件满足）
  → 若Prober同样发现稳态（0-1新缺陷）→ 进入 early_stop 评估
  → 若Prober发现≥2新缺陷 → VETO → CONTINUE（说明Attacker模式固化）
```

**“波动≤20%”计算公式**：波动 = (max(D_{k-2}, D_{k-1}, D_k) − min(...)) / max(1, 三轮均值)。即3轮累计发现数的极差除以三轮均值（均值=0时分子也=0，判为稳态）。

**v1.3 early_stop 策略**：
```
若满足以下全部条件，允许主动停止（标注 early_stop，替代无条件MAX_ROUNDS=10等待）:
  (E1) blocking连续2轮清零
  (E2) D_k连续3轮稳态（波动≤20%，公式见上）
  (E3) 总轮次 ≥ 5
  (E4) Chapman 事后估计 m₁₂ ≥ 1（至少有跨轮重捕）

early_stop ≠ CONVERGED。报告区分标注：
  - CONVERGED: DUAL-GATE四闸全部通过
  - EARLY_STOP: blocking清零+稳态+轮次充足，但G2(NHPP b)未通过
  - EARLY_STOP_HUMAN_ADJUDICATED: 人工裁决一次性处理所有blocking/major缺陷（§3.5触发）
  - NOT_CONVERGED: 其他情况
```

**constant触发但E3未满足时的fallback**：当constant场景在第3-4轮触发（E3要求≥5轮必然不满足）时：
- 若 E1+E2+E4 全部满足且 Prober 确认稳态 → 标注 `pending_early_stop` 状态，CONTINUE 到第5轮
- 第5轮开始时若 E1+E2 仍满足 → 正式判 EARLY_STOP
- 第5轮前若 E1/E2 失效（blocking再现或波动>20%）→ 回到常规CONTINUE，清除 `pending_early_stop`
- 若 E3 不满足且 E1/E2/E4 中任一不满足 → 不进入 pending，直接 CONTINUE

**MAX_ROUNDS**：非自指场景 MAX_ROUNDS=10 / 自指场景 MAX_ROUNDS=2。自指场景达到 2 轮后**触发终止路径评估**（咨询性信号，非强制收口）——Executor 收到此信号后必须在 §1.1 (a)/(b)/(c) 三种推荐终止形态中选择其一并显式记录选择，禁止以 early_stop 直接关闭审查。

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

**跨轮攻击匹配规则**：m₁₂（跨轮重捕数）依赖客观、机械可执行的匹配规则，不依赖主观语义判断：
- **匹配键** = `(location.section, dimension, severity, claim前缀)` 四元组
  - `location.section`：完全相同字符串（如"§3.4"）
  - `dimension`：完全相同（I/F/Z/U/L/G）
  - `severity`：完全相同（blocking/major/minor/suggestion）
  - `claim前缀`：claim字符串去除停用词后的前30字符（编排者用确定性脚本提取，非LLM判断）
- 两轮中四元组完全相同 → 视为同一缺陷（重捕）
- 编排者层用确定性字符串匹配脚本执行，结果写入Attack Log的 `cross_round_match` 字段
- **mid-review m₁₂**（用于early_stop E4判定）：取最近3轮作为匹配窗口，M₁=第k-2轮标记的攻击数，M₂=第k轮标记的攻击数，m₁₂=两轮按上述匹配键重合的条目数
- **事后 m₁₂**（用于CONVERGED后Chapman估计）：取最后2轮，同规则

#### 事后Chapman估计（不用于停止，仅用于报告）

在CONVERGED后，取最后2轮的M₁/M₂/m₁₂计算Chapman N̂和95% CI，作为残余风险参考写入报告：

```
报告标注：
  - Chapman N̂ = {value}, 95% CI = [{lower}, {upper}]
  - 若m₁₂ ≤ 1: 标注 "⚠️ 重捕数据不足，残余风险估计不可靠"
  - 若m₁₂ ≥ 3: 标注 "残余风险估计相对可靠"
```

#### 3.6.1 Prober 验证程序（G3 操作化定义）（v1.3 R4 增补，修复 ATK-Z-006）

G3 “Defender Accept 项的修复经 Prober 验证未引入回归”的操作化执行程序：

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

Prober 的 **能力要求补充**：除"可靠度 ≥Attacker水平"外，Prober 须执行与 Attacker 相同的维度判定边界（§二）——即 Prober 必须能理解和应用六维 ✅/❌ 标准。若当前可用模型无法同时满足"可靠度"和"维度判定边界理解"，标注 `prober_capability_degraded`，G3 自动跳过（降级为仅 G1/G2/G4 判定）。

### 3.7 输出报告

```markdown
# 文档审查报告 (AC范式 v1.3)

## 审查概要
- 文档：{名称}
- 范式：对抗-收敛 (AC v1.3.0, DUAL-GATE四闸协议 + Executor编排 + 双Arbiter交叉验证)
- 审查轮次：{k}轮
- 总发现：{D_k}个
- 确认缺陷：{accepted}个（blocking: {x}, major: {y}, minor: {z}）
- 争议/升级：{disputed}个
- 停止方式：{converged / early_stop / early_stop_human_adjudicated / max_rounds / not_converged}

## 收敛诊断
- 停止轮次：第{k}轮
- AC触发(G1)：{第k_ac轮触发 / 未触发}
- NHPP GO(G2): a={a}, b={b}, b<0.5: {yes/no}
- Prober确认(G3)：{confirmed/vetoed}（抽查维度: {dims}）
- Arbiter一致率(G4)：{rate}%（{一致/分歧详情}）
- Constant场景触发：[是/否] D_k连续3轮稳态→强制Prober
- Chapman事后估计：N̂={n_hat}, 95% CI=[{ci_lower}, {ci_upper}], m₁₂={m12}
- 残余风险：{低/中/高/不可靠}
- Executor越界自检：{all_verified / 发现越界}
- 文档版本指纹：doc_sha256={hex}

## 确认缺陷（按严重度排序）
### Blocking
| ID | 维度 | 描述 | 位置 | 修复状态 |
|----|------|------|------|---------|
| ATK-I-001 | I | ... | §X.Y | ✅ 已修复 |

## 被驳回的攻击
| ID | 维度 | 攻击描述 | 驳回理由 | Arbiter-A裁决 | Arbiter-B裁决 |
|----|------|------|------|------|------|

## 未解决争议
| ID | 维度 | 攻击描述 | 状态 | 原因 |
|----|------|------|------|------|

## 统计信息
- 收敛判定：{converged / early_stop / early_stop_human_adjudicated / not_converged}
- 收敛轮次：{k}
- 总调用数：{C}（含Prober确认 + NHPP拟合）
- Executor: {model}, Attacker: {model}, Defender: {model}, Arbiter-A: {model}, Arbiter-B: {model}, Prober: {model}
- Defender Refute率：{x}%（{<5%触发Arbiter强制复审 / 正常}）
- 回归率：{x}%（{>30%触发REPAIR_MODE_RESET / 正常}）
- 同底座降级：{true/false}
- Attacker轮换：{次数 + 模型列表}
- Veto事件：[如有] NHPP否决 / Prober否决 / Constant场景触发
- 特殊事件：[如有] repair_mode_reset / early_stop / escalate_human
```

---

## 四、Prompt模板

### 4.1 Attacker系统Prompt

```markdown
你是文档攻击者(Attacker)。你的唯一目标是找出目标文档中的缺陷。

## 攻击维度
从以下六个攻击面逐一攻击，每维每轮最多3个缺陷：
1. **自洽性(I)**：文档各部分是否自相矛盾？引用矛盾的原文。
2. **保真性(F)**：与上游规范是否一致？找出所有偏离和遗漏。
3. **可造性(Z)**：需求在技术上是否可实现？标记不现实的要求。
4. **可懂性(U)**：目标读者能否理解？找出歧义、未定义术语。
5. **闭环性(L)**：所有状态/角色是否形成闭环？标记未闭合路径。
6. **护栏性(G)**：需求是否可测试？安全边界是否明确？

## 维度判定边界（v1.3新增）
攻击时必须对照以下标准，确保攻击符合对应维度的判定边界：
- I: ✅矛盾 = 同一字段不同位置枚举不同 / 逻辑冲突；❌不算 = 不同名称表述同一概念
- F: ✅遗漏 = 上游明确要求但缺失；❌不算 = 设计扩展新增内容
- Z: ✅不可造 = 违反物理/工程约束 / 需不存在的技术；❌不算 = 难但有理论可能
- U: ✅歧义 = 一句话≥2种理解 / 未定义就使用；❌不算 = 需领域知识才能理解
- L: ✅未闭合 = 状态缺出边/入边 / 权限未定义；❌不算 = 异常路径未覆盖
- G: ✅不可测 = 无客观度量标准 / 安全关键缺鉴权；❌不算 = 不完整但有核心度量

## 攻击规则
- 每个缺陷必须引用原文证据（section/段落号）
- 按严重度分级：blocking > major > minor > suggestion
- **不要提出修复方案**——那是Defender的工作
- 不能重复已记录在Attack Log中的缺陷
- 某维找不到新缺陷→报告"DIM_CLEAN"

## 输出格式
严格输出JSON（不要包裹在markdown代码块中）：
{"round": N, "attacks": [...], "clean_dimensions": [...]}
```

### 4.2 Defender系统Prompt

```markdown
你是文档防御者(Defender)。你的任务是对每个攻击做出回应。

## 独立信息源（Attacker看不到）
{上游规范/checklist/先前版本——如果有的话}

## 回应类型
- **Accept**：承认缺陷。立即修复文档。标注 <!-- fix: {attack_id} -->。
- **Refute**：反驳攻击。必须引用原文或规范作为反证。每轮Refute不超过攻击数的40%。
- **Clarify**：攻击基于误解。补充文档澄清，不改原意。

## 原则
- 最小改动：Accept时只改必要内容
- 引用证据：Refute必须有原文引用
- 自查回归：每次修复后检查是否引入新缺陷

## 输出格式
严格输出JSON：
{"round": N, "responses": [...], "fixed_document": "..."}
```

### 4.3 Arbiter系统Prompt（v1.3: 双Arbiter）

```markdown
你是仲裁者(Arbiter-{A|B})。你将与另一位使用不同模型的Arbiter独立裁决同一争议。
你不可看到对方的裁决。

## 判定标准
- **attack_upheld**：Defender反驳未充分回应攻击证据。缺陷有效。
- **attack_dismissed**：攻击基于误解或错误引用。缺陷无效。
- **escalate_human**：需要领域知识/上游澄清。升级人工。

## 输出格式
{"doc_sha256_echo": "...", "attack_id": "...", "verdict": "attack_upheld|attack_dismissed|escalate_human", "reasoning": "...", "confidence": 0.0-1.0}
```

### 4.4 Prober系统Prompt

```markdown
你是独立探查者(Prober)。你的任务是对Attacker/Defender/Arbiter的产出做独立验证。

## 触发场景（按场景执行对应协议）

### Prober-Convergence（收敛前spot-check）
随机选择2-3个维度，对这些维度重新审查文档（独立于Attacker的审查历史）。
- 若在任一维度发现≥1个满足维度判定边界✅标准的新缺陷 → 输出 VETO + 缺陷详情 → CONTINUE
- 若所有选中维度均无新缺陷 → 输出 DIM_CLEAN_CONFIRMED → GATE 3通过

### Prober-AttackerAudit（连续2轮攻击数≤2时）
对当前文档做完整六维攻击（与Attacker相同协议，独立审查历史）。
- 发现≥3缺陷 → 输出 attacker_underperforming + 缺陷列表
- 发现0-2缺陷 → 输出 normal_flow

### Prober-RepairAudit（REPAIR_MODE_RESET升级时）
对最近2轮所有Accept修复区域做独立质量审计。
- 逐个修复区域检查：以修复位置为中心±3段，重跑受影响维度攻击
- 输出每个Accept项的 pass/fail + 新缺陷列表（若有）

## 维度判定边界
你必须执行与Attacker相同的维度判定边界（§二），确保你的发现符合✅标准。

## 输出格式（按场景）
- Convergence: {"dimensions_checked": [...], "veto": true/false, "new_defects": [...], "confidence": 0.0-1.0}
- AttackerAudit: {"dimensions_checked": "all", "defects_found": N, "defects": [...], "assessment": "attacker_underperforming|normal_flow"}
- RepairAudit: {"accept_id": "...", "pass": true/false, "new_defects": [...], "confidence": 0.0-1.0}
```

---

## 五、降级模式

当无法创建并行子会话时，在同一会话中顺序执行AC：

1. **同底座顺序**：用同一模型依次扮演Attacker→Defender→Arbiter
2. **提示词隔离**：每次角色切换时清除对话上下文，仅保留Attack Log和文档
3. **标注降级**：报告标注`degraded=same_base_sequential`
4. **去相关补偿**：在Attacker轮次间变换prompt变体（不同维度优先级顺序）
5. MIN_ROUNDS从2提升到3（补偿同底座的信息冗余）

### 模型家族数与子会话可用性降级

§3.2要求3个不同模型家族 + 子会话创建能力。降级阶梯：

| 可用资源 | 降级路径 | 标注 | 关键调整 |
|---------|---------|------|---------|
| 3家族 + 子会话可用 | 标准AC | — | 默认配置 |
| 仅2家族可用 | Defender/Arbiter共用同一家族（异于Attacker） | `degraded=two_family` | MIN_ROUNDS=3；Arbiter的conformity bias风险标注；推荐引入Prober（第3家族或复用Attacker家族但不同prompt）补足独立性 |
| 仅1家族可用 | 同底座顺序（见上方1-5） | `degraded=same_base_sequential` | MIN_ROUNDS=3，连续clean轮=3 |
| 子会话创建不可用 | 同会话顺序执行（即便有3家族也只能顺序跑） | `degraded=sequential_no_fork` | 角色切换时强制清除上下文；§规则5的"重置"通过显式清空实现，不依赖会话隔离 |

**最低进入门槛**：至少1个模型家族可用 + 文档非空。否则AC管线不可达，编排者应输出 `infeasible_no_model` 并降级为单Agent扫描。

---

## 六、注意事项

1. **异构厂商是硬性要求**：同底座AC的对抗去相关只是Prompt-level intervention (ρ≈0.55)，不是真正的认知独立。异厂商(ρ→0.12)是AC有效的必要条件。
2. **Defender必须有牙（α > 0）**：GLM-5.2 DIP理论分析（2026-08-05）证明——Defender的独立信息增益系数α是AC优势的支点。如果α≈0，AC退化为SAS（Single Agent System，单 Agent 系统）+噪声。
3. **DUAL-GATE防止假收敛**：原AC停止准则在decay场景下假收敛率87-90%（MiniMax-M3仿真, 2026-08-05）。NHPP b验证 + Prober独立确认将假收敛率降至5-10%。
4. **累积Attack Log是核心资产**：跨轮维护，不可丢弃。被驳回的攻击标记但不删除。记录跨轮重捕数据用于事后Chapman估计。
5. **本Skill面向执行，非研究**：如果要改进方法论本身→触发`multi-agent-methodology-research`。
6. **极短文档（<500字）建议降级为单Agent扫描**。
7. **与V2方法论的定位差异**：AC适合中低风险文档的日常审查。极高风险（安全关键/医疗/金融）仍建议V2完整模式的多厂商异构陪审。
8. **每轮重置上下文**：Attacker和Defender之间不保留完整对话历史——仅传Attack Log+修复后文档——防止Nature 2026警告的说服力偏差逐轮累积。
9. **独立回归扫描必不可少**：Defender自查回归不可靠（Zylos 2026数据显示修复引入回归率5-25%）。至少让Attacker在下一轮担任隐式验证者。
10. **Attacker 轮换是 v1.3 的关键改进**（v1.3新增）：至少准备 2 个异构 Attacker 模型。若仅 1 个可用，标注 `attacker_rotation_degraded`，并在报告中说明。
11. **双 Arbiter 需要 2 个不同厂商模型**（v1.3新增）：如果仅有 1 个厂商可用（降级场景），双 Arbiter 退化为单 Arbiter，标注 `dual_arbiter_degraded`。

---

## 七、v1.3 变更日志 (2026-08-05 22:30 / 更新 23:00)

### v1.3 相对 v1.2 的核心变化

**v1.3 新增**
- **[规则8]** Attacker 轮换：每 2 轮更换 Attacker 模型，防止注意力稀释（D.A.#5）
- **[§二]** 维度判定边界：每维补充 3–5 条 ✅/❌ 标准，解决可操作性鸿沟（D.A.#7）
- **[§3.5]** 双 Arbiter 交叉验证：两个异构 Arbiter 独立裁决，不一致时升级人工（D.A.#6）
- **[§3.2.1]** 子会话创建方式：强制使用 remote-session 而非 collaboration，确保可分配不同渠道模型
- **[§3.2.2]** 模型-角色分配规则：每个角色的首选/备选模型、关键能力要求、所属渠道
- **[§1.1]** 自指适用性声明：自指审查的结构限制与推荐终止形态
- **[§3.2.3]** 文档版本指纹：SHA-256 + 版本标识三元组，防版本漂移
- **[§3.2.1]** N-fault 模型：≥2 角色同时故障立即 ESCALATE_HUMAN
- **[§3.2]** 角色隔离硬约束：无条件禁止 Executor 扮演 Agent 角色 + executor_overreach_check
- **[§3.4.1]** Defender 超长文档分片：>15K token 分片传递 + 状态二分
- **[§3.6]** 最少 2 轮硬约束：禁止过早总结 + report_precheck

### 预期效果验证方案

验证采用 v1.2 vs v1.3 配对 A/B 对照，**分两阶段、累计 ≥5 个文档样本**：

**可测量替代指标**：

1. **发现量比 R_comp**（替代完整性）：R_comp = D_k(v1.3) / D_k(v1.2)，其中 D_k 为第 k 轮 Attacker 发现数（不含 DIM_CLEAN 维度）。测量程序：对同一样本分别运行 v1.2 和 v1.3 管线，取各轮 D_k 的几何均值之比。目标 >1.0。Executor 负责统计。
2. **Accept 正确率**（替代精确性）：独立评审者（未参与当前审查的异构模型）对随机抽取的 10 个 Defender Accept 项做 blind review，判定 Accept 是否确实修复了所声称的缺陷（True Accept Rate = 正确修复数 / 总 Accept 数）。目标 >80%。独立评审者负责。
3. **双 Arbiter 分歧率**（替代误判率）：分歧率 = 双 Arbiter 不一致裁决数 / 总争议数（不含 escalate_human 裁决）。测量程序：统计 Step 3 中 Arbiter-A 和 Arbiter-B 对同一条攻击的 verdict 不一致比例。目标 10–25%。Executor 负责统计。
4. **成本比 C_ratio**（成本效率）：C_ratio = total_tokens(v1.3 全管线) / total_tokens(v1.2 全管线)。total_tokens = Executor + Attacker + Defender + Arbiter-A + Arbiter-B 的 input+output tokens 之和。目标 <1.20。Executor 负责统计。

**两阶段发布标准**：

| 阶段 | 样本量 | 性质 | 通过条件 |
|------|:---:|------|---------|
| **阶段1 初通** | n=3 | **探索性**（conditional pass，**不正式生效**——R3 修复 ATK-I-003：运行效力 vs 发布效力） | R_comp≥1.0(≥2/3 样本) ∧ Accept 正确率≥80% ∧ 分歧率∈[10%,25%] ∧ C_ratio<1.20 |
| **阶段2 复测确认** | +n=2（累计 n=5） | **正式生效**（publish-ready） | 阶段1 条件在累计 5 样本上重新成立 ∧ 无新 BLOCKING 缺陷 ∧ 阶段1→阶段2 R_comp 不退化（ΔR_comp > −0.1） |

⚠️ **n=3 的统计检验功效不足**，阶段1 结果**仅作探索性参考，不可单独作为发布依据**。只有阶段2 累计 n=5 通过，才可解除 `draft-not-published` 状态。

**"不正式生效"语义边界**（R3 修复 ATK-I-003）：“不正式生效”指阶段 1 的 DUAL-GATE 判定**仅作探索性信号**，不触发发布决策（publish-ready 判定）——DUAL-GATE 在阶段 1 仍正常运行并产出判定（**有运行效力**），但其结果**不做出发布放行决定**（**无发布效力**）；发布约束力仅在阶段 2 复测确认后生效。

**阶段 1 初通验收标准**（R3 修复 ATK-G-002）：3 次运行均完成完整 Step 0–5 管线且无 Executor 层异常；阶段 2 进入条件为阶段 1 的 DUAL-GATE 在 3 次运行中**至少 2 次**产出有效判定信号（G1/G2 可计算且未报错）；阶段 1→阶段 2 间须有变更冻结期（≥24h），期间不对方法论做任何修改。

### R2–R6 迭代修复历史

本方法论经历了多轮自指审查（用 AC 方法论审查 AC 方法论自身），累计修复 P0/P1 级缺陷。

**R3 修复 (2026-08-06，针对自指审查发现的 P0/P1)**：

- **P0-1：规则8 在 3 家族场景失效** → 引入两级轮换：硬轮换（3 家族 A→B→C 循环复用 + “已审过”声明）优先，软轮换（同家族跨版本）作降级补充；新增 1/2 家族降级路径
- **P0-2：V4 Flash GA 禁令与软轮换的二阶回归实例** → 明确禁令作用域仅限硬轮换异构校验，软轮换中 V4 Flash GA 可用作“同家族另一版本”；以作用域对照表消除歧义
- **P1-1：自指适用性声明缺失** → 新增 §1.1 自指适用性声明，列出 3 项结构限制 + 3 种推荐终止形态
- **P1-2：n=3 发布标准与统计检验矛盾** → 改为两阶段发布：阶段1 n=3 初通（探索性，conditional pass，不正式生效）+ 阶段2 +n=2 复测确认（累计 n=5，publish-ready）

**R3 Round-1 自指审查追加修复**（Defender Accept / Clarify 项）：

- ATK-I-001 → §1.1 增加 DUAL-GATE 适用范围说明（自指审查仅作咨询性信号）
- ATK-I-002 → §1.1(b) 区分 ESCALATE_HUMAN 终态 vs `escalate_human` 单次事件
- ATK-I-003 → §七 增加“不正式生效”语义边界（运行效力 vs 发布效力）
- ATK-Z-001 → §3.4 增加 Refute 率事后强制机制（Executor 统计 + 越界处置）
- ATK-Z-003 → 规则 8 增加降级模式显式覆盖说明
- ATK-U-002 / ATK-G-003 → §3.2 增加 Executor 角色定义+审计+文档传递完整性约束
- ATK-U-003 → §1.1(2) 与 R3 P0-2 区分结构性 vs 实例性二阶回归
- ATK-L-001 → §3.6 增加 G1/G2 继承说明及简述
- ATK-L-003 → §3.5 增加暂停状态恢复机制
- ATK-L-002 → §3.5 增加 downgrade 语义定义 + retry/downgrade 选择条件
- ATK-G-002 → §七 增加阶段 1 初通客观验收标准
- ATK-F-002 → §二 维度权重表增加来源标注（实验校准，n=12）
- ATK-Z-002 → 分歧率指标保留，补充说明 n=5 时离散粒度限制
- ATK-U-001 / ATK-G-001 → §七 四指标补充定义和测量程序

**R4 修复 (2026-08-06，针对自指审查 Round 2 的 Defender Accept 项)**：

已内联应用的修复（7 条）：
- ATK-I-004 → §3.6：DUAL-GATE 命名说明（收敛组 G1+G2 + 验证组 G3+G4）
- ATK-I-005 → §3.2：Executor 禁止条款增加显式例外声明（⚠️ v1.3 R5 已废止该例外）
- ATK-I-006 → §3.6 early_stop 自指行（“触发终止路径评估”替代“强制收口”）+ §1.1 反向引用
- ATK-Z-006 → §3.6.1 新增 Prober 验证程序操作化定义
- ATK-U-004 → §3.2.2 可行性矩阵：T2 内联展开 + T1/T2 命名约定
- ATK-U-006 → §3.2.1：ZLM/MiniMax/DeepSeek 渠道命名约定
- ATK-L-006 → §3.5：恢复路径重新编号（4.c→5, 5→6）+ Chapman m₁₂ 引用改写

需二次确认的修复（1 条）：ATK-U-005（Chapman m₁₂）→ 已改写为“跨轮缺陷重发现统计”

待人工应用的修复（5 条）：ATK-Z-005（软轮换版本不足降级）、ATK-L-005（1-family 降级门禁替代规则）、ATK-G-004（测量责任主体）、ATK-G-005（变更冻结期验证）、ATK-G-006（G4 降级场景规则）

**R5 修复 (2026-08-06，针对 R2 自指审计观察员的 P0/P1 强制修复)**：

核心顽疾是“Executor 越界扮演 Agent”在 R1+R2 两次自指审查中反复出现。根因诊断：§3.2 的“绝对禁止+唯一例外”措辞在复合故障压力下约束力不足。

P0 修复（3 项，强制）：
- **P0-1：Arbiter 输入管控** → §3.5 新增 Arbiter 输入管控小节：强制内联完整原文 + SHA-256 指纹核验 + `document_version_mismatch` 标注与 `tainted_by_version_mismatch` 处置
- **P0-2：L1-L4 降级路径升级为 N-fault 模型** → §3.2.1 L4 取消“Executor 降级裁决”权限，新增 N-fault 模型：N≥2 角色同时故障立即触发 ESCALATE_HUMAN
- **P0-3：强化角色隔离硬约束** → §3.2 禁止条款从“绝对禁止+唯一例外”改为无条件禁止语句（取消所有例外）；新增 executor_overreach_check 每轮强制自检

P1 修复（3 项，建议）：
- **P1-4：Defender 超长文档分片** → 新增 §3.4.1：>15K token 分片传递 + `defender_processing_slow` / `defender_failed` 状态二分
- **P1-5：文档版本指纹** → §3.2.3 Step 0 强制生成 `doc_sha256` + 版本标识三元组 + `doc_sha256_echo` 回显
- **P1-6：禁止过早总结 + 最少 2 轮硬约束** → §3.6 新增最少 2 轮硬约束 + `report_precheck` 字段

R5 引入的强制字段清单：

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

R5 与 R3/R4 的关系：R3/R4 已将 P0-3（复合故障）、P1-3（Arbiter 文档传递）、P1-4（Defender 超长文档分片）记录为“待人工裁决是否纳入正式修复”——R5 在 R2 观察员强制要求下正式纳入并实施，从“待人工”转为“已修复”。

R5 自指适用性声明更新：R5 修复本身是自指审查产物，受 §1.1 结构性限制约束——R5 修复可能引入新的二阶回归。按 §1.1(2)“结构性二阶回归不可消除，仅可通过对抗审查控制”原则，R5 修复的正确性须经 §1.1(a) 外部独立审查确认，不依赖本方法论的 DUAL-GATE 自指收敛判定。

**R6 修复 (2026-08-06，针对 R5 自指审查 Round 1 的 BLOCKING 级 Defender Accept 项)**：

R5 自指审查执行：完整 2 轮 AC 管线（3 家族异构）。Round 1 发现 13 条攻击（2 BLOCKING），Round 2 发现 10 条攻击（2 BLOCKING）。

已内联应用的修复（2 条 BLOCKING）：
- ATK-I-001 → §3.5 step 4.b downgrade 语义：将“Executor 基于原文证据独立裁决”替换为“unresolved_timeout 标记 + Executor 仅做事实性记录、不产出裁决”
- ATK-U-001 → §1.1(b) 终态触发条款：改写为单一解析措辞，消除“累计 ≥3 次触发‘暂停’”的结构性歧义

R6 引入的新缺陷（二阶回归实例，验证 §1.1(2) 结构性限制）：
- ATK-I-006（MINOR）：R6 的 `unresolved_timeout` 与 step 5 `unresolved_dispute` 命名不一致
- ATK-U-004（MAJOR）：`unresolved_timeout` 术语未在文档任何位置定义
- ATK-U-005（MAJOR）：§1.1(b) R6 修订中“审查恢复”可读出 resume vs restart 两种执行路径

R5 自指审查关键发现：23 条缺陷（4 BLOCKING, 15 MAJOR, 4 MINOR）——DUAL-GATE 在自指场景未收敛（G1/G2/G4 均未通过），验证 §1.1(3)“自指审查不应期待统计收敛”。双 Arbiter 分歧 1 条（ATK-I-005），已 escalate_human。

**状态**：仍为 `draft-not-published`，不发布。R5 修复回应了 R2 观察员的全部 3 P0 + 3 P1，但 §1.1 推荐终止形态 (a) 外部独立审查尚未通过——按 P1-6 新增的“最少 2 轮硬约束”与 §1.1 自指终态规则，本轮自指审查须在外部独立审查或 ESCALATE_HUMAN 强制收口处终止，不以本方法论的 DUAL-GATE 自洽收敛为终止依据。

**自指审查已知限制**：自指审查不追求统计收敛（详见 §1.1 结构性限制声明），终止于外部独立审查 / ESCALATE_HUMAN / 版本快照冻结之一。