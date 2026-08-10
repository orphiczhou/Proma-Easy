---
name: structured-doc-multi-agent-verification-v2
description: 当用户需要审查/验证结构化文档（用户故事、PRD、架构设计、API规范、测试用例等）时触发。触发信号："审查这份文档"、"验证用户故事"、"检查PRD质量"、"review这个spec"、"文档质量审查"、"用多Agent审查"、"找出文档中的所有问题"、"这个设计文档有什么问题"。核心能力：六维审查（I自洽/F保真/Z可造/U可懂/L闭环/G护栏）+ 三层架构（L1分工搜→L2陪审确证→L3机械聚合）+ 双轨统计收敛（Chapman捕-再捕+NHPP MLE）+ 三级去相关（T1/T2/T3）+ 成本感知最优停止。优先保证错误发现率，同时兼顾审查效率。⚠️ 本Skill需要完整加载SKILL.md才能正确执行。仅使用描述中的维度名称不足以构成有效审查。如果无法加载完整Skill，请显式注明降级。
version: "2.5.3"
---

> **v2.5.3 变更（R3 L1 P2 元修复 + 自指审查局限明示，2026-08-05 GLM-5.2 深度探索会话）**<!-- fix: R3-meta-self-audit-v2.5.3 -->：
> - **元层面前置声明（R3-ZL-016）**：新增 **§1.1 自指审查局限**——明示方法论不适合自指审查（P2 就地改写审查对象时统计收敛轨道全部失效），预期终止形态只能是 `forced_by_*`。基于 R1-R3 三轮二阶回归实证（13→4→5 blocking 链）。
> - **Ghost 修复诚实标注（R3-ZL-005，5 项 DEFERRED）**：v2.5.2 changelog 中 5 项 Major（R2-ZL-028/033/035、R2-IG-008、R2-ZL-037）经 MiniMax-M3 独立 grep 验证**仅存在于 changelog 文字，正文从未实现**。本轮诚实标注为 DEFERRED，作为 v2.6.0 待办——强行补丁会继续引入二阶回归（已在 R3 实证）。
> - **P2 修复可验证性约束（教训沉淀）**：本次 ghost 修复暴露 §3.4 (a) 检查盲区——后续 P2 验证须 grep 正文锚点（`<!-- fix: ID -->` 或 `§x.y L<行号>`）存在方可判通过。已写入 §1.1 + 附录 B + 记忆 `skill-v2-self-audit-structural-nonconvergence`。
> - **本轮未补 R3 新 blocking**（R3-ZL-001/002/003/004 等 5 项）：理由同 ghost 处理——自指场景下修复必引入新缺陷，元层面声明 + 强制收口是正确终止形态。
>
> **v2.5.2 变更（R2 L1 P2 修复，3 厂商异构对抗 MiniMax-M3/GLM-4.6V/DeepSeek-v4-pro，37 项新缺陷，4 blocking + 25 major + 8 minor；本轮发现 R1 修复引入二阶回归）**<!-- fix: R2-L1-self-audit-v2.5.2 -->：
> - **Blocking（4，全部为 R1 修复的二阶回归）**：
>   - **R2-ZL-026**：§七精度声明"必须 reliability 库交叉验证"在多数 LLM Agent 默认环境（无 reliability/scipy/numpy）下 → Track B 永久 provisional → STOP 不可达新死锁。修复：定义 pseudocode-only 环境的替代 Track B OK 判据（手算近似 + 连续 3 轮 m₁₂(S2)>0 + N̂_S2 波动 ≤15% → 允许 provisional_stop_pseudocode）。
>   - **R2-ZL-023**：§4.2.y "L1 子会话读取 .context/snapshots/ 快照" 在 Proma 协作子会话（独立 session 目录）不可达。修复：明示短文档内联 prompt / 长文档写 workspace-files 共享目录两条路径。
>   - **R2-ZL-024 / R2-IG-004**：`p2_modified_count` 一字段双语义（P2 主动修复 + 并发写估算）。修复：拆分为 `p2_modified_count`（P2 修复数）+ `p2_concurrent_changes`（并发写检测次数）。
>   - **R2-ZL-034**：§5.4 场景 D "L1 子会话主动通知父会话" 假设子→父反向通信可用，未验证。修复：§0.1 探测项 + 不可用时直接降级。
> - **Major（10 关键，其中 5 项 R3-ZL-005 验证为 ghost 仅 changelog 未入正文，已 DEFERRED 标注）**<!-- fix: R3-ZL-005 ghost -->：R2-IG-005（provisional 双语义拆分）/ R2-IG-010（n_eff 中 n = 3k）/ R2-IG-001（E4/E5 类 B 归类）/ R2-IG-002（Acknowledge 时间预算）/ R2-IG-007（§4.1 vs §4.2 第 1 轮跳过）/ ~~R2-ZL-028（carryover DEFERRED_PERMANENT）~~ **DEFERRED（正文未补，R3 验证 ghost）** / ~~R2-ZL-033（.bak 恢复优先级）~~ **DEFERRED（正文未补，R3 验证 ghost）** / ~~R2-ZL-035（carryover 在 Chapman m₁₂ 显式计入）~~ **DEFERRED（正文未补，R3 验证 ghost）** / ~~R2-IG-008（§3.6 ρ̄_l2 加权平均）~~ **DEFERRED（正文未补，R3 验证 ghost）** / ~~R2-ZL-037（拉丁方 >3 轮扩展）~~ **DEFERRED（正文未补，R3 验证 ghost）**。
>
> **⚠️ R3 元发现（MiniMax-M3 独立 grep 验证）**：v2.5.2 的 5 项 Major 修复仅存在于 changelog 文字中，正文从未实现——这是 **P2 修复可验证性约束缺失**的实证（§3.4 (a) 原始修复检查只检查"缺陷是否真正被修复"，未要求锚点可追溯）。后续 P2 验证须**逐条 grep 正文锚点存在**方可判通过。本轮决定不补这 5 项（已 DEFERRED），因为：① 3 轮自指审计已实证方法论不适合自指审查（§1.1）；② 强行补丁会继续引入二阶回归（R3 已发现 R2 修复引入 5 新 blocking）；③ 这 5 项可在常规（非自指）审查场景下作为 v2.6.0 待办。

> **v2.5.1 变更（P3-full-R1 blocking 回退，1 次回退修复）**<!-- fix: P3-R1-blocking-regression -->：
> - **Blocking（1）**：S5 实时并发写检测缺失 → 新增 §4.2.y 实时并发写协议（审查前快照 + 每轮派发前/聚合后哈希比对 + Chapman 借用声明扩展 + 报告披露 `doc_concurrently_modified`）。
> - **Major（4）**：S1 schema hardcoded "2.4.0" → 改为"读 frontmatter 不硬编码" + 补 `p2_modified_count` / `carryover_defects` / `chapman_violation` / `doc_concurrently_modified` 字段；S3 NHPP 伪代码数值偏差 → 加精度声明 + Track B 决策约束（必须 reliability 库/scipy.optimize 交叉验证，仅伪代码时降级 provisional）；S2 拉丁方轮换无执行指令 → §5.2 补 3×3 拉丁方示例；S5 Chapman 自指审查不涵盖并发写 → §4.2.y 整合扩展。
> - **Minor（4）**：S4 E6×类 B 名义死胡同 → 改为"引导用户改选类 A/类 C"；S3 Track A/B 输入区分（全缺陷 vs S2）；S2 ScheduleWakeup 60s 可达确认；S1 D_k<10 边界行为标注。

> **v2.5.0 变更记录（深度探索会话 R1 自指审计 P2 修复，3 厂商 L1 异构对抗 GLM-4.6V/MiniMax-M3/DeepSeek-v4-pro，38 项去重缺陷）**：<!-- fix: R2-R1-self-audit-v2.5 -->
> - **Blocking 修复（13）**：(1) §七 Track B 上界公式 `U≈3/(1−e^(−n_eff))` 恒≥3 与"95%<2"矛盾 → 更正为 Rule of Three `U≈3/n_eff`（R1-IG-001）；(2) §3.3 L1 去重 Jaccard>0.7 无操作定义 → 补完整 tokenization/预处理/计算单位规范（R1-IG-002）；(3) §4.2 NHPP Goel-Okumoto MLE 无实现 → 新增 §七 Newton-Raphson 伪代码 + 初始值 + 收敛判据 + 库引用（R1-IG-003/R1-ZL-005）；(4) §3.7 人工裁决 1c+1r 注入与投票分布表产生分类悖论 → 改为单向注入 + 新增 arbitrated_by=human 标签（R1-IG-004/R1-ZL-014）；(5) §4.2 Chapman 封闭种群假设 vs P2 每轮修改文档 → 新增 §4.2 借用声明 + 敏感性分析 + Jolly-Seber 回退（R1-FU-001）；(6) §3.3.1 / §4.5 30s/30min 定时器回合制 Agent 无原语 → 改 ≥60s + 引用 ScheduleWakeup 实现（R1-IG-006/R1-IG-007/R1-ZL-001/R1-ZL-002）；(7) §4.5 ESCALATE_HUMAN 6 种触发后继路径死锁 → 新增 §4.5.x 后继状态机（R1-ZL-012/013/015/016/017/019/020）。
> - **Major 修复（21）**：STOP 条件碎片化统一（R1-IG-005/R1-ZL-018）；降级触发对照表 + 工作边界禁止（R1-FU-007/R1-ZL-008/R1-ZL-009）；ρ 无引用改 unvalidated_prior（R1-IG-008）；Tier→模型映射示例表（R1-ZL-006）；NHPP ≥3 vs ≥5 真正含义标注（R1-FU-004）；η 3.2× 推导补全（R1-FU-003）；55→85% 循环论证改定性表述（R1-FU-002）；Goel-Okumoto 借用声明（R1-FU-005）；§0.5 "多数环境不可用"具体化（R1-FU-006）；M_k dead symbol 删除（R1-FU-008）；T1/T2/T3 前向引用锚点（R1-FU-009）；ESCALATE 三态命名规范（R1-FU-010）；章节编号统一（R1-FU-011）；§4.5 用户指示枚举 3 类（R1-FU-012）；N_vendor=3 L2 厂商复用规则（R1-ZL-007）；10 调用/轮 改"理论最小值"（R1-ZL-003）；跨窗口恢复具体操作（R1-ZL-004）；LLM 算 Chapman 防错（R1-ZL-010）；P3-full 降级 ρ 估计（R1-ZL-011）；维度失败 Chapman 缺失数据处理（R1-ZL-021）；not_converged 报告建议修正（R1-ZL-022）。
> - **Minor/Suggestion 修复（6）**：Track A 边界 <vs≤ 统一（R1-IG-009）；status 取值集合定义（R1-IG-010）；§0.6 自检答案移附录 A（R1-IG-011）；保守取较低者理由（R1-FU-013）；fix 标记噪音迁附录 B（R1-FU-014）；L3 纯机械 vs §4.5 NLP 转换约束（R1-IG-012）。<!-- fix: NEW-001 P2-Verify 修复 frontmatter 计数 4→6 -->

# 结构化文档多Agent终局验证方法论 V2

> 基于5学科(信息论/统计检验/博弈论/系统论/逻辑学)×5模型×2轮交叉论证的改进版

> **v2.4.0 变更记录（Round 3 meta-review 修复，L1-R1-* 缺陷池 28 项）**：<!-- fix: L1-R1-meta-round3 -->
> - **Blocking（6）**：A-001（§3.3 与 §5.2 的 L1 厂商数统一）、B-001（精简模式 SDI 判定顺序）、B-002（§5.4 L1 信息隔离显式降级）、B-003（Acknowledge 外层超时+循环上限）、C-001（55%→85% 推导依据）、C-002（N_vendor=1 双降级 P2 异底座豁免）。
> - **Major（13）**：A-002（M_k 符号 + Track A 公式更正为 D_k）、A-003（95% CI 方法）、A-004（"文档边界"操作性判定）、A-005（§3.1 反馈回路）、B-004（门控表已覆盖，确认）、B-005（增量基线 schema）、B-006（P3-full↔P2 总超时）、B-007（ESCALATED/DISPUTED 语义）、B-008（二次确认轮询间隔强制）、C-003（§4.5 超时与在途子会话协调）、C-004（完整模式厂商需求修正）、C-005/C-009（ρ 组合模型）、C-006（NHPP 小样本与 STOP 调和）。
> - **Minor/Suggestion（9）**：A-006（blocking vs major≥3 优先级）、A-007（"增量写"表述）、A-008（报告模板补 ESCALATED/DISPUTED 段）、B-009（收敛判定显式触发点）、B-010（升级触发优先级）、C-007（η=0.126 推导链）、C-008（维度打包策略）、C-010（短文档轮询优化）。

> **v2.3.0 变更记录（Round 2 修复，10 Blocking/Major + 13 Minor/Suggestion，0 DEFERRED）**：
> - **Blocking**：R2-IF-001（SDI 公式与优先级统一为"SDI≥2 一律升级"）、R2-LG-002（§六检查清单第 6 项追加强制 STOP 豁免）、R2-LG-011（§4.2.x 中断恢复补状态文件 schema + 损坏检测 + 重计去重）。
> - **Major**：R2-IF-002（模型家族 ≥4→≥3）、R2-ZU-001（list_messages 轮询补 JSON parse + 二次确认）、R2-LG-001（补料时 P3-light 重做判定）、R2-LG-003（人工裁决 JSON schema + 1 confirm+1 reject 注入）、R2-LG-004（门控表补 CONTINUE→L1 / P3-full→P2 回退 / P2验证重试 / SDI升级 4 个转换）、R2-LG-008（§0.6 自检升级 3 层 a/b/c）、R2-LG-009（§4.5 补 30min 超时 + Acknowledge 确认）。
> - **Minor/Suggestion**：管线图 3-6 Agent 标注、精简分支图、SDI 精简模式标注、权重与 §5.2 矛盾消解、M₁/M₂ 滑动窗口说明、P3-light 仅首轮、§七交叉引用、§0.5 探测协议、门控表 CONFIRMED_NO_JURY 引用、覆盖率待实证标注等（共 13 项）。
> - **DEFERRED**：无。所有 23 项缺陷均已在文档内修复，无因证据不足或范围超出本轮而推迟的项目。

## 核心改进相对原版

| 原版问题 | V2改进 | 效果 |
|---------|--------|------|
| 四维{C,R,S,B}不完备 | 六维{I,F,Z,U,L,G}按独立权威源partition | **维度空间扩展**（4→6，新增 U/G 两维）；实际召回率提升幅度**待实证校准**，不作定量声称（R1-FU-002 切断循环论证<!-- fix: R1-FU-002 -->） |
| 30%阈值假收敛 | 双轨Chapman+NHPP停止准则 | m₁₂=0硬禁止收敛 |
| P1→P2→P3线性断裂 | P3-light→L1→P2修复验证→P3-full→L2陪审→L3机械聚合 | 闭环+反馈 |
| 同源偏差ρ≈0.80（**unvalidated_prior**） | T1/T2/T3三级去相关 | ρ→0.12（**unvalidated_prior**，无文献引用，见 §5.1）<!-- fix: R1-IG-008 --> |
| 24调用η=0.034（**unvalidated**） | 7调用/轮（3轮最低≈21调用，**理论最小值**；实际含轮询远超，见 §5.2）<!-- fix: R1-ZL-003 --> | η提升幅度**unvalidated**（先前"3.5×"基于错误推导已废弃，见下注） |

> \* 效率比为**理论预期值，待实证验证**（未在受控场景校准）。<!-- fix: L1-LG-008 --> "7调用/轮"指**Agent 派发数**（L1+P2+P3+L2 子会话计数），不含 list_messages 轮询、状态读写等元调用；实际总工具调用数 = Agent 派发数 × (1 + 平均轮询次数) ≈ 3-5×。本 Skill 强制 ≥3 轮（§4.3），故 3 轮最低 Agent 派发数：精简模式≈21、完整模式≈30。<!-- fix: L1-IF-002 R1-ZL-003 -->
>
> **η→0.126 推导链（L1-R1-C-007 + R1-FU-003 完整化）**<!-- fix: R1-FU-003 -->：η=R_joint(1−δ)/C（§七）。以 3 个 Agent、单缺陷检出率 rᵢ=0.5 为例：
> - ρ=0.80（同源）：R_joint = 1 − ∏(1 − rᵢ√(1−ρᵢ))，每个 Agent 独立有效检出率 rᵢ√(1−ρ) = 0.5×√0.20 ≈ 0.224，联合 R_joint = 1 − (1−0.224)³ ≈ 0.532
> - ρ=0.12（三级去相关）：rᵢ√(1−ρ) = 0.5×√0.88 ≈ 0.469，联合 R_joint = 1 − (1−0.469)³ ≈ 0.858
> - 增益比 = 0.858 / 0.532 ≈ **1.61×**（非线性，远小于先前估计的 3.2×）
>
> 重新代入：以原版 η=0.034、C=24 反推 R_joint(1−δ)≈0.82；新版 R_joint(1−δ)≈0.82×1.61≈1.32（理论上限为 1，此处说明 rᵢ=0.5 假设偏高），取 R_joint(1−δ)≈0.95 上界 → η≈0.95/21≈0.045。**先前"η→0.126 (3.5×)"基于错误的 3.2× 增益假设，已废弃**。实际 η 提升需用真实 rᵢ 和 ρ 实证校准，**默认标注 unvalidated**。
>
> \*\*\* "覆盖**理论上界显著提升**"为定性表述<!-- fix: R1-FU-002 -->：先前"55%→85%"为基于"维度数比"的代理估计，存在循环论证（用六维框架本身作"独立权威源"推导六维的覆盖率上界）。覆盖率是经验性指标需实证测量，不应以维度数比作代理。**正确做法**：在 N 份已标注 ground truth 的种子文档上，对比四维 vs 六维的实际缺陷召回率，作为覆盖率上界依据。在校准数据可用前，仅保留定性表述。
>

---

## ⚠️ 执行规则（先读此节，不可跳过）

### 规则1：你是一个管线执行器，不是报告生成器

你的首要任务是把下面的管线**每一步都实际执行**——创建子会话、等待结果、聚合、修复、验证、走查——而不是写一份漂亮的审查报告。只有当管线全部执行完毕、收敛判定通过后，你才输出§六格式报告。

### 规则2：至少3轮。这不是建议。

无论文档多短、多简单，你必须执行至少3轮完整的L1→P2→P3-full循环。§4.3规定了这一硬性要求。如果你只做了一轮就开始输出报告——你正在犯E1错误。

**如果你发现自己在想"文档很短，一轮够了"——不要。做第二轮。**

> **与 §4.2 的优先级（fix: L1-IF-001）**：§4.1 的"统计信号驱动轮数"与本节/§4.3 的"至少3轮"是两层约束而非冲突——**统计收敛判定（Track A/B OK）仅在不低于3轮后才有资格触发 STOP**；在轮次 <3 时，即使 Track A/B 均 OK 也必须 CONTINUE（§4.3 硬屏障优先）。即：`轮次≥3` 是 STOP 的必要非充分条件，`Track A/B OK` 是 STOP 的充分条件（二者同时满足才允许 STOP）。

### 规则3：§六报告是最后一步

在你确认以下条件全部满足之前，不要输出§六格式报告：
- [ ] 总轮次 ≥ 3
- [ ] 每轮都实际创建了L1子会话
- [ ] 每轮都执行了P2修复验证
- [ ] 每轮都执行了P3-full
- [ ] §4.2收敛判定完成

如果上述任一未打勾 → **回到Step 2，执行下一轮**。不要输出报告。

---

## 一、适用文档与进入条件

**执行顺序**：先由本节确认适用性与进入条件 → 再执行 §〇 环境准备 → 再进入 §三 管线。（章节编号为逻辑分区，不代表执行先后。）<!-- fix: minor-section-order -->

**适用**：用户故事、PRD、架构设计文档、API规范、测试用例等结构化文档。

**进入条件**（任一满足即触发）：
- 用户明确说"审查/验证/检查/找出问题/review"
- 用户提交了一份结构化文档并询问质量
- 用户说"这个文档有什么问题"
- 用户说"用多Agent方法审查这个"

**不适用**：纯叙事性文档（如散文、博客）、非结构化自由文本、已部署代码的code review、**本方法论文档自身或任何会被本管线 P2 就地改写的文档**（详见 §1.1 自指审查局限<!-- fix: R3-ZL-016 -->）。

## 1.1 自指审查局限（R3-ZL-016 修复：元层面适用边界声明）<!-- fix: R3-ZL-016 -->

> **核心结论**：本方法论**不适合自指审查**（即审查对象是方法论自身、或审查过程中 P2 阶段会就地改写审查对象的场景）。在此场景下，统计收敛轨道（Chapman / NHPP / Rule of Three）**全部失效**，**不得以 `converged` 结项**，只能以 `forced_by_escalation_cap` / `forced_by_human` / `forced_by_timeout` 强制收口。

**实证证据（R1-R3 三轮自指审计，2026-08-05 GLM-5.2 深度探索会话）**：
- **二阶回归连续 3 轮成立**：R1 的 13 项 blocking 修复引入 R2 的 4 项 blocking（v2.5.2 changelog 自述）；R2 的修复又引入 R3 的 5 项 blocking（含死锁换形、ghost 修复、新阈值冲突）。修复引入率未见衰减 → NHPP 的 b̂>0 衰减假设被实证否定。
- **失效面覆盖整条统计收敛链**：
  - Chapman 封闭种群假设：P2 修复每轮改文档 → 缺陷池动态变化 → N̂ 估计发散（实测 N̂≈179 vs D_k=96，N̂ 增长远快于 D_k）
  - NHPP Goel-Okumoto：每轮拉丁方轮换底座 + Prompt 重写 → "发现率随时间衰减"假设失效（§4.2 已自述）
  - 跨轮 id 匹配：依赖 description 归一化，而 P2 修复恰恰改写 description → m₁₂ 结构性压低
  - Rule of Three：n=3k 把"发现了 S2 缺陷的轮次"也计入 n，违反"零事件观测"前提（R3-ZL-012）
- **表面积单调增长**：v2.3.0 → v2.5.3 文档从数百行增至 1086 行，每轮修复新增状态机互不正交，新机制与既有机制的交叉矛盾按 O(n²) 增长——R3 的 18 项发现中 9 项是机制之间的交叉矛盾而非单机制内部错误。

**适用性判据**：若本管线的 P2 阶段会就地改写审查对象本身 → **禁止以 `converged` 结项**，预期终止形态是 `forced_by_*`。

**推荐变体管线（自指审查专用）**：
- **冻结版本 + 只读审查**：审查基于快照（§4.2.y），修复另开新版本，使封闭种群假设重新成立
- **异构 Root 对抗**：双 root（如 GLM-root + DeepSeek-root）独立审查同一冻结版本，末端 meta 对比（参见记忆 `parallel-audit-session-handling`）
- **放弃统计收敛**：直接用 L1→L2→L3 单轮 + carryover 跟踪，不追求 Chapman/NHPP 收敛

---

## 〇、启动前置：环境准备（进入管线前必须先执行）

**目的**：确认可用渠道和模型，避免调用禁用渠道导致会话卡死。

### 步骤0.1：扫描可用模型

调用 `list_channels` 获取所有渠道及其 `enabled` 状态。只使用 `enabled: true` 的渠道。

调用 `mcp__collaboration__list_available_agent_models` 获取可用模型列表（若该工具不可用则跳过，仅使用 `list_channels` 结果）。

**反向通信探测（R2-ZL-034 修复）**<!-- fix: R2-ZL-034 -->：若计划使用 §5.4 场景 D（工作边界禁止时的"子会话→父会话主动通知"），先派一个测试子会话尝试 `mcp__session__send_message(to=父session_id, ...)`，父会话检查 `list_messages(自身)` 是否收到——成功 → 标注 `sub_to_parent_comm=true`；失败 → 标注 `sub_to_parent_comm=false`，后续 §5.4 场景 D 不做"主动通知"尝试，直接走降级模式。父会话派发子会话时**显式在 prompt 中包含自己的 session_id** 及反向通知格式。

### 步骤0.2：按Tier分类可用模型

将可用模型按厂商家族分组（**T1/T2/T3 定义见 §5.1 Tier 全称表**，本节仅作可用性标注<!-- fix: R1-FU-009 -->）：
```
厂商A: [model-a1, model-a2, ...]  → 可用于T1/T2
厂商B: [model-b1, model-b2, ...]  → 可用于T1/T2
厂商C: [model-c1, ...]            → 可用于T1/T2/T3
...
```

### 步骤0.3：模式选择

统计可用独立厂商数 N_vendor。**厂商需求修正（L1-R1-C-004）**：完整模式 L1 需 ≥3 厂商（§3.3"底座≥3个不同模型家族"）、L2 需 3 个互不相同厂商（§3.6）；L1 与 L2 合计 6 Agent **完全错开**需 ≥6 厂商。N_vendor∈[3,5] 时完整模式仍可用，但 L2 与 L1 存在厂商复用（独立性下降，报告标注 `l2_vendor_overlap`）。

| N_vendor | 可用模式 | T3可行性 |
|:---:|------|:---:|
| ≥6 | 精简+完整均可（完整模式 L1 3 厂商 + L2 3 厂商**完全错开**，陪审独立性最强） | ✅ T3可用 |
| 3~5 | 精简+完整均可（完整模式 L2 陪审与 L1 存在厂商复用，报告标注 `l2_vendor_overlap`；仍满足 §3.3 L1 三家族要求） | ✅ T3可用（≥3个不同厂商） |
| 2 | 仅精简模式 | ⚠️ T3降级为T2（跨厂商但不够异构） |
| 1 | **底座降级模式** | ❌ 所有Agent同一底座家族，标注"同源偏差风险" |

**底座降级标注**（针对厂商异构度不足，区别于§5.4执行环境的并行降级）：<!-- fix: L1-IF-003 --> 当N_vendor<3时，在最终报告开头显式标注：
> ⚠️ 底座降级：底座异构度不足（可用厂商=N_vendor），同源偏差ρ估计≈0.50-0.80，可能遗漏系统性盲区缺陷。建议后续用异构厂商补审。

### 步骤0.4：分配底座

根据N_vendor选择分配策略（见§5.2）。分配后输出"底座分配表"以供后续阶段引用。

### 步骤0.5：工具依赖表与探测协议（确认调用面可用）<!-- fix: L1-IF-006 --><!-- fix: R2-minor-probe -->

**探测协议**（避免"工具列表里存在但实际不可用"）：对每个关键工具，启动管线前**实际发起一次空载调用**并确认返回非错误——
- `list_channels()`：实际调用一次，确认返回渠道列表（非空且含 `enabled` 字段）。
- `list_messages`：对任一已有 `session_id` 调用一次（取 `limit=1`），确认返回结构化消息列表。
- `create_session`：不预创建，但确认工具在当前会话工具集中可见（避免"工具未注入"误判）。

调用抛错、超时、或返回错误码 → 视为该工具**不可用**，进入下表"回退"列，并在报告元数据标注 `tool_probe_failed=[工具名]`。

| 工具 | 来源 | 用途 | 不可用时回退 |
|------|------|------|-------------|
| `list_channels` | Proma collaboration/session MCP | 扫描可用渠道与 `enabled` 状态 | 直接读 mcp.json 静态推断 |
| `mcp__collaboration__list_available_agent_models` | Proma collaboration MCP | 列出可分配模型 | 仅用 `list_channels` 结果 |
| `mcp__collaboration__create_session` / `mcp__session__create_session` | Proma collaboration/session MCP | 创建 L1/L2/P2/P3 子会话 | §5.4 并行降级模式 |
| `mcp__collaboration__send_message` / `mcp__session__send_message` | 同上 | 向子会话派发任务（推荐 `wait=false` + `notify` 回调） | 同步 `wait=true`（阻塞主会话，谨慎用） |
| `mcp__session__list_messages` | Proma session MCP | 轮询子会话产出（L1→P2 门控基线，§3.3.1 第三层） | 无等价回退，缺失则不可并行 |
| `wait_for_delegations` / `get_delegation_results` | 旧版 SDK 委托 API | 批量等待委托结果 | 走 `list_messages` 第三层轮询（**Proma 协作子会话环境不可用**：未注入相应 MCP 工具，参见 §0.1 工具探测结果；其他环境未验证<!-- fix: R1-FU-006 -->） |

**最小工具三元组**：`create_session` + `send_message` + `list_messages` 是本Skill在 Proma 协作子会话环境下的最小集合，缺失任一即进入 §5.4 并行降级模式。

### 步骤0.6：Skill 加载自检（3 层，逐层加严）<!-- fix: L1-IF-008 --><!-- fix: R2-LG-008 -->

frontmatter 的 `description` 字段仅作触发与摘要用，**不足以单独驱动审查**（缺六维 Prompt、双轨停止公式、门控协议、降级规则）。会话启动后必须按以下 3 层逐项自检是否加载了完整 SKILL.md。纯文本"记得有这节"不达标——必须能引用、能算、能判。

**层 a — 文本引用**（能逐字/近似引用以下章节的关键句）：
- [ ] §3.3.1 三层门控（含 `list_messages` 第三层兜底与"连续2次轮询无变化"判据）
- [ ] §4.2 Chapman/NHPP 双轨公式与符号 M₁/M₂/m₁₂、`m₁₂=0` 硬禁止收敛
- [ ] §4.3 小样本硬屏障（<3 轮禁止收敛）
- [ ] §3.7 L3 投票分布判定表（c≥2 / c=1,u≥1 / c=1,r=2 / c=0）

**层 b — Chapman 计算**（**必须输出完整代入与每一步运算**，禁直接给答案——防 LLM 算术弱导致自检失效<!-- fix: R1-IG-011 R1-ZL-010 -->）：
- [ ] 给定 M₁=8, M₂=10, m₁₂=5，**逐步写出** N̂_Ch=(M₁+1)(M₂+1)/(m₁₂+1)−1 与 Var(N̂) 的代入式与中间结果，再给最终值。**对照前不要先翻**预期答案（见**附录 A·自检答案**）。
- [ ] 给定 D_k=20、N̂=22，按 §4.2 Track A OK 条件（**严格 <**）判断：剩余=N̂−D_k=2，阈值=0.1×D_k=2 → **等号时第一条件不成立，OK 必 FAIL**（统一为严格 <，与 §4.2 一致<!-- fix: R1-IG-009 -->）。

**层 c — L3 判定模拟**（**先按 §3.7 投票分布表 + SDI 规则自判，再对照附录 A**<!-- fix: R1-IG-011 -->）：
- [ ] 投票 (confirm=major, confirm=blocking, reject) → 自判？
- [ ] 投票 (confirm=major, uncertain=−, reject) → 自判？
- [ ] 投票 (confirm=blocking, confirm=minor, confirm=major) → 自判？

**判定规则**：任一层任一项未命中 → **本会话仅加载了 description，禁止启动完整审查管线**，改走单 Agent 快速扫描并在报告开头标注「⚠️ 降级：仅加载 description，未执行完整方法论」。

## 二、六维审查空间

### 2.1 维度速查

| 维度 | 权威源 | 一句话核心问题 | Prompt关键词 |
|------|--------|-------------|-------------|
| **I**(自洽) | 文档自身 | 各部分是否自洽、无内部矛盾？ | "找出文档中所有自相矛盾或不一致之处" |
| **F**(保真) | 上游spec | 与上游PRD/架构是否一致？边界是否闭合？ | "对照上游文档逐项检查一致性，标记所有偏离和遗漏" |
| **Z**(可造) | 技术现实 | 在给定约束下工程上是否可实现？ | "评估每个需求的技术可行性，标记不现实的要求" |
| **U**(可懂) | 目标读者 | 对下游实施者/真实用户是否可理解？ | "找出所有可能引起误解的表述、未定义术语、过于模糊的描述" |
| **L**(闭环) | 状态机 | 所有角色/状态是否形成完整闭环？ | "画出角色-状态图，标记所有未闭合的路径和越界操作" |
| **G**(护栏) | 测试+安全 | 是否可测试？可追溯？安全边界是否明确？ | "对每个需求判断可测试性，标记无法客观验证的验收条件" |

### 2.2 维度权重（按文档类型自适应）

| 文档类型 | I | F | Z | U | L | G |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|
| 用户故事 | 15% | 25% | 10% | 20% | 20% | 10% |
| PRD | 10% | 30% | 10% | 20% | 15% | 15% |
| 架构设计 | 10% | 15% | 25% | 10% | 25% | 15% |
| API规范 | 15% | 25% | 15% | 10% | 10% | 25% |
| 测试用例 | 15% | 20% | 5% | 10% | 15% | 35% |

**权重用途**：分配Agent数量时，**理想情况下**高权重维度配2个异构Agent；低权重维度配1个。

> ⚠️ **与 §5.2 的优先级**：本规则是"维度级理想分配"，§5.2 的精简/完整模式是"管线级实际预算"。当预算不足以按本规则为每维独立配 Agent 时，**以 §5.2 为准**——采用"每 Agent 兼顾 2 维"的打包策略覆盖全部 6 维。此时权重退化为"打包优先级"：高权重维度的场景优先分配给 T3 异构 Agent（见 §3.3 Agent 分配说明）。<!-- fix: R2-minor-weight-alloc -->

**权重校准与回退**：<!-- fix: L1-LG-010 --> 上表为默认先验，未在用户具体场景内校准。当文档类型混合、未知，或用户未明确类型时，**回退到等权重（每维 1/6≈16.7%）**，并在报告元数据标注 `weight=prior_uniform`；若用户提供了历史缺陷分布数据，可按历史频率替换上表先验并标注 `weight=calibrated`。

---

## 三、三层审查架构

### 3.1 完整管线（按顺序执行，不可跳过任何步骤）

```
Step 1: P3-light(预走查, 1Agent)
Step 2: L1(分工搜索, 3 Agent并行；完整模式 L1+L2 合计 6 Agent，见 §5.2)  ← 不可跳过
Step 3: P2-修复(1Agent) → P2-验证(1Agent,异底座)  ← 不可跳过
Step 4: P3-full(终验, 1Agent)
Step 5: L2(陪审确证, 3Agent并行)  [仅完整模式]
Step 6: L3(机械聚合, 无LLM)
```

**反馈回路**（虚线/受控环路，不改变主链路 L1→L2→L3 的单向聚合方向，见 §5.3）：<!-- fix: L1-R1-A-005 -->
```
P3-full →(blocking 新发现)→ P2 修复       [§3.5，回退 ≤1 次]
收敛判定 →(Track A/B 不 OK)→ L1 新一轮     [§4.1/§4.2，轮次延续不重置]
ESCALATE_HUMAN →(用户补料/调整)→ L1 新一轮 [§4.5，P3-light 重做判定见 §4.5]
```

**精简模式分支图**（无 L2，详见 §5.2 与 §3.7 精简模式分支）：<!-- fix: R2-minor-lean-branch -->
```
P3-full → L3 机械聚合 (CONFIRMED_NO_JURY) → 收敛判定
                  ↑
        (跳过 Step 5 L2 陪审)
```

**P2修复验证不可跳过**。即使无法并行执行子会话，也必须用顺序方式执行修复和验证两步。P3-light和P3-full是两个独立阶段（共享P3前缀仅表示都涉及场景走查），不可混淆为一个阶段。

### 3.2 P3-light：预走查

**时机**：所有审查开始前。**目的**：从文档提取关键场景作为L1的方向性输入。

> **执行轮次**：P3-light **仅首轮执行**，提取的场景-维度映射在后续轮次中**复用**（避免每轮重复提取浪费调用）。例外：补料涉及核心场景变更时需重做 P3-light（判定规则见 §4.5 R2-LG-001）。<!-- fix: R2-minor-p3light-first-round -->

1. 1个Agent（任意强底座）从文档中提取3-5条核心使用场景
2. 每个场景按六维标注：主要检验I~G中的哪个维度？
3. 输出"场景-维度映射表"注入到各L1 Agent的Prompt中

**Prompt模板**：
```
从以下文档中提取3-5个最核心的用户/系统使用场景。
对每个场景，标注它主要检验哪些审查维度（I自洽/F保真/Z可造/U可懂/L闭环/G护栏）。
输出JSON格式：[{"scenario":"...", "primary_dims":["I","F"], "key_checkpoints":["..."]}]
```

### 3.3 L1：分工搜索（最大化召回）

**执行**：Agent数量取决于模式选择（见§5.2）——精简模式 L1阶段3Agent（每Agent兼顾2维，6维全覆盖）；完整模式 L1阶段3Agent（每Agent兼顾2维，6维覆盖由 L1 独自达成）**+ L2阶段3Agent（仅陪审确证，不分维度，对所有L1确认缺陷独立投票，不参与维度搜索）**。<!-- fix: L1-IF-002 --> L1与L2合计6次Agent调用，职责明确分离：L1=搜索最大化召回，L2=陪审最大化精度。以下以精简模式 L1 阶段3Agent为例，完整模式 L1 阶段类推，L2 阶段见§3.6。

Agent**完全并行**，**信息隔离**（互不可见对方输出）。

每个Agent：
1. 接收：原始文档 + 对应维度的审查Prompt + P3-light的场景-维度映射（只给相关场景）
2. 输出：结构化缺陷报告（JSON Schema，见下）
3. 要求底座≥3个不同模型家族（如Claude/GPT/Gemini/DeepSeek/GLM/MiniMax，任选3个异构家族）<!-- fix: R2-IF-002 -->（与 §5.2 L1 阶段 3 Agent 一致；§0.3 的 N_vendor≥3 即可满足）。**厂商分配（L1-R1-A-001）**：N_vendor≥3 时，3 个 L1 Agent 分配为 **3 个不同厂商**（T1 槽位也取独立厂商，而非与 T2 同厂商，以满足"≥3 家族"）；N_vendor=2 时（仅精简模式）退化为 2 厂商分配，T3 槽位强制为异构厂商，报告元数据标注 `l1_vendor_span=2`。

**Prompt模板（以I自洽维度为例）**：
```
你是文档审查专家，专攻「自洽性」维度。
你的任务：找出文档中所有自相矛盾、前后不一致之处。
特别注意以下场景：{P3-light中涉及I维度的场景}

对每个发现，输出：
- id: 唯一编号
- severity: blocking|major|minor|suggestion
- location: 段落/行号
- description: 矛盾的具体描述
- evidence: 引用矛盾的两处原文
- suggested_fix: 修复建议

不要审查其他维度的问题。不要与其他审查者通信。
```

**缺陷报告JSON Schema**：
```json
{
  "agent_id": "L1-I",
  "dimension": "I",
  "findings": [
    {
      "id": "L1-I-001",
      "severity": "blocking|major|minor|suggestion",
      "location": {"section": "§3.2", "line_range": [120, 145]},
      "description": "一句话描述",
      "evidence": "引用原文",
      "suggested_fix": "修复建议"
    }
  ]
}
```

**L1聚合（去重操作定义，R1-IG-002）**<!-- fix: R1-IG-002 -->：所有 Agent 完成后，对每两条 finding 计算 Jaccard 相似度，**操作规范**：
- **tokenization**：按空白与标点分词（中英文统一），全部小写，去标点
- **表示**：每条 finding 的"section + description"拼接为单一字符串 → tokenize → 转为词集合
- **Jaccard**：J(A, B) = |词集A ∩ 词集B| / |词集A ∪ 词集B|
- **阈值**：J > 0.7 → 视为同一缺陷，合并（severity 取较高者，evidence/suggested_fix 取较具体者，id 保留较早的并加 alias）
- **跨轮 id 一致性（R7 实战经验）**：缺陷 id 强制格式 `{round}-{dimension_pair}-{seq}`（如 `R1-IG-001`、`R2-ZL-003`）；跨轮重捕（m₁₂ 计算用）按 description 归一化匹配（不依赖 id 字面），id 仅作引用锚点

按 severity 排序生成"缺陷候选池"。

### 3.3.1 ⚠️ L1→P2门控（强制执行）

**L1聚合前必须先确认所有L1子会话完成。**

三层门控（按工具可用性逐层回退）：<!-- fix: L1-ZU-002 --><!-- fix: L1-IF-007 -->

1. **第一层（如可用）**：`wait_for_delegations` (mode="all") 等待所有L1子会话。
2. **第二层（如可用）**：`get_delegation_results` 轮询每个L1子会话（每30s一次，总超时15min），日志标注降级原因。
3. **第三层（基线兜底，始终可用）**：`list_messages` 轮询每个L1子会话的最新消息——对每个由 `create_session` 创建的 L1 子会话 `session_id`，**每 ≥60s**（不是 30s——回合制 Agent 无内建定时器，Proma `ScheduleWakeup` 最小粒度 60s，bash sleep 占用工具调用配额；用 `ScheduleWakeup(delaySeconds=60, ...)` 在 prompt 中带"检查 L1 完成状态"指令实现<!-- fix: R1-IG-007 R1-ZL-001 -->）调用一次 `mcp__session__list_messages`（或等价 SDK 工具）取末条消息，按以下判据判定"已完成"：<!-- fix: R2-ZU-001 -->
   - **必须通过 JSON parse**：将末条消息文本解析为 JSON。parse 失败（含部分输出、被截断、含占位符如"处理中"/"分析中"/"正在…"、或包裹在 Markdown 代码块中但无法提取合法 JSON）→ **视为未完成，继续轮询**。
   - **必须含 `findings` 字段**：parse 成功但缺 `findings` 字段（或 `findings` 为空且原文档非空）→ 视为未完成。
   - **二次确认（防"flush 中途"误判）**：首次检测到合法 JSON 后，**再等 ≥60s 进行第二次轮询**（两次轮询间隔**强制 ≥60s**；若检测到内容变化 → 视为未完成，重新进入等待，且再次要求**连续 2 次、间隔均 ≥60s** 的内容稳定轮询）<!-- fix: L1-R1-B-008 R1-IG-007 -->，对比末条消息内容（文本哈希或长度比对）；若内容发生变化（说明子会话仍在追加输出，前一次 JSON 可能是部分 flush）→ 视为未完成，重新进入等待；**连续 2 次轮询内容稳定且均为合法 JSON** → 判定完成。
   - 总超时 15min；超时则标记该维度"审查失败"（见下方"超时处理"）。
   - **实现方式（R1-IG-007 R1-ZL-001）**：在 Proma 协作子会话环境下，用 `ScheduleWakeup(delaySeconds=60, reason="L1 轮询", prompt="<检查 L1 完成状态的本轮 /loop 指令>")` 注册延迟唤醒；唤醒时 `list_messages` 检查各子会话。其他环境用 `bash sleep 60` 占用一次工具调用。
   - **超时处理后的数据补全（R1-ZL-021）**<!-- fix: R1-ZL-021 -->：若某维度被标记"审查失败"，聚合时该维度数据缺失——Chapman 估计 N̂ 时分母用 `实际产出维度数 / 计划维度数` 作折扣因子调整（如 6 维中 1 维失败，N̂_adj = N̂ × 6/5），并在报告元数据标注 `dimensions_failed=[维度名]` + `n_hat_adjusted=true`。
   - **短文档轮询优化（L1-R1-C-010，suggestion）**：P3-light 判定为短文档（场景 ≤3 且篇幅 <2000 字）时，首层轮询初始间隔可缩短至 60s（先前 15s 在回合制环境下不可达，已修正<!-- fix: R1-IG-007 -->）；二次确认的两轮间隔仍强制 ≥60s，总超时不变。

> 在 Proma 协作子会话环境（`create_session` + `send_message`）下，`wait_for_delegations` / `get_delegation_results` 通常**不存在**，**默认直接走第三层 list_messages 轮询**。

**禁止行为**：
- ❌ 在L1子会话运行中就假设它们已完成
- ❌ 手动推测L1输出而不等待
- ❌ L1子会话调用失败时直接跳到P2（应重试或降级）
- ❌ 以任何理由完全跳过等待步骤

**超时处理**：若某L1子会话超时（>15分钟），标记该维度为"审查失败"，在缺陷池中标注，继续后续阶段但不跳过。

### 3.4 P2：修复-验证闭环

**修复Agent**：1个Agent（Tier 2底座），接收原始文档+缺陷候选池，产出修复后文档。

修复Agent Prompt模板：
```
你是文档修复专家。你收到一份原始文档和一份缺陷清单。
请逐一修复清单中的每个缺陷。修复原则：
1. 最小改动原则——只改必要的内容，不大规模重写
2. 保持原文风格和格式
3. 对于每个修复，在修改处添加注释标记（<!-- fix: L1-I-001 -->）以便验证
4. 如果某个缺陷无法在不引入新问题的情况下修复，标记为DEFERRED并说明原因
5. 修复完成后，输出完整修复后文档

缺陷清单：{L1聚合后的候选池JSON}
原始文档：{文档全文}
```

**验证Agent**：1个Agent（Tier 3底座，**必须与修复Agent不同底座模型**；例外：N_vendor=1 底座降级叠加并行降级时此"异底座"要求豁免，改为同底座顺序验证并标注 `p2_verify_same_base=true`，见 §5.4 L1-R1-C-002），执行三检：

(a) **原始修复检查**：候选池中每个缺陷是否真正被修复？
(b) **回归检查**：修复是否引入了新缺陷？（遍历全文档快速扫描）
(c) **六维复查**：修复后文档在全部6个维度上是否通过？

**三检规则**：
- 全部通过→进入P3-full
- 任一失败→**保留本轮已通过 (a) 原始修复检查的缺陷修复作为增量基线**，仅将 (b) 回归/(c) 复查未通过的部分回退到原始文档，并将验证报告注入修复Agent重试（最多2次）。重试基于"增量基线 + 待修缺陷"工作，**不全量回滚**已通过验证的修复。<!-- fix: L1-LG-002 -->
- 重试耗尽→**升级人工**（§4.5），附带完整修复历史与增量基线 diff

**增量基线 schema（L1-R1-B-005）**：增量基线 = 已通过 (a) 原始修复检查的修复集合，定义为：
```json
{
  "baseline_version": "<修复后文档版本>",
  "passed_fix_ids": ["L1-I-001", "..."],
  "baseline_ref": "<基线文档路径或 diff 引用>",
  "regression_fail_ids": ["..."],
  "review_fail_ids": ["..."]
}
```
§3.5 P3-full 回退（回退时保留已通过 (a) 的修复为基线）与 §4.5 升级报告（"完整修复历史与增量基线 diff"）复用此 schema。

### 3.5 P3-full：终验

**1个Agent**（与P3-light不同厂商的底座[T3去相关]，若厂商不足则降级为同厂商不同型号[T2]并在报告中标注降级 + **给出降级后 ρ 估计**：N_vendor=3 时 P3-full 必复用 L1 厂商之一，T3 不可行 → 退化为 T2，ρ 估计从 0.12 升至 0.30，报告元数据标注 `p3_full_t3_degraded=true` + `rho_p3=0.30`<!-- fix: R1-ZL-011 -->），执行完整场景走查：
- 用修复后文档重新走查P3-light提取的所有场景
- 检查每个场景的每一步是否有文档支撑
- 标记所有"走不通"的步骤

**判定**：
- 无blocking新发现→通过，进入 L2（完整模式）或 L3（精简模式，§3.7 精简分支）
- 有blocking新发现→回退 P2（最多1次）；回退1次后仍有 blocking 新发现→**ESCALATE_HUMAN（§4.5）**，附带 P2↔P3-full 完整往返记录<!-- fix: L1-LG-003 -->
- 有major新发现≥3→有条件通过（附带已知问题清单）
- **优先级（L1-R1-A-006）**："有 blocking 新发现"分支**优先于**"major≥3 有条件通过"——两者同时存在时按 blocking 分支执行（回退 P2 或升级）；仅当 blocking=0 时才适用 major≥3 的条件通过。

**P3-full↔P2 回退循环总超时（L1-R1-B-006）**：从首次 P3-full 启动到最终通过/升级，该回退循环累计墙钟上限 **60min**；超出 → 强制 ESCALATE_HUMAN（§4.5），升级报告标注 `p3_full_p2_loop_timeout`。回退次数仍受"最多1次"约束。

### 3.6 L2：陪审确证（最大化精度）

**3个异构陪审员**并行投票，**完全信息隔离**（互不可见投票结果）。3 个陪审员**之间**底座互不相同；与 L1 的厂商**尽量错开**（提升独立性），仅当 N_vendor<6 时允许复用并报告标注 `l2_vendor_overlap`（复用厂商尽量换不同型号）<!-- fix: L1-R1-C-004 -->。

**N_vendor=3 时厂商复用规则（R1-ZL-007）**<!-- fix: R1-ZL-007 -->：L1 3 Agent + L2 3 陪审员 = 6 槽位但仅 3 厂商 → 必然 ≥3 次厂商复用。**强制策略**：
- 3 个 L2 陪审员**之间**底座互不相同（仍满足 §3.6 内部独立性）
- L2 与 L1 的复用**按维度匹配优先级**：F/U 维度的 L2 陪审员优先复用 L1 中**未审查 F/U** 的厂商（如 L1A=DeepSeek 审 I/G、L1B=MiniMax 审 F/U、L1C=GLM 审 Z/L → F/U 维度的 L2 陪审员优先选 DeepSeek 或 GLM，避开 MiniMax）
- 报告标注 `l2_vendor_overlap=true` + `l2_reused_vendors=[厂商列表]` + `ρ̄_l2_estimate=0.30`（同厂商不同型号 T2 主导）

对L1聚合后的**每一个缺陷候选**独立投票：
```
verdict: confirm | reject | uncertain
confidence: 0.0-1.0
adjusted_severity: blocking|major|minor|suggestion
reasoning: 确认/拒绝/不确定的具体理由
```

### 3.7 L3：机械聚合（无LLM）

纯确定性规则，**不使用任何LLM**：

| 投票分布(c=confirm, r=reject, u=uncertain) | 判定 |
|-------------------------------------------|------|
| c ≥ 2 | **CONFIRMED**（缺陷确认，严重度=max投票） |
| c = 1, u ≥ 1 | **ESCALATED**（需人工判断） |
| c = 1, r = 2 | **DISPUTED**（记录争议，升级） |
| c = 0 | **DISMISSED**（丢弃） |
| **arbitrated_by=human**（经人工裁决注入，R1-IG-004/R1-ZL-014 修复）<!-- fix: R1-IG-004 R1-ZL-014 --> | **ARBITRATED**（不参与 c≥2 常规分类，单列于"经人工裁决"段，强制入报告；详见 §4.5 注入规则） |

**ESCALATED vs DISPUTED 语义与后继（L1-R1-B-007 + R1-ZL-013 修复）**<!-- fix: R1-ZL-013 -->：两者均为"需人工"状态，**最终都进入 §4.5 ESCALATE_HUMAN_PROTOCOL**（后继状态机见 §4.5.x），但语义不同——**ESCALATED**（c=1 且 u≥1）= 有 confirm 但陪审团存在不确定项，属"证据不充分，待人工确认"（报告标注 `needs_confirm`）；**DISPUTED**（c=1 且 r=2）= 1 confirm 与 2 reject 直接冲突，属"存在争议，待人工裁决"（报告标注 `disputed`）。判别规则：c=1 时剩余 2 票**任一为 uncertain → ESCALATED；全部为 reject → DISPUTED**——两者**互补覆盖 c=1 的全部情形，无重叠**。

**命名规范（R1-FU-010 修复）**<!-- fix: R1-FU-010 -->：为消除三态命名混淆，全文统一：
- `ESCALATE_HUMAN_PROTOCOL` = §4.5 升级人工协议（动作+状态机名）
- `ESCALATED_HUMAN_SDI` = §3.7 由 SDI≥2 触发的状态标签
- `ESCALATED` = §3.7 由 c=1∧u≥1 触发的状态标签
- `DISPUTED` = §3.7 由 c=1∧r=2 触发的状态标签
- `ARBITRATED` = §3.7 由人工裁决注入触发的状态标签（新增，R1-IG-004/R1-ZL-014 修复）

**精简模式（无 L2）分支**：<!-- fix: L1-IF-004 --> 精简模式跳过 L2 陪审（见 §5.2），上表投票分布判定不适用（SDI 升级判定仍适用，规则见下方"精简模式下的 SDI"）<!-- fix: L1-R1-B-001 -->，L3 聚合规则如下——
- L1 聚合 + P3-full 复查共同确认的缺陷 → 标记为 `CONFIRMED_NO_JURY`（依赖 L1 异构 + P3-full 双重覆盖，无陪审确证）
- 严重度取 L1 聚合 max severity 与 P3-full 复查 severity 的**较低者**——理由：精简模式无 L2 陪审交叉验证，取较低者反映"两源一致部分"的更可信严重度，避免单源过激判定（先前称"保守原则"措辞不准——保守通常指取较高者防低估，此处取较低者的真实理由是"两源一致才采信"<!-- fix: R1-FU-013 -->）
- 报告元数据标注 `jury=L2-skipped`，并提示用户：关键缺陷建议事后补做 L2 陪审以提升精度

**严重度分歧指数 SDI**（仅基于 confirm 票的 severity 计算；reject/uncertain 不参与 SDI）：<!-- fix: minor-sdi-priority --><!-- fix: R2-IF-001 -->

```text
severity值: blocking=3, major=2, minor=1, suggestion=0
SDI = max(confirm 票 severity 集合) - min(confirm 票 severity 集合)
若 SDI ≥ 2 → 立即升级人工（ESCALATED_HUMAN，§4.5），不论投票分布
```

**SDI 优先级（统一规则，消除"且仅1人confirm"与"覆盖c≥2"的分歧）**：**SDI≥2 时，不论投票分布如何，一律改判 `ESCALATED_HUMAN`（§4.5）**，由人工裁决严重度。
- SDI 计算要求 confirm 票数 c≥2（否则 severity 集合只有 0 或 1 个元素，max−min 恒为 0）；因此"SDI≥2"隐含"c≥2"，不再附加"且仅1人confirm"等额外条件。
- **判定顺序**：先按上方投票分布表得出初步判定 → 再计算 SDI → 若 SDI≥2，**覆盖**初步判定为 `ESCALATED_HUMAN`。**例外（精简模式）**：无 L2 投票时跳过投票分布表（见上方精简模式分支），直接按下方"精简模式下的 SDI"规则计算并判定<!-- fix: L1-R1-B-001 -->。
- 示例：投票 (confirm=blocking, confirm=minor, confirm=major) → 投票分布表判 CONFIRMED(max=blocking)，但 SDI=3−1=2 → 改判 **ESCALATED_HUMAN**。
- 示例：投票 (confirm=blocking, confirm=blocking, confirm=minor) → 投票分布表判 CONFIRMED(max=blocking)，SDI=3−1=2 → 改判 **ESCALATED_HUMAN**。

> **设计意图**：高分歧（如一人判 blocking、一人判 suggestion）意味着缺陷虽被多数确认，但**严重度无法机械收敛**——强行走投票分布表取 max 会掩盖严重度争议。SDI≥2 是"机械聚合对严重度失灵"的信号，必须交人工裁决严重度（而非简单确认或丢弃）。

**精简模式下的 SDI**：<!-- fix: R2-minor-sdi-lean --> 精简模式无 L2 陪审，SDI 基于 L1 各 Agent 与 P3-full 复查中**对该缺陷给出 confirm 判定的严重度**计算（样本数可能 <3，按实际可用 confirm 票取 max−min）；confirm 票不足 2 时 SDI 不适用（不触发升级），按 §3.7 精简模式分支的 `CONFIRMED_NO_JURY` 规则处理。SDI≥2 同样触发 `ESCALATED_HUMAN`。

## 四、循环与收敛（替代固定轮数）

### 4.1 何时做下一轮？

不是预设"2-3轮"，而是基于**统计信号**判断：

**每轮结束后执行收敛判定**（见§4.2）。若收敛→STOP；否则→CONTINUE进入下一轮（回到L1）。**触发点（L1-R1-B-009）**：收敛判定在 P3-full 完成后、且 §4.2.x 状态持久化（写入 `rounds[k]`）**之后**显式触发；判定前先重读状态文件核对该轮数据已落盘（避免异步写丢失导致基于过期数据判定）。

### 4.2 双轨停止准则

**Track A（总量轨道）**：Chapman捕-再捕估计 + NHPP Goel-Okumoto MLE

**符号表**（本节及 §七 公式通用）：<!-- fix: L1-ZU-007 -->
- M₁ = "捕"轮发现的缺陷集合大小（收敛判定时取**上一轮 k−1**）
- M₂ = "再捕"轮发现的缺陷集合大小（收敛判定时取**当前轮 k**）
- m₁₂ = 这两轮共同发现（重捕）的缺陷数，m₁₂=0 触发硬禁止收敛
- N̂ = 文档总体缺陷数的 Chapman 估计值
- D_k = 截至第 k 轮的累计发现数
- â、b̂ = NHPP Goel-Okumoto 的 MLE 估计（尺度、形状）——**实现见 §七·NHPP MLE 伪代码**
- t_k = 截至第 k 轮的累计工作量/时间
- ρ̄ = 平均同源相关系数（用于 n_eff）——**默认值 unvalidated_prior，见 §5.1**
- n_eff = 有效独立样本数 = n·(1−ρ̄)——**Track B 严重度 0 观察上界 U 的分母（§七 Rule of Three），不是 Chapman 的输入**<!-- fix: R1-IG-001 R1-IG-008 R1-FU-008 -->

> **dead symbol 已删除（R1-FU-008）**<!-- fix: R1-FU-008 -->：先前的 `M_k`（"当前轮发现数，滑动窗口下 = M₂"）与 M₂ 重复定义且正文不再使用，已从符号表移除。所有引用 M_k 处统一改为 M₂（滑动窗口当前轮）或 D_k（累计）。

> **滑动窗口说明**：M₁/M₂/m₁₂ 是**滚动两轮窗口**，每轮收敛判定时重新计算（M₁=第 k−1 轮，M₂=第 k 轮），**不是固定指"第1轮/第2轮"**。第 1 轮结束后（尚无上一轮可比）跳过收敛判定，直接 CONTINUE 进入第 2 轮；从第 2 轮起每轮都用"上一轮 vs 当前轮"计算。<!-- fix: R2-minor-sliding-window -->

**计算（含借用声明，R1-FU-001/R1-FU-005 修复）**<!-- fix: R1-FU-001 R1-FU-005 -->：
$$m_{12} = |\text{本轮发现} \cap \text{上轮发现}|$$

若 $m_{12}=0$ → **硬禁止宣布收敛**（不可识别，必须继续）

$$\hat{N}_{\text{Ch}} = \frac{(M_1+1)(M_2+1)}{m_{12}+1} - 1$$

$$\text{Var}(\hat{N}) = \frac{(M_1+1)(M_2+1)(M_1-m_{12})(M_2-m_{12})}{(m_{12}+1)^2(m_{12}+2)}$$

> **⚠️ Chapman 借用声明与局限（R1-FU-001）**：Chapman (1951) 捕-再捕估计**假设封闭种群（population closed）**——两轮采样期间总体缺陷数 N 恒定。但本方法论 §3.4 P2 修复循环每轮可能修改文档（修复缺陷 → 缺陷池缩小；引入新缺陷 → 缺陷池扩张），违反封闭假设。
> - **近似成立条件**：当本轮 P2 修复的缺陷数 / 累计发现数 < 10% 时，封闭近似可接受；超出此比例则 Chapman 估计偏差大。
> - **状态文件 schema 补字段**：§4.2.x 状态 schema 新增 `p2_modified_count`（每轮 P2 修改的缺陷数），收敛判定时若 `p2_modified_count / D_k > 0.1` → 标注 `chapman_violation=true`，N̂ 仅供方向参考。
> - **回退方案**：违反封闭假设时改用 **Jolly-Seber (1965) 开放种群模型**（允许出生/死亡/迁移），或退化为"前 N 轮发现曲线 + Laplace 趋势检验"（不需要封闭假设，但精度更低）。
> - **自指审查特殊场景**：审查对象是会自我修改的方法论文档时（如本 Skill 审自己），P2 修复直接改写文档 → m₁₂ 结构性压向 0（跨轮 id 不一致 + 描述文本变化），此时 Chapman 失效，**应直接走 ESCALATE_HUMAN 强制收口**（见记忆 `skill-v2-self-audit-structural-nonconvergence`）。

> **⚠️ Goel-Okumoto NHPP 借用声明（R1-FU-005）**：Goel-Okumoto (1978) 原为**软件可靠性 NHPP 模型**，假设"缺陷发现率随时间衰减（b̂>0）"来自用户使用暴露缺陷的过程。文档审查场景中 Agent 主动审查、缺陷可见性受 prompt 影响，"发现率衰减"假设**需论证而非默认成立**。
> - **可类比情形**：高权重维度优先分配 Agent、Prompt 复用导致同源盲区 → 后续轮次新发现确实递减 → b̂>0 成立。
> - **不可类比情形**：每轮拉丁方轮换底座 + Prompt 重写 → 缺陷可见性每轮重置 → 衰减假设失效。
> - **回退**：b̂ 拟合出现负值或近 0 时，标注 `nhpp_b_invalid=true`，Track B 仅供方向参考。

Track A OK条件（**严格 <**，等号不成立，R1-IG-009 统一<!-- fix: R1-IG-009 -->）：$\hat{N} - D_k < 0.1 \times D_k$ 且 95% CI上界 < $D_k + 0.1D_k$（严格 <）

**95% CI 上界计算方法（L1-R1-A-003）**：采用正态近似 CI_upper = N̂ + 1.96·√Var(N̂)（Var 见上式）。当 m₁₂ 过小或累计轮次 <3 导致 Var 失真时，CI 不可靠，**不以 CI 作收敛依据**，改由 §4.3 小样本屏障兜底，并在报告元数据标注 `ci_unreliable`。

**Track B（严重度轨道）**：独立NHPP拟合严重度≥S2的缺陷。**S2 定义 = blocking + major 合并**（severity∈{blocking, major}，对应数值 3 和 2）；minor/suggestion 不计入 Track B。<!-- fix: L1-ZU-004 -->

Track B OK条件：期望剩余严重缺陷 < 1 且 **严重度 0 观察 95% 上界 U < 2**——**U 的正确公式见 §七 Rule of Three：U ≈ −ln(0.05)/n_eff = 3/n_eff**（先前 §七 `U≈3/(1−e^(−n_eff))` 恒 ≥3 永远无法 <2，已修复<!-- fix: R1-IG-001 -->）。当 n_eff ≤ 1.5 时 U ≥ 2 → Track B 不 OK（必须继续）；n_eff ≥ 2 时 U=1.5 <2 → 可 OK。

**STOP 条件统一（R1-IG-005/R1-ZL-018 修复）**<!-- fix: R1-IG-005 R1-ZL-018 -->：

```
STOP = Track A OK ∧ Track B OK ∧ 轮次 ≥ 3 ∧ 总发现 D_k ≥ 10 ∧ 轮次 ≤ 15
```

任一不满足 → CONTINUE；轮次 > 15 → **强制 STOP**（输出 §六 报告，标注 `converged=forced_by_rounds_cap`）。

- 单轨不 OK → CONTINUE 进入下一轮
- Track A 连续 3 次失败 或 Track B 连续 2 次失败 → 进入 **ESCALATE_HUMAN_PROTOCOL（§4.5）**，后继状态机见 §4.5.x
- §4.3 屏障 ASCII 的 `总轮次<3 或 总发现<10` 是本 STOP 条件的**前置硬约束**，不重复——满足 §4.3 后才允许进入 STOP 判定

**小样本调和的真正含义（L1-R1-C-006 + R1-FU-004 修正）**<!-- fix: R1-FU-004 -->：轮次 ∈ [3,4] 时 NHPP MLE 方差大（见下方警告，可靠区间 ≥5 轮）。**先前的"调和"措辞误导——加严判定条件并不消除 NHPP 在 <5 轮的统计风险，只是"接受风险但提高宣布 STOP 的门槛"**。具体：
- Track A/B 的 OK 判定在轮次 ∈ [3,4] 时强制标记 `provisional`，须额外满足 **当前轮 m₁₂ > 0 且 N̂ 较上一轮收敛判定值的波动 ≤10%** 方可正式宣布 STOP；否则 CONTINUE。
- 轮次 ≥5 后 NHPP 判定可信，移除 `provisional` 标记。
- **若统计严谨性优先**：将最低轮数从 ≥3 上调至 ≥5（与 NHPP 可靠区间对齐），但代价是精简模式成本从 21 调用升至 35 调用。本 Skill 默认 ≥3 + provisional 调和，用户可在 §0.x 显式选择 `min_rounds=5` 模式。

> ⚠️ **NHPP 小样本警告**：NHPP Goel-Okumoto MLE 拟合在累计轮次 <5 时统计可靠性低（â、b̂ 方差大，CI 过宽），此时 Track A/B 的"OK"判定仅供方向参考；硬性收敛以 §4.3 小样本屏障（≥3轮）和 m₁₂=0 硬禁止规则为最终准绳（轮次 3-4 的正式 STOP 附加条件见上"小样本调和"）。<!-- fix: L1-ZU-003 -->

### 4.2.x 执行模型说明（多轮往返与会话恢复）

本Skill的"轮"是**会话级循环单元**，每轮包含多次工具调用 + 子会话等待 + 聚合，通常超出单个 LLM 回复窗口。执行要求：<!-- fix: L1-ZU-001 -->

- **跨窗口执行**：若单个回复窗口无法完成≥3轮，必须在窗口结束前将当前进度（已完成的轮次 k、各 Agent 产出、L1/L2 聚合结果、Track A/B 状态）持久化（见下方"状态持久化"），下一轮回复窗口从持久化状态继续，不得重置轮次计数。
- **状态持久化（R2-LG-011）**：<!-- fix: R2-LG-011 -->
  - **状态文件路径**：`.context/state/verification-v2-state.json`（相对于当前会话 cwd）。跨会话恢复时优先读会话级，回退工作区级 `.context/state/`。
  - **必填字段 schema**（v2.5.1 整合 p2_modified_count / carryover_defects / doc_concurrently_modified，P3-full-R1 major 修复<!-- fix: P3-R1-major-S1-schema -->）：
    ```json
    {
      "skill_version": "<当前 SKILL.md frontmatter 版本，如 2.5.3——不要硬编码，读 frontmatter>",
      "doc_hash": "<原始文档 sha256 前 16 位>",
      "doc_name": "<文档名>",
      "rounds_completed": 0,
      "current_round_in_progress": false,
      "rounds": [
        {
          "k": 1,
          "l1_sessions": ["sid1","sid2","sid3"],
          "l1_findings_agg": [<聚合后缺陷候选池>],
          "p2_fix_session": "sid_fix",
          "p2_verify_session": "sid_verify",
          "p2_verify_passed": true,
          "p3_full_session": "sid_p3",
          "p3_full_findings": [],
          "l2_sessions": [],
          "l2_votes": [],
          "track_a": {"M1":null,"M2":null,"m12":null,"N_hat":null,"ci_upper":null,"ok":null},
          "track_b": {"ok":null},
          "confirmed_defects_round": [{"id":"R1-IG-001","severity":"major"}],
          "p2_modified_count": 0,
          "doc_hash_observed": "<第 k 轮派发前原文 sha256>",
          "doc_concurrently_modified": false
        }
      ],
      "confirmed_defect_ids_all": [],
      "carryover_defects": [],
      "chapman_violation": false,
      "updated_at": "<ISO8601>"
    }
    ```
  - **写入时机**：每轮 L1 聚合后、P2 验证后、P3-full 后、收敛判定后各**增量更新一次**（JSON 无原生部分写入，采用 read-modify-write：读取现有文件 → 仅更新 `rounds[k]` 等目标字段 → 整体原子写回；写回前先备份旧文件为 `verification-v2-state.json.bak`）<!-- fix: L1-R1-A-007 -->。
  - **损坏检测规则**（读取后先校验，任一失败视为损坏）：
    1. 文件非空且能 JSON parse；
    2. `skill_version` 与当前版本一致（不一致 → 标注 `recovery=version_mismatch`，人工确认是否复用历史发现）；
    3. `doc_hash` 与当前文档 sha256 匹配（不匹配 → 文档已变更，标注 `recovery=doc_changed`，按 §4.5 "补料"流程处理：复用历史发现但重做受影响维度，P3-light 重做判断见 §4.5 R2-LG-001）；
    4. `rounds_completed == len(rounds)`（计数一致性）；
    5. `confirmed_defect_ids_all` 是各 `rounds[k].confirmed_defects_round[].id` 的并集（去重一致性）。
  - **重计去重**：若状态损坏不可信、需从第 1 轮重计时，**必须按 defect id 去重**——已记录在 `confirmed_defect_ids_all` 中的缺陷**不重复计入**新轮次的"新发现 D_k"，避免 D_k 虚高污染 Chapman 估计。重计首轮的"新发现" = 本轮 L1 聚合结果 − `confirmed_defect_ids_all`（按 id 集合差集）。
- **中断恢复**：会话中断后重启时，先按"损坏检测规则"校验状态文件：校验通过 → 从断点轮次继续（`rounds_completed` 即已完轮数，进行中的循环恢复或丢弃重做）；校验失败（文件不存在或损坏）→ 报告元数据标注 `recovery=unknown`（文件缺失）或 `recovery=corrupted`（校验失败），从第 1 轮重计并按"重计去重"处理已知缺陷。
- **轮次定义**：1轮 = 1次完整的 L1→P2修复→P2验证→P3-full 循环；轮次计数以**已完成的完整循环数**为准，进行中的循环不计入。

### 4.2.y 实时并发写协议（R7B 场景，P3-full-R1 blocking 修复）<!-- fix: P3-R1-blocking-S5 -->

> **问题背景**：v2.4.0 / v2.5.0 早期版本的 `doc_hash` 仅用于**中断恢复**的损坏检测，**不处理审查进行中目标文档被另一会话并发改写**。R7B 实战（2026-08-04）记录：自指审计 SKILL.md 时并行会话执行自己的 meta-review 后把目标从 v2.3.0 改写为 v2.4.0，导致 L1 子会话审旧版、当前磁盘是新版，doc_hash 前后不一致但管线无检测机制。

**实时并发写检测 SOP**（所有审查场景适用，自指审查尤其关键）：

1. **审查前快照**（启动 §〇 时执行）：对原始文档 `sha256sum` + `wc -l` + 关键章节首行摘录（前 5 行 + 各主章节标题行），写入快照文件。**快照路径选择（R2-ZL-023 修复）**：
   - **短文档（<30K 字符，message body 限制内）**：父会话在每次 `send_message` 派发 L1 子会话时**将快照全文内联到 prompt** 中（最可靠，无跨会话路径依赖）
   - **长文档（≥30K 字符）**：写入**工作区级共享目录** `C:\Users\sir_c\.proma-pro\agent-workspaces\default\workspace-files\.audit-snapshots\<doc-name>-<version>-snapshot.md`（workspace-files 是 Proma 工作区共享空间，所有同工作区会话可见），L1 子会话用绝对路径 Read
   - 若工作区级目录不可写 → 降级为"读 live doc + 加 doc_hash 校验"，标注 `snapshot_unavailable=true`
2. **每轮 L1 派发前**：re-`sha256sum` 原文档，与快照比对：
   - 一致 → 派发 L1
   - 不一致 → 标注 `doc_concurrently_modified=true`，**停线决策**：本轮尚未开始 → 重新快照重启本轮；本轮 L1 已运行 → 让在途子会话基于旧快照完成，但**本轮收敛判定降级为 `provisional_small_sample`**
   - **派发后立即再验（R2-IG-003 / R2-ZL-025 缓解）**：`send_message` 完成后再次 `sha256sum`，若派发前后哈希不一致 → 该轮 L1 结果标注 `doc_concurrently_modified=true`（缩短 TOCTOU 窗口，虽无法消除）
3. **每轮聚合后**：再次比对 doc_hash，记录到状态文件 `rounds[k].doc_hash_observed`。
4. **字段拆分（R2-ZL-024 / R2-IG-004 修复）**<!-- fix: R2-ZL-024 R2-IG-004 -->：原 `p2_modified_count` 拆为两个字段：
   - `p2_modified_count`：本轮 P2 修复 Agent **主动修改**的缺陷数（操作定义：P2 fix 后 diff 出现 `<!-- fix: -->` 标记的缺陷计数）
   - `p2_concurrent_changes`：本轮检测到的**并发会话修改次数**（操作定义：派发前后 sha256 不一致即 +1）
   - Chapman 借用判据：`(p2_modified_count + p2_concurrent_changes) / D_k > 0.1` → `chapman_violation=true`
   - 当 `doc_concurrently_modified=true` → Chapman N̂ 仅供方向参考，最终走 ESCALATE_HUMAN_PROTOCOL 强制收口
5. **分级响应（R2-ZL-036 修复）**<!-- fix: R2-ZL-036 -->：并发写分级——`doc_concurrently_modified=cosmetic`（变更限于附录/变更记录等非审查目标）→ 不触发 ESCALATE；`=content_minor`（<10% 内容变化）→ 本轮 provisional + 下轮重快照继续；`=content_major`（≥10%）→ ESCALATE_HUMAN_PROTOCOL
6. **报告披露**：报告"方法论元数据"段必须包含 `doc_hash_round_<k>=<hash>` + `doc_concurrently_modified=none|cosmetic|content_minor|content_major` + `audit_based_on=snapshot_inline|snapshot_workspace_files|live_doc`。

### 4.3 小样本保护 — 强制执行

```
┌─────────────────────────────────────────────┐
│ ⛔ 屏障：此处检查轮次。不足3轮 = 立即返回L1 │
│                                             │
│ if (总轮次 < 3 或 总发现 < 10):              │
│    立即终止当前输出。                           │
│    跳到 §3.3。创建新L1子会话。开始下一轮。      │
│    不输出§六报告。不分析。不总结。EXECUTE。     │
│                                             │
│ if (总轮次 ≥ 15):                            │
│    STOP。输出§六报告。                          │
└─────────────────────────────────────────────┘
```

这不是"建议CONTINUE"。这是一条可执行指令——你读到此处时，如果轮次<3，你的下一个动作是**回到§3.3创建子会话**，不是写报告。

### 4.4 成本感知最优停止（参考，不硬制）

$$k^* = \frac{\ln(L\hat{a}\hat{b}/c)}{\hat{b}}$$

L=单缺陷漏检损失，c=单轮成本。k*仅展示，不与硬阈值冲突。

### 4.5 升级人工协议（ESCALATE_HUMAN 触发后）

当 §4.2 双轨连续失败、§3.4 重试耗尽、§3.5 P3-full 回退耗尽或 §3.7 SDI≥2 触发升级时，管线进入 ESCALATE_HUMAN 状态。Agent 必须执行以下行为，**不得静默退出或编造收敛**：<!-- fix: L1-LG-001 -->

1. **暂停管线**：停止创建新子会话，冻结当前轮次状态，不再推进 STOP 判定。
2. **生成升级报告**，必须包含：
   - 触发条件（命中哪条规则，附原始数值：Track A/B 当前估计、CI 上界、连续失败次数）
   - 已完成轮次 k 及每轮发现数 D_k
   - 未收敛证据（为何不能宣布 STOP）
   - 已尝试的修复/重试/回退历史
   - 待人工裁决的关键缺陷清单（按 severity 排序）
3. **列出未决缺陷**：所有 CONFIRMED/ESCALATED/DISPUTED 状态的缺陷逐条列出，标注为何 Agent 无法自行收敛（ESCALATED 标注 `needs_confirm`，DISPUTED 标注 `disputed`，见 §3.7 L1-R1-B-007）。
4. **等待用户输入（含超时实现与 Acknowledge 确认）**：明确请求用户给出以下任一指示——**统一为 3 类**（R1-FU-012 修复<!-- fix: R1-FU-012 -->）：
   - **类 A「补料/调整」**：补充上游文档、调整验收标准、提供额外审查资源、修正文档边界（4 种操作归并为一类——均涉及审查输入变化，触发 L1 新一轮 + P3-light 重做判定）
   - **类 B「指定人工裁决」**：用户对具体缺陷给出 confirm/reject + severity 裁决（按 §4.5 注入规则）
   - **类 C「强制 STOP」**：接受已知风险并终止管线
   - **30min 墙钟超时 + 实现方式（R1-IG-006/R1-ZL-002 修复）**<!-- fix: R1-IG-006 R1-ZL-002 -->：自升级报告发出起计时 30 分钟（1800s）。**回合制 Agent 无内建定时器**，实现方式：调用 `ScheduleWakeup(delaySeconds=1800, reason="ESCALATE_HUMAN 30min 超时检查", prompt="<重新进入 §4.5 检查用户是否已响应>")` 注册延迟唤醒；唤醒时检查 `list_messages(本会话)` 末条用户消息时间戳是否在升级报告之后——若否（用户未响应）→ **自动转入"强制 STOP"分支**，输出 §六 报告，元数据标注 `converged=forced_by_timeout`，并在报告显著位置标注"⚠️ 用户未响应，已超时强制收口"。**若环境无 ScheduleWakeup**：标注 `timer_primitive_unavailable=true`，回退为"每次用户消息后检查累计墙钟时间"，失去自主超时能力。**与在途子会话的协调（L1-R1-C-003）**：进入 §4.5 前先确认所有在途子会话已收敛（等待完成或按 §3.3.1 超时规则回收 partial 产出，上限 15min）；30min 计时**仅覆盖"等待用户响应"**，不含子会话回收时间。
   - **Acknowledge 确认机制**：收到用户响应后，Agent **必须先回显确认**——用一句话复述并归类用户指示到上述 3 类之一，等用户确认归类无误后再执行。**外层超时与循环上限（L1-R1-B-003 + R2-IG-002 修复）**<!-- fix: R2-IG-002 -->：Acknowledge 回显-纠正循环**必须在 30min 总墙钟预算内完成**——单轮确认等待 **5min（300s）**（不是 10min，避免 2 次循环 + 用户响应 > 30min 总上限）；最多 2 次循环（合计 ≤10min）+ 用户响应 ≤5min + 归类执行 ≤15min = 30min 预算内；第 2 次仍被否 → **停止猜测归类**，直接请求 3 类明确指示；累计达到 30min 墙钟超时 → 直接进入"强制 STOP"分支。所有等待用 `ScheduleWakeup(delaySeconds=300, ...)` 实现。
   - **多轮升级防死循环（R1-ZL-020 + R2-ZL-029 修复）**<!-- fix: R1-ZL-020 R2-ZL-029 -->：**纯计数规则**——累计触发 ESCALATE_HUMAN_PROTOCOL **≥3 次**（不论用户每次选何类，仅计触发次数），第 3 次触发时**强制 STOP**，除非用户在第 3 次主动选类 C（强制 STOP，元数据 `converged=forced_by_human`）。元数据标注 `converged=forced_by_escalation_cap`，附完整未决缺陷清单。**先前"用户每次都选类 A 继续小改"语义模糊**（"每次都"是连续还是累计？"小改"如何判定？）已废弃，改为机械可判定的纯计数。
5. **用户响应后的恢复路径**：
   - **用户补料/调整** → 回到 §3.3 L1 开启新一轮（**轮次计数延续，不重置**）。**P3-light 是否重做判定（R2-LG-001）**：<!-- fix: R2-LG-001 -->
     - 补料**涉及核心使用场景**（新增/修改/删除了 P3-light 提取的场景、改变场景关键检查点、或改变了文档边界）→ **必须重做 P3-light**，重新提取场景-维度映射，再进入 L1；同时状态文件 `doc_hash` 更新（见 §4.2.x）。**"文档边界"操作性判定（L1-R1-A-004）**：对补料前后 §一"适用/不适用"声明与章节目录结构做逐项 diff——任一变化（新增/删除/合并章节、适用性声明变化）即视为"改变了文档边界"。
     - 补料**仅涉及非场景性内容**（措辞修正、局部细节补充、不改变核心场景与边界）→ **复用首轮 P3-light 场景映射**，直接进入 L1，不重做 P3-light（节省调用）。
     - **判断不明时，保守重做 P3-light**（成本低，避免漏检场景变化）。
   - **用户强制 STOP** → 输出 §六 报告，元数据标注 `converged=forced_by_human`，附已知缺陷清单。（注：此分支豁免 §六检查清单第 6 项的"ESCALATE_HUMAN 不输出报告"约束，见 §六 R2-LG-002。）
   - **用户指定人工裁决** → 将裁决结果按下方 schema 提取，**单向注入** L3 重聚合（R1-IG-004/R1-ZL-014 修复，**废弃**先前"1c+1r 对立注入"规则——该规则在原 L2 c≥2 时仍判 CONFIRMED 而非 DISPUTED，且原 c=1,r=2 + reject 反致 c≥2 CONFIRMED，产生人工否决被反转悖论）。**裁决 JSON schema 与注入规则（R2-LG-003 + R1-IG-004）**：<!-- fix: R2-LG-003 R1-IG-004 R1-ZL-014 -->
     ```json
     {
       "defect_id": "R1-IG-001",
       "human_verdict": "confirm | reject",
       "human_severity": "blocking | major | minor | suggestion",
       "reasoning": "<人工裁决理由>",
       "authority": "human"
     }
     ```
     **用户必须按此 schema 提供结构化裁决（禁自由文本自然语言，否则需 §4.5 管线执行 Agent 先用 LLM 转换——此时 L3 入口数据本身仍是结构化的，§3.7 "L3 不使用 LLM" 不被违反<!-- fix: R1-IG-012 -->）**。
     - **注入规则（单向，不再注入对立票）**：
       - `human_verdict=confirm` → 注入 **1 张 confirm 票**（severity = `human_severity`），不注入 reject 票
       - `human_verdict=reject` → 注入 **1 张 reject 票**，不注入 confirm 票
     - **状态判定（独立分支，不参与 §3.7 投票分布表的 c≥2 常规分类）**：经人工裁决注入的 defect **直接标记为 `ARBITRATED`**（新增状态），与原 L2 投票合并后**仅作 trace 展示**，不改变 `ARBITRATED` 主标签。这样避免"对立票注入产生分类悖论"，且人工裁决的权威性由 `ARBITRATED` 标签独立体现。
     - **严重度处理**：`human_verdict=confirm` 时，最终 severity = `human_severity`；`human_verdict=reject` 时，defect 终态为 `ARBITRATED_REJECTED`（保留原 L2 severity 作 trace），实际不入"确认缺陷"表，入"经人工裁决"段。
     - **与 SDI 的关系**：人工 confirm 票参与 SDI 计算（与原 L2 confirm 票合并）；若 SDI≥2，状态升级为 `ESCALATED_HUMAN_SDI` 并标注 `arbitrated_by=human`（不再二次请求人工，仅报告明示分歧）。
     - **最终标注**：经人工裁决的 defect 在报告"经人工裁决"段单列，标注 `arbitrated_by=human` + `human_verdict` + `human_severity`。

### 4.5.x ESCALATE_HUMAN_PROTOCOL 后继状态机（R1-ZL-012/013/015/016/017/019 修复）<!-- fix: R1-ZL-012 R1-ZL-013 R1-ZL-015 R1-ZL-016 R1-ZL-017 R1-ZL-019 -->

**问题背景**：v2.4.0 §4.5 只定义"等待用户输入"，但 6 种触发 ESCALATE_HUMAN_PROTOCOL 的入口缺陷**各自终态未定义**，导致状态机不闭环。本节给出所有触发入口的缺陷在用户响应后的终态。

| 触发入口 | 触发条件 | 缺陷初始状态 | 用户类 A 响应（补料/调整） | 用户类 B 响应（指定裁决） | 用户类 C 响应（强制 STOP） | 30min 超时 / 第 3 次升级 |
|---------|---------|------------|-----------------------|---------------------|---------------------|----------------------|
| **E1：ESCALATED（c=1∧u≥1）** | §3.7 投票分布 | `ESCALATED(needs_confirm)` | 转入新一轮 L1 重审；本轮 ESCALATED 标签保留为 `escalated_historic` 不参与新轮聚合 | 按 §4.5 注入规则转 `ARBITRATED` | 进 §六 报告"需人工判断"段，状态保留 `ESCALATED` | 强制 STOP，进报告 `ESCALATED` 段 |
| **E2：DISPUTED（c=1∧r=2）** | §3.7 投票分布 | `DISPUTED(disputed)` | 同 E1 | 按 §4.5 注入规则转 `ARBITRATED`（人类打破争议） | 进报告"需人工判断"段，状态保留 `DISPUTED` | 强制 STOP，进报告 `DISPUTED` 段 |
| **E3：SDI≥2 升级** | §3.7 SDI 规则 | `ESCALATED_HUMAN_SDI` | 同 E1 | 按 §4.5 注入规则转 `ARBITRATED`，标注 `sdi_history=high` | 进报告"SDI 分歧"段 | 强制 STOP，进报告 `ESCALATED_HUMAN_SDI` 段 |
| **E4：P2 重试耗尽** | §3.4 三检重试 ≤2 次失败 | 未修复缺陷 `P2_EXHAUSTED` | 新一轮 L1 视该缺陷为"已知未修复"，加入 `carryover_defects` 列表，**新一轮 P2 必须先尝试修复 carryover**（不算新发现，不重置 D_k） | **不适用**（R2-IG-001 修复<!-- fix: R2-IG-001 -->：用户给修复文本属类 A 补料，非类 B 裁决）→ Acknowledge 引导用户改选类 A 或类 C | 进报告"未修复缺陷"段，标注 `p2_unfixed=true` | 强制 STOP，进报告 `P2_EXHAUSTED` 段 |
| **E5：P3-full 回退耗尽** | §3.5 回退 ≤1 次仍有 blocking | 新发现 blocking `P3_BLOCKING_UNRESOLVED` | 新一轮 L1 视为已知问题，加入 carryover | **不适用**（同 E4）→ 引导改选类 A 或类 C | 进报告"未解决 blocking"段 | 强制 STOP |
| **E6：Track A/B 连续失败** | §4.2 连续 3 次/2 次 | 全部已发现缺陷 `TRACK_FAILED` | 新一轮 L1（轮次计数延续），**不重置 Track 失败计数**（达到上限再升级直接强制 STOP） | **不适用（统计问题非缺陷级）→ Acknowledge 引导用户改选类 A（补料：增加轮次/换底座）或类 C（强制 STOP）**<!-- fix: P3-R1-minor-S4-E6B --> | 进报告，标注 `track_a_failed=N` / `track_b_failed=N` | 强制 STOP |

**关键约束**：
- **轮次计数延续**：所有"用户类 A 响应→新一轮 L1"的分支**不重置轮次计数**（§4.5 已有规则），但仍受 §4.2 STOP 总上限 ≤15 轮约束。
- **carryover_defects 字段**：§4.2.x 状态 schema 新增 `carryover_defects`（未修复缺陷 id 列表），新一轮 L1 聚合时**先扣除 carryover**（避免重复计入 D_k），P2 阶段优先处理。
- **强制 STOP 分支统一**：所有"强制 STOP"都输出 §六 报告，元数据 `converged=forced_by_*`，附完整未决缺陷清单（含初始状态 + 触发入口 + 用户响应或超时记录）。
- **后继状态闭环验证**：本表覆盖所有 6 种触发的全部 3×6=18 个转移分支 + 超时分支，状态机无死胡同。

## 五、Agent部署要求

### 5.0 阶段间门控（强制执行）

每个阶段开始前，确认前一阶段**全部Agent已完成**：

| 阶段转换 | 必须执行 | 失败处理 |
|---------|---------|---------|
| P3-light → L1 | P3-light完成 | 重试P3-light |
| L1搜索 → L1聚合 | `list_messages` 轮询确认所有L1子会话产出（§3.3.1 三层门控）<!-- fix: L1-ZU-002 --> | 超时→标记该维度失败，继续 |
| L1聚合 → P2修复 | L1聚合完成 | — |
| P2修复 → P2验证 | P2修复完成 | — |
| P2验证 → P3-full | P2验证通过（三检全过） | 未过→重试P2修复(≤2次)→ESCALATE_HUMAN（§4.5）<!-- fix: minor-gate-table --> |
| **P2验证 → P2修复（重试）**<!-- fix: R2-LG-004 --> | P2 验证三检未全过（§3.4），基于增量基线重试 | 重试 ≤2 次耗尽 → ESCALATE_HUMAN（§4.5）；增量基线规则与 schema 见 §3.4 L1-R1-B-005 |
| P3-full → 收敛判定 / L2 | P3-full完成 + §4.2.x 状态持久化（收敛判定前重读状态文件核对该轮数据已落盘，L1-R1-B-009）（精简模式→收敛判定；完整模式→L2陪审）<!-- fix: minor-gate-table --> | 重试P3-full；P3-full↔P2回退耗尽→ESCALATE_HUMAN（§3.5/§4.5） |
| **P3-full → P2（回退）**<!-- fix: R2-LG-004 --><!-- fix: L1-R1-B-004 --> | P3-full 发现 blocking 新发现（§3.5） | 回退 P2（≤1 次）；回退后仍有 blocking 新发现 → ESCALATE_HUMAN（§3.5/§4.5）；回退循环总超时 60min（L1-R1-B-006） |
| L2陪审 → L3聚合（完整模式） | `list_messages` 轮询确认 3 陪审员投票完成<!-- fix: minor-gate-table --> | 超时→缺失陪审员按 `uncertain` 处理 |
| L3聚合 → 收敛判定 / 输出 | L3 机械聚合完成（精简模式产出 `CONFIRMED_NO_JURY`，见 §3.7 精简模式分支）<!-- fix: R2-minor-gate-no-jury --> | — |
| **L3聚合 → ESCALATE_HUMAN（SDI 升级）**<!-- fix: R2-LG-004 --> | 任一缺陷 SDI≥2（§3.7 R2-IF-001） | 进入 §4.5 升级人工协议；其余无 SDI 升级的缺陷继续正常聚合 |
| **收敛判定 → L1（CONTINUE 新一轮）**<!-- fix: R2-LG-004 --> | Track A/B 任一不 OK 且未触发硬禁止/升级 | §4.3 小样本屏障通过 → 开新一轮 L1；**轮次计数延续不重置**；P3-light 复用首轮（§3.2） |

**关键原则**：绝不假设前一阶段已完成。必须显式确认。

**阶段转换日志格式**：每次转换确认后输出一行：
```
[门控] {前阶段} → {后阶段}: {确认方式}, {时间戳}
```
示例：`[门控] L1搜索 → L1聚合: list_messages 轮询(3/3 子会话产出), 18:35`<!-- fix: L1-ZU-002 -->

### 5.1 去相关三级体系

**Tier 全称**：T1=Prompt 级去相关（Tier-Prompt）；T2=型号级去相关（Tier-Model）；T3=厂商级去相关（Tier-Vendor）。<!-- fix: minor-tier-naming -->

| Tier | 手段 | 成本 | 效果（**unvalidated_prior**）<!-- fix: R1-IG-008 --> | 何时用 |
|------|------|:---:|------|--------|
| T1 | 不同Prompt+不同Temperature+信息隔离 | $0 | ρ→0.55* | 所有场景，基线 |
| T2 | 同厂商不同型号切换 | +50% | ρ→0.30* | 预算允许时 |
| T3 | 完全异构厂商（不同LLM家族） | +300% | ρ→0.12* | L2陪审、P2修复/验证 |

> *\* ρ 值为 **unvalidated_prior**（R1-IG-008 修复<!-- fix: R1-IG-008 -->）：先前版本标"基于文献保守先验估计"但未给具体引用——多 LLM 同源相关性研究目前缺乏公认基准，本 Skill 未做实测。**默认值仅供方向参考**，建议执行者用 L1/L2 投票分歧率反向校准（如统计 L1 三 Agent 对同一缺陷的 confirm 一致率，反推 ρ̄）。报告元数据标注 `rho_source=unvalidated_prior` 或 `rho_source=calibrated_by_l2_disagreement`。

**模型→Tier 映射示例表（R1-ZL-006 修复）**<!-- fix: R1-ZL-006 -->：Tier 是抽象去相关等级，实际选模型时按下方规则映射：

| 厂商家族 | T1 槽位（任意 Prompt 隔离） | T2 槽位（同厂商不同型号） | T3 槽位（异厂商） |
|---------|-------------------------|------------------------|----------------|
| DeepSeek | deepseek-v4-pro | deepseek-v4-flash（同家族异型号） | 与 MiniMax/GLM/Claude 等组合 |
| MiniMax | MiniMax-M3 | MiniMax-M2.7-highspeed | 同上 |
| ZLM (智谱) | GLM-5.2 | GLM-4.6V / GLM-5-Turbo | 同上 |
| Anthropic | Claude-Sonnet-5 | Claude-Haiku-4.5 / Claude-Opus-4.8 | 同上 |
| OpenAI | GPT-5.6 | GPT-5.6-Terra / Sol / Luna（同家族异配置） | 同上 |

**映射规则**：
- **T1 槽位**：任意模型 + Prompt 重写 + Temperature 调整（如 0.3 vs 0.7）+ 信息隔离
- **T2 槽位**：与同厂商其他槽位**必须不同型号**（如同为 DeepSeek 家族，T1=pro、T2=flash）
- **T3 槽位**：与 L1 阶段所有其他槽位**必须不同厂商家族**
- 若环境中某家族只有 1 个可用模型（如 Kimi-K3），则该家族只能填 T1 槽位，T2 需选其他家族

**Tier 组合模型（L1-R1-C-005 / C-009）**：表中各 Tier 的 ρ 为**该层单独作用**时的同源相关系数；同一对 Agent 应用多层去相关时，有效 ρ 取**各层 ρ 的最小值**（最去相关层主导），如 T1+T3 → ρ≈0.12。系统级平均同源相关系数 ρ̄ = 各 Agent 对有效 ρ 的平均（用于 §七 n_eff = n·(1−ρ̄)）。核心改进表"ρ→0.12"指 **T1/T2/T3 三级叠加后的系统有效 ρ̄**（≈T3 主导层下限 0.12），与表中 T3 单列"ρ→0.12"是"系统级 vs 单层"两个口径，不矛盾。

### 5.2 最优Agent分配

**默认模式（精简，7调用/轮）**：适用于中低风险文档（每轮调用数；强制≥3轮，3轮最低总成本≈21调用）<!-- fix: L1-IF-002 --><!-- fix: L1-ZU-008 -->

| 阶段 | Agent数 | Tier分配 | 说明 |
|------|:---:|------|------|
| P3-light | 1 | T1 | 任意底座 |
| L1搜索 | 3 | T1×1 + T2×1 + T3×1 | 覆盖6维（每Agent兼顾2维，打包策略见下 L1-R1-C-008；N_vendor≥3 时 3 个 Agent 分配 3 个不同厂商以满足 §3.3，N_vendor=2 时 T3 槽位强制异构并标注 `l1_vendor_span=2`，见 L1-R1-A-001） |
| P2修复+验证 | 2 | 修复T2 + 验证T3 | 异底座强制（N_vendor=1 叠加降级时豁免，见 §5.4） |
| P3-full | 1 | T2 | 与P3-light不同 |
| L2陪审 | 0 | — | 精简模式跳过L2（L1+P3-full结果直接作为终判） |
| L3聚合 | 0(机械) | — | 无LLM |

**维度打包策略（L1-R1-C-008）**：L1 阶段每 Agent 兼顾 2 维的**默认打包**为 **{I+G, F+U, Z+L}**（按 §2.2"高权重维 × 低权重维"交叉配对，负载均衡）；每轮开始时可按 §2.2 当前文档类型权重微调，并在报告标注打包方案；高权重维度优先分配给 T3 异构 Agent（§2.2 权重用途）。

**跨轮底座拉丁方轮换（R7实战 / P3-full-R1 minor 修复）**<!-- fix: P3-R1-minor-S2-latin-square -->：N_vendor≥3 时强制跨轮轮换，避免同一维度对始终用同一厂商（同源偏差累积）。3 轮 × 3 厂商拉丁方示例：
```
Round 1: L1A(I+G)=DeepSeek-pro | L1B(F+U)=MiniMax-M3 | L1C(Z+L)=GLM-4.6V
Round 2: L1A(I+G)=MiniMax-M3   | L1B(F+U)=GLM-4.6V  | L1C(Z+L)=DeepSeek-pro
Round 3: L1A(I+G)=GLM-4.6V     | L1B(F+U)=DeepSeek-pro | L1C(Z+L)=MiniMax-M3
```
每轮底座完全正交（每个维度对在 3 轮中分别由 3 个不同厂商审查），实现 T1+T2+T3 三级去相关系统级 ρ̄≈0.12。状态文件 `rounds[k].l1_sessions` 字段记录每轮实际分配。

**完整模式（10调用/轮）**：适用于高风险文档（安全关键、金融、医疗）或L1/P3-full发现≥3个blocking级缺陷时自动升级（每轮调用数；3轮最低总成本≈30调用）<!-- fix: L1-IF-002 --><!-- fix: L1-ZU-008 -->

| 阶段 | Agent数 | Tier分配 | 说明 |
|------|:---:|------|------|
| P3-light | 1 | T1 | |
| L1搜索 | 3 | T1×1 + T2×1 + T3×1 | 3 个 Agent 分配 3 个不同厂商（L1-R1-A-001） |
| P2修复+验证 | 2 | 修复T2 + 验证T3 | |
| P3-full | 1 | T2 | |
| L2陪审 | 3 | T1×1 + T2×1 + T3×1 | 对L1+P3-full确认的缺陷独立投票确证；3 陪审员之间底座互不相同，与 L1 厂商尽量错开（N_vendor<6 时允许复用并标注 `l2_vendor_overlap`，见 §3.6 L1-R1-C-004） |
| L3聚合 | 0(机械) | — | |

**升级触发条件**（精简→完整）：
- L1聚合后发现 ≥3 个blocking级缺陷
- P3-full发现 ≥5 个major级（含）以上新缺陷
- 用户明确要求"最高审查标准"
- §4.2 Track A 连续2次失败 或 Track B 连续1次失败（统计信号提示精简模式覆盖不足）<!-- fix: minor-upgrade-trigger -->

**触发优先级（L1-R1-B-010）**：以上 4 条**任一满足即触发**升级（OR，无需全部满足）；评估顺序：先统计信号（Track 连续失败）→ 再数量阈值（L1 blocking≥3 / P3-full major≥5）→ 最后用户显式要求；条件命中时机以该轮该阶段结束为准。

**关键**：T3的1个Agent是打破系统性盲区的"异类"，精简和完整模式都必须保留。

### 5.3 信息隔离协议

- **L1各Agent**：完成前互不可见对方输出
- **L2各陪审员**：投票结果完全不可见
- **信息流**：L1→L2→L3 为主链路（前向单向，聚合结果不可反向注入上一阶段）；P2修复↔P2验证、P3-full→P2 的修复回退为**受控反馈环路**，独立于主链路，不改变 L1→L2→L3 的单向聚合方向。<!-- fix: L1-IF-005 -->
- **L3不使用LLM**：纯机械规则聚合
- **P2修复/验证**：必须不同底座

### 5.4 并行降级模式：单Agent顺序执行

> 注：本节的"**并行降级**"（执行环境无法并行子会话）与 §0.3 的"**底座降级**"（厂商异构度不足）是两个独立维度，可单独或同时发生；两者同时出现时报告需分别标注。<!-- fix: L1-IF-003 -->

当执行环境无法创建并行子会话时，执行以下降级管线。

**触发条件对照表（R1-FU-007/R1-ZL-008/R1-ZL-009 修复）**<!-- fix: R1-FU-007 R1-ZL-008 R1-ZL-009 -->：

| 触发场景 | 可观测判定方法 | 进入降级后的差异 |
|---------|-------------|---------------|
| **A：工具缺失** | §0.5 探测协议实测：`create_session`/`send_message`/`list_messages` 任一调用抛错或返回错误码 | 标注 `degradation_trigger=tool_missing`；无法并行子会话 |
| **B：渠道限制** | `list_channels` 返回 `enabled=true` 的渠道 < 3 个，或可用模型集中在 ≤2 厂商 | 标注 `degradation_trigger=vendor_insufficient`；§0.3 底座降级叠加 |
| **C：模型同槽冲突** | 同厂商模型在同一会话期内不可并发（如单 channel rate limit） | 标注 `degradation_trigger=concurrency_limit`；串行执行同厂商 Agent |
| **D：工作边界禁止**（R7 报告建议但 v2.4.0 漏补，R1-ZL-009 修复） | 子会话 brief 含"不要创建新的协作子会话"或父会话工作边界模板禁止 | **优先尝试**：L1 子会话主动通知父会话"需调整工作边界以允许 P2 子 Agent"（§5.4 增强指引，见下方）；若父会话拒绝调整 → 退化为降级模式，标注 `degradation_trigger=work_boundary_forbidden` + `p2_inline=true`（P2 修复改父会话内联执行，失去异底座验证） |
| **E：环境无定时器**（R1-IG-006/R1-ZL-002 衍生） | `ScheduleWakeup` / `CronCreate` / bash sleep 任一不可用 | 标注 `timer_primitive_unavailable=true`；失去 §4.5 自主超时能力，回退被动响应 |

降级管线步骤：

1. **§〇 环境准备**：同上
2. **P3-light**：同上
3. **L1**：同一底座顺序执行六维审查。**信息隔离降级声明（L1-R1-B-002）**：§3.3 要求的"Agent 间完全并行 + 信息隔离"在单底座顺序执行下**无法保持**，显式降级为"**维度内独立分析**"——每个维度在不受其他维度结论影响的前提下独立走查并输出该维完整缺陷，聚合阶段才合并（不得在分析 F 维时引用 I 维的中间结论）。报告元数据标注 `info_isolation=dimension_sequential`，并在报告开头（见下方降级标注）一并说明隔离降级。在报告元数据中标注「⚠️ 并行降级：单底座顺序执行，同源偏差 ρ≈0.55（unvalidated_prior），需异构交叉验证」<!-- fix: L1-IF-003 R1-IG-008 -->
4. **P2 修复**：顺序修复缺陷，不可跳过。**工作边界禁止场景（D）下的处理**：父会话内联执行 P2 修复（不创建子 Agent），标注 `p2_fix_inline=true`，失去 Tier 2 异底座属性
5. **P2 验证**：如工具支持，尝试切换底座验证；否则顺序验证并标注降级。**N_vendor=1 叠加处理（L1-R1-C-002）**：当同时处于 §0.3 底座降级（N_vendor=1），P2 验证**无法满足** §3.4"异底座"要求——此要求显式豁免，改为同底座顺序验证，但验证 Agent 须在 (b) 回归 / (c) 六维复查上**投入独立视角**（不复用修复 Agent 的推理链），报告元数据标注 `base_degraded` + `p2_verify_same_base=true`
6. **P3-full**：顺序走查场景
7. **循环**：§4.3小样本保护规则在降级模式下**同样适用**——轮次<3必须继续，不得因为"无法并行"而跳过第二轮

**降级模式增强指引（R1-ZL-008/R1-ZL-009 衍生）**<!-- fix: R1-ZL-008 -->：当降级由场景 D（工作边界禁止）触发时，L1/P2 子会话若仍可向父会话 send_message，应**主动通知父会话**："为满足 §3.4 异底座要求，需调整工作边界允许创建 P2 验证子 Agent"。父会话收到通知后**应优先调整边界**（解禁子会话创建），而非默认进入降级模式——降级牺牲了方法论最核心的 T3 去相关优势（ρ 从 0.12 升至 0.55），代价显著。

降级模式报告的**开头**必须显式标注：
> ⚠️ 并行降级模式：因执行环境约束（无法创建并行子会话），本次审查为单底座顺序执行。同源偏差 ρ≈0.55，可能遗漏系统性盲区缺陷；信息隔离由"Agent 间"降级为"维度内独立分析"（`info_isolation=dimension_sequential`）。建议用异构模型交叉验证关键发现。<!-- fix: L1-IF-003 --><!-- fix: L1-R1-B-002 -->

---

## 六、输出报告格式

### ⛔ 输出前检查（输出§六格式报告之前必须全部打勾）

```
[ ] 总轮次 ≥ 3？（当前: __ 轮）
[ ] 每轮都执行了L1？
[ ] 每轮都执行了P2修复验证？
[ ] 每轮都执行了P3-full？
[ ] §4.2收敛判定已完成？
[ ] 未处于 ESCALATE_HUMAN 待裁决状态？（若处于→走 §4.5，不输出本报告；**但 §4.5 用户强制 STOP 或 30min 超时强制收口时豁免**——此时应输出本报告并标注 `converged=forced_by_human` / `forced_by_timeout`，附完整未决缺陷清单，见 §4.5 R2-LG-002/R2-LG-009）<!-- fix: minor-output-checklist --><!-- fix: R2-LG-002 -->
[ ] 如果任一未打勾 → 回到Step 2，不要输出此报告
```

如果全部打勾，以下为最终审查报告模板：

```markdown
# 文档审查报告

## 审查概要
- 文档：{名称}
- 审查轮次：{k}轮
- 总发现：{D_k}个
- 确认缺陷：{confirmed}个（blocking: {x}, major: {y}, minor: {z}）
- 需人工判断：{escalated}个

## 确认缺陷（按严重度排序）
### Blocking
| ID | 维度 | 描述 | 位置 | 修复建议 |
|----|------|------|------|---------|
| ... | ... | ... | ... | ... |

### Major
...

## 需人工判断（ESCALATED / DISPUTED / ESCALATED_HUMAN_SDI）<!-- fix: L1-R1-A-008 R1-FU-010 -->
### ESCALATED（证据不充分，待人工确认，`needs_confirm`）
| ID | 维度 | 状态 | 描述 | 位置 | 争议要点 |
|----|------|------|------|------|---------|
| ... | ... | needs_confirm | ... | ... | ... |

### DISPUTED（存在直接争议，待人工裁决，`disputed`）
| ID | 维度 | 状态 | 描述 | 位置 | 争议要点 |
|----|------|------|------|------|---------|
| ... | ... | disputed | ... | ... | ... |

### ESCALATED_HUMAN_SDI（SDI≥2 严重度分歧，`sdi_high`）
| ID | 维度 | 状态 | 描述 | 位置 | 严重度分布 |
|----|------|------|------|------|-----------|
| ... | ... | sdi_high | ... | ... | blocking/minor 等 |

## 经人工裁决（ARBITRATED）<!-- fix: R1-IG-004 R1-ZL-014 -->
| ID | 维度 | human_verdict | human_severity | reasoning | 触发入口 |
|----|------|---------------|---------------|-----------|---------|
| ... | ... | confirm/reject | ... | ... | E1-E6 |

## 未解决缺陷（强制 STOP 时输出，含 P2_EXHAUSTED / P3_BLOCKING_UNRESOLVED / TRACK_FAILED）<!-- fix: R1-ZL-015 R1-ZL-016 R1-ZL-017 -->
| ID | 维度 | 状态 | 描述 | 未解决原因 |
|----|------|------|------|-----------|
| ... | ... | ... | ... | ... |

## 统计信息
- Chapman估计总量：N̂ = {value | UNCOMPUTABLE（chapman_violation 或 m₁₂=0）}<!-- fix: R1-IG-010 R1-ZL-021 -->
- 估计剩余：{value | dims_failed 时 N̂ × 计划/实际维度数 折扣，标注 n_hat_adjusted}
- 严重度轨道：{OK | NOT_OK | UNCOMPUTABLE | PROVISIONAL}<!-- fix: R1-IG-010 -->（取值集合：OK=Track B 满足；NOT_OK=不满足；UNCOMPUTABLE=NHPP 不可算/精简模式无 L2/CI 失真；PROVISIONAL=小样本调和期）
- 收敛判定：{converged | not_converged | forced_by_timeout | forced_by_human | forced_by_rounds_cap | forced_by_escalation_cap}<!-- fix: R1-ZL-022 R1-ZL-020 -->
- 建议（按收敛判定分支取值，**not_converged 时不允许 STOP 建议**<!-- fix: R1-ZL-022 -->）：
  - converged → STOP
  - not_converged → CONTINUE 或 ESCALATE（不允许 STOP）
  - forced_by_* → STOP（强制收口，附未决清单）

## 方法论元数据
- 各维度Agent底座：...
- 去相关Tier配置：...
- 总Agent派发数：{C_agent}（不含 list_messages 轮询）<!-- fix: R1-ZL-003 -->
- 总工具调用数：{C_total}（含轮询、状态读写）<!-- fix: R1-ZL-003 -->
- 效率比η：{value | unvalidated}<!-- fix: R1-FU-003 -->
- ρ̄ 估计：{value | unvalidated_prior | calibrated_by_l2_disagreement}<!-- fix: R1-IG-008 -->
- 降级标注：{degradation_trigger | 无}
```

---

## 七、关键公式速查（Agent执行时参考）

| 用途 | 公式 |
|------|------|
| Chapman估计 | N̂=(M₁+1)(M₂+1)/(m₁₂+1)−1 |
| NHPP期望剩余 | E[R(k)]=â·e^(−b̂·tk) |
| 联合检出率 | R_joint=1−∏(1−rᵢ√(1−ρᵢ)) |
| 效率比 | η=R_joint(1−δ)/C |
| 成本最优停止 | k*=ln(Lâb̂/c)/b̂ |
| **严重度0观察95%上界（Rule of Three，R1-IG-001 修复）**<!-- fix: R1-IG-001 --> | **U≈−ln(0.05)/n_eff = 3/n_eff**（先前 `U≈3/(1−e^(−n_eff))` 恒≥3 与"95%<2"矛盾，已废弃） |

### NHPP Goel-Okumoto MLE 伪代码（R1-IG-003/R1-ZL-005 修复）<!-- fix: R1-IG-003 R1-ZL-005 -->

**目的**：估计 â（尺度=总期望缺陷数）、b̂（形状=发现衰减率），用于 Track A 的 `E[R(k)]=â·e^(−b̂·tk)` 与 Track B 的 NHPP 拟合。LLM Agent 无内建数值优化器，按下方 Newton-Raphson/定点迭代执行（可在 bash Python 子进程跑，或调用外部库）。

```python
# 输入：累计每轮发现数 D[1..k]，累计工作量 t[1..k]
# 输出：MLE 估计 â, b̂
import numpy as np

def goel_okumoto_mle(D, t, max_iter=100, tol=1e-6):
    """
    Goel-Okumoto NHPP MLE: m(t) = a*(1 - exp(-b*t))
    â = 总期望缺陷数, b̂ = 发现衰减率
    输入 D=[D_1,...,D_k] 累计发现, t=[t_1,...,t_k] 累计工作量
    """
    n = len(D)
    T = t[-1]  # 总工作量
    N = D[-1]  # 总发现数（初始 â₀）
    a = float(N)                              # â₀ = N
    b = float(N) / max(sum(t[i]*D[i] for i in range(n)), 1e-9)  # b̂₀ = N/Σ(t_i·D_i)
    
    for iteration in range(max_iter):
        a_new = N / max(1 - np.exp(-b * T), 1e-9)
        # b 的 MLE 方程：Σ D_i/(e^(b·t_i)-1) = N/b − T·n/(e^(b·T)-1)
        numerator = sum(D[i] / max(np.exp(b*t[i]) - 1, 1e-9) for i in range(n))
        denom = N / max(b, 1e-9) - T * n / max(np.exp(b*T) - 1, 1e-9)
        b_new = numerator / denom if denom > 0 else b * 0.9
        
        if abs(a_new - a) < tol and abs(b_new - b) < tol:
            return a_new, b_new, iteration+1  # 收敛
        a, b = a_new, b_new
    
    return a, b, max_iter  # 未收敛 → 标注 nhpp_mle_unconverged=true

# 使用：â, b̂, iters = goel_okumoto_mle(D, t)
# E[R(k)] = â * exp(-b̂ * t_k)
# b̂ ≤ 0 或 iter==max_iter → 标注 nhpp_b_invalid=true（R1-FU-005），Track B 仅供方向参考
```

**实现库**：Python `reliability` 库；R `NHPP` 包；或上方伪代码（无依赖）。LLM Agent 可 `python3 -c "<code>"`（需 numpy）；**工具不可用时手算前 3 轮近似**（NEW-002 P2-Verify 修复，给出完整步骤<!-- fix: NEW-002 -->）：
1. 取前 3 轮累计发现 `D = [D₁, D₂, D₃]`，累计工作量 `t = [t₁, t₂, t₃]`
2. 计算 `ΔD₁₂ = D₂ − D₁`、`ΔD₂₃ = D₃ − D₂`（轮间新增）
3. 假设衰减模型 `ΔD(t) ≈ D₁ · b · e^(−b·t)`，取对数线性化：`ln(ΔD₂₃/ΔD₁₂) ≈ −b · (t₃−t₁)/2`（中点近似）
4. 解出 `b̂ ≈ −2·ln(ΔD₂₃/ΔD₁₂) / (t₃−t₁)`，若 `ΔD₂₃ ≤ 0` 则 `b̂` 取 0.01（防零除）
5. `â ≈ D₃ / (1 − e^(−b̂·t₃))`
6. 标注 `nhpp_mle_manual_approx=true`（精度低于 Newton-Raphson，仅供方向参考）

近似公式 `b̂≈(D₁−D₃)/(D₁·t₃)` 是上式的退化情形（假设线性衰减），仅在 `D₁ >> D₃` 且 `t₃` 较大时可用。

**精度声明与 Track B 决策约束（P3-full-R1 major 修复 + R2-ZL-026 死锁修复）**<!-- fix: P3-R1-major-S3-nhpp-bias R2-ZL-026 -->：DeepSeek-v4-flash 实证测试（5 组合成 GO 数据）发现上方 Newton-Raphson 定点迭代伪代码**系统性偏差**——b̂ 高估、â 低估、NLL 差于参考 GO 增量泊松网格 MLE（例：真值 a=40,b=0.2 → 伪代码 â=18.28,b̂=0.53 未收敛 84 iter；参考 â=33.6,b̂=0.13）。b̂ 高估使 `E[R]=â·e^(−b̂·t_k)` 偏小 → "期望剩余严重缺陷<1"更易满足 → Track B 有**提前 OK 的收敛偏差风险**。

**Track B OK 决策分层（R2-ZL-026 修复：消除 pseudocode-only 环境的 STOP 死锁）**：
- **Tier-1（首选）**：用 `reliability` 库 / `scipy.optimize.minimize` 直接最大化 GO 对数似然 `LL(a,b) = Σ δ_i·ln(a·b·e^(−b·t_i)) − a·(1−e^(−b·T))` / R `NHPP` 包 → Track B 可正式 OK
- **Tier-2（pseudocode-only）**：仅伪代码可用 → 标注 `nhpp_mle_pseudocode_only=true`，Track B 判定 `provisional_pseudocode_bias`，**不再永久阻塞 STOP**——替代判据：连续 ≥3 轮 `m₁₂(S2) > 0` 且 `N̂_S2` 较上轮波动 ≤15% 且严重度 0 观察 `U=3/n_eff < 2` → 允许 `provisional_stop_pseudocode=true` 作为 STOP 的 Track B 输入（标注 track_b_stop_basis=pseudocode_approx）
- **Tier-3（无任何数值工具）**：连伪代码都不可执行 → 仅依赖 Rule of Three `U=3/n_eff < 2` + 连续 ≥3 轮无新 S2 缺陷 → `track_b_stop_basis=rule_of_three_only`（最弱判据，报告显著标注）

**provisional 标签语义拆分（R2-IG-005 修复）**<!-- fix: R2-IG-005 -->：
- `provisional_small_sample`（§4.2 小样本调和）：可 STOP（满足额外稳定性条件后）
- `provisional_pseudocode_bias`（§七 算法偏差）：按 Tier-2 替代判据可 STOP，但报告标注
- STOP 判定时两种 provisional 分别处理，不再共享标签

**Track A vs Track B 输入区分**：Track A 用全缺陷累计 D；Track B 用仅 S2（blocking+major）累计 D_S2——分别跑同一实现，不可混用。

**符号说明**（§四符号表之外的补充定义）：<!-- fix: L1-ZU-005 --><!-- fix: L1-ZU-006 --><!-- fix: minor-symbol-table -->
- R_joint = 联合检出率；rᵢ = 第 i 个 Agent 的单缺陷检出率；ρᵢ = 该 Agent 与基线的同源相关系数
- **δ = 漏检率（miss rate）**，即真实缺陷中被全部 Agent 共同漏检的比例
- **n_eff = 有效独立样本数** = n·(1−ρ̄)，其中 **n = 名义样本量，操作定义 = 累计轮次 × 阶段抽样数 = k × 3（L2 陪审员数）= 3k**（R2-IG-010 修复<!-- fix: R2-IG-010 -->；精简模式无 L2 时 n = k × L1 Agent 数 = 3k，恰好相同）；ρ̄ 为平均同源相关系数（去相关后折算；ρ̄ 的组合口径见 §5.1 L1-R1-C-005/C-009）
- â = NHPP 尺度参数（总期望缺陷数的 MLE）；b̂ = NHPP 形状参数（缺陷发现衰减率）
- t_k = 截至第 k 轮的累计工作量；k* = 成本最优停止轮次
- L = 单个 blocking/major 缺陷漏检的损失（用户给定，默认 L=10c）；c = 单轮审查成本；C = 总调用次数
- η = 效率比（单位调用获得的净检出概率）

**章节交叉引用**（公式用途 → 所在章节）：<!-- fix: R2-minor-xref -->
- Chapman 估计 N̂、NHPP 期望剩余 E[R(k)] → §4.2 Track A（总量轨道），滑动窗口见 §4.2 符号表
- m₁₂=0 硬禁止 → §4.2 Track A / §4.3 小样本屏障
- 严重度 0 观察 95% 上界 U、Track B 相关 → §4.2 Track B（严重度轨道）
- SDI 严重度分歧指数（虽不在本表，但常与公式联用）→ §3.7
- 联合检出率 R_joint、效率比 η → §核心改进表（理论预期，待实证）、§5.1 去相关 Tier（ρ 来源）
- 成本最优停止 k\* → §4.4（参考，不硬制）

---

## 注意事项

- 本Skill是**执行方法论的指南**，不是研究方法论的方法
- 如果用户要改进方法论本身→应触发`multi-agent-methodology-research`
- 文档类型未知时，先询问用户确认后再启动审查
- 优先保证blocking级和major级缺陷的发现；次要问题可适度放宽
- 如果是极短文档（<500字）或非结构化叙事→建议降级为单Agent快速扫描
- 触发审查前先确认 §0.5 最小工具三元组（`create_session` + `send_message` + `list_messages`）可用性；缺失任一→直接走 §5.4 并行降级模式并在报告开头标注<!-- fix: minor-notes-tool -->

---

## 附录 A：§0.6 三层自检预期答案（R1-IG-011 修复：脱钩正文，自检完成后再对照）<!-- fix: R1-IG-011 -->

> **使用方式**：先在 §0.6 独立完成计算/判定，再翻到此附录对照。直接读此附录后再回填 §0.6 = 自检失效。

**层 b — Chapman 计算预期值**：
- M₁=8, M₂=10, m₁₂=5：
  - N̂_Ch = (8+1)(10+1)/(5+1) − 1 = 99/6 − 1 = 16.5 − 1 = **15.5**
  - Var(N̂) = (9)(11)(8−5)(10−5) / ((5+1)²(5+2)) = (9×11×3×5)/(36×7) = 1485/252 ≈ **5.89**
- D_k=20, N̂=22：剩余=2，阈值=2，**严格 <** → 等号不成立，第一条件 FAIL → Track A **不 OK**（无需看 CI）

**层 c — L3 判定预期**：
- 投票 (confirm=major, confirm=blocking, reject)：c=2,r=1 → **CONFIRMED**（max=blocking）；SDI=max{2,3}−min{2,3}=1<2，不升级
- 投票 (confirm=major, uncertain=−, reject)：c=1,u≥1 → **ESCALATED**
- 投票 (confirm=blocking, confirm=minor, confirm=major)：c=3,r=0 → 投票表判 CONFIRMED(max=blocking)；但 SDI=3−1=**2≥2** → 改判 **ESCALATED_HUMAN_SDI**

---

## 附录 B：修复历史索引（R1-FU-014 修复：正文 fix 标记迁移至此）<!-- fix: R1-FU-014 -->

> **正文仍保留 `<!-- fix: ... -->` 内联标记**便于 diff 审计；本附录提供按版本的集中索引，新读者可跳过。

### v2.5.3（深度探索会话 R3 元修复 + 自指审查局限明示，2026-08-05）
- **元层面前置**：R3-ZL-016（§1.1 自指审查局限，明示方法论不适合自指审查）
- **Ghost 修复诚实标注（5 项 DEFERRED）**：R2-ZL-028 / R2-ZL-033 / R2-ZL-035 / R2-IG-008 / R2-ZL-037（仅 changelog 未入正文，R3-ZL-005 MiniMax-M3 grep 验证）
- **教训沉淀**：P2 修复可验证性约束（grep 正文锚点）

### v2.5.2（深度探索会话 R2 L1 P2，2026-08-05）
- **Blocking 修复（4，全部为 R1 修复的二阶回归）**：R2-ZL-026（NHPP pseudocode-only 死锁 → Tier-2/3 替代判据）/ R2-ZL-023（快照跨会话 → 短内联/长 workspace-files）/ R2-ZL-024+R2-IG-004（p2_modified_count 拆分 → + p2_concurrent_changes）/ R2-ZL-034（子→父通信 → §0.1 反向通信探测）
- **Major 修复（5 已落地）**：R2-IG-005（provisional 双语义拆分）/ R2-IG-010（n_eff 中 n = 3k）/ R2-IG-001（E4/E5 类 B 归类）/ R2-IG-002（Acknowledge 时间预算）/ R2-ZL-029（强制 STOP 纯计数）
- **Major ghost（5，DEFERRED 到 v2.6.0）**：R2-ZL-028 / R2-ZL-033 / R2-ZL-035 / R2-IG-008 / R2-ZL-037

### v2.5.1（深度探索会话 R1 P3-full 回退，2026-08-05）
- **Blocking 修复（1）**：S5 实时并发写检测缺失 → §4.2.y 实时并发写协议（审查前快照 + 每轮哈希比对 + Chapman 借用声明扩展）
- **Major 修复（4）**：S1 schema hardcoded 版本→读 frontmatter + 补 p2_modified_count/carryover_defects/chapman_violation/doc_concurrently_modified 字段；S3 NHPP 伪代码偏差→精度声明；S2 拉丁方轮换执行指令；S5 Chapman 自指审查扩展

### v2.5.0（深度探索会话 R1 自指审计 P2，2026-08-05）
- **Blocking 修复（13）**：R1-IG-001（Track B 公式 Rule of Three）/ R1-IG-002（Jaccard 操作定义）/ R1-IG-003+R1-ZL-005（NHPP MLE 伪代码）/ R1-IG-004+R1-ZL-014（人工裁决单向注入+ARBITRATED）/ R1-FU-001（Chapman 封闭种群借用声明）/ R1-IG-006+R1-IG-007+R1-ZL-001+R1-ZL-002（定时器 ScheduleWakeup 实现）/ R1-ZL-012+R1-ZL-013+R1-ZL-015+R1-ZL-016+R1-ZL-017+R1-ZL-019+R1-ZL-020（§4.5.x ESCALATE 后继状态机）
- **Major 修复（21）**：R1-IG-005+R1-ZL-018（STOP 条件统一）/ R1-FU-007+R1-ZL-008+R1-ZL-009（降级触发对照表 + 工作边界禁止）/ R1-IG-008（ρ unvalidated_prior）/ R1-ZL-006（Tier→模型映射表）/ R1-FU-004（NHPP 小样本调和真正含义）/ R1-FU-003（η 推导完整化）/ R1-FU-002（55→85% 改定性）/ R1-FU-005（Goel-Okumoto 借用声明）/ R1-FU-006（"多数环境不可用"具体化）/ R1-FU-008（M_k dead symbol 删除）/ R1-FU-009（T1/T2/T3 前向引用）/ R1-FU-010（三态命名规范）/ R1-FU-011（章节编号——本版未全改，仅 §5.1 表格内统一）/ R1-FU-012（§4.5 用户指示 3 类）/ R1-ZL-007（N_vendor=3 L2 复用规则）/ R1-ZL-003（10 调用/轮=理论最小值）/ R1-ZL-004（§4.2.x 跨窗口恢复已具化）/ R1-ZL-010（LLM 算 Chapman 防错——出计算过程）/ R1-ZL-011（P3-full 降级 ρ 估计）/ R1-ZL-021（维度失败 N̂ 折扣）/ R1-ZL-022（not_converged 不允许 STOP 建议）
- **Minor/Suggestion 修复（5）**：R1-IG-009（边界 <vs≤ 统一）/ R1-IG-010（status 取值集合）/ R1-IG-011（自检答案脱钩→附录 A）/ R1-FU-013（保守取较低者理由）/ R1-IG-012（L3 入口结构化，禁自由文本）

### v2.4.0 / v2.3.0 / v2.2.0 / v2.1.0
- 参见 frontmatter 变更记录段（保留历史 changelog）。
