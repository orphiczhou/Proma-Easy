# Skill B 历史版本索引（备查）

**目录**: `workspace-files/multi-agent-collab-platform/skills/structured-doc-multi-agent-verification-v2/history/`
**建立时间**: 2026-08-05 19:20 GMT+8
**建立者**: GLM-5.2 深度探索会话（R8）

## 文件清单

| 文件 | 行数 | sha256（前 16 位） | 状态 | 内容 |
|------|------|-------------------|------|------|
| `v2.4.0-baseline.md` | 780 | `9a8f185d9f55679a` | ✅ authentic | R8 审计起点完整快照（v2.5.0/v2.5.1/v2.5.2 修复的对象） |
| `v2.5.3-current.md` | 1100 | `dd4e15042c702802` | ✅ authentic | 当前发布版本完整内容（= `skills/structured-doc-multi-agent-verification-v2/SKILL.md`） |
| `pre-r8-draft-415lines.md` | 415 | `2271083c5ab1e67b` | ⚠️ 截断 | 仅含 §一 到 §3.7，结尾 `<!-- @@SENTINEL_END@@ -->` 标记——R8 之前的某次编辑中间产物 |
| `VERSIONS-INDEX.md` | — | — | 本文件 | 索引+变更说明 |

## 版本演进

### v2.4.0（R7-R8 之间的稳定版，2026-08-04）
- **起点**：780 行，sha256 `9a8f185d9f55679a8928d10108e2cd96ee00d96dd66282620e585ed6b07b583e`
- **来源**：R7 三模型对比终审后由 GLM-5.2 P2 修复产出（参见 `reports/R7-observer-final-report.md`）
- **关键内容**：六维审查 + 三层架构 + 双轨统计收敛 + 三级去相关；含 §4.5 ESCALATE_HUMAN_PROTOCOL 雏形 + §4.2.x 跨窗口执行
- **已知问题**（R8 L1 发现）：13 blocking（Track B 数学矛盾 / NHPP 无实现 / Jaccard 无定义 / 1c+1r 悖论 / 定时器原语缺失 / Chapman 封闭种群矛盾 / ESCALATE 后继死锁 等）

### v2.5.0（R8 R1 P2 修复，2026-08-05 凌晨）
- **行数**：780 → 985（+205 行）
- **sha256**：`176e4f7112e2a204959bc1cdc04fa6776a23769677b1970e19da7f74310fac8a`（会话中 in-place 编辑后）
- **触发**：R8 R1 三厂商 L1（DeepSeek-pro/MiniMax-M3/GLM-4.6V）发现 48 raw / 38 dedup 缺陷
- **关键修复**（详见 v2.5.3 frontmatter `v2.5.0 变更记录` 段）：
  - **13 blocking**：Track B Rule of Three 公式 / Jaccard 操作定义 / NHPP MLE 伪代码 / 人工裁决单向注入+ARBITRATED / Chapman 封闭种群借用声明 / 定时器 ScheduleWakeup 实现 / §4.5.x ESCALATE 后继状态机
  - **21 major**：STOP 统一 / 降级触发对照表 / ρ unvalidated_prior / Tier→模型映射表 / NHPP 小样本调和 / η 推导完整化 / 55→85% 改定性 / Goel-Okumoto 借用声明 / "多数环境不可用"具体化 / M_k dead symbol 删除 / T1/T2/T3 前向引用 / 三态命名规范 / §4.5 用户指示 3 类 / N_vendor=3 L2 复用规则 / 10 调用/轮 理论最小值 / 跨窗口恢复具化 / LLM 算 Chapman 防错 / P3-full 降级 ρ / 维度失败 N̂ 折扣 / not_converged 不允许 STOP 建议
  - **5 minor/suggestion**：边界 <vs≤ 统一 / status 取值集合 / 自检答案脱钩→附录 A / 保守取较低者理由 / L3 入口结构化
- **中间状态文件**：未独立快照（in-place 编辑），见 audit-data/R8-deep-glm52/R1-L1-findings/ 的 38 项缺陷明细

### v2.5.1（R8 R1 P3-full 回退，2026-08-05 凌晨）
- **行数**：985 → 1027（+42 行）
- **sha256**：`cd6b419dacb696481c03b427bfe42e1915ad89d32e4c8c99426961ba63a8a187`
- **触发**：R1 P3-full（DeepSeek-v4-flash）发现 1 blocking 新缺陷——S5 实时并发写检测缺失
- **关键修复**：
  - **1 blocking**：§4.2.y 实时并发写协议（审查前快照 + 每轮哈希比对 + Chapman 借用声明扩展 + 报告披露）
  - **4 major**：schema hardcoded 版本→读 frontmatter + 补 `p2_modified_count`/`carryover_defects`/`chapman_violation`/`doc_concurrently_modified` 字段；NHPP 伪代码偏差→精度声明；拉丁方轮换执行指令；Chapman 自指审查扩展到并发写
- **中间状态文件**：未独立快照

### v2.5.2（R8 R2 P2 修复，2026-08-05 凌晨）
- **行数**：1027 → 1058（+31 行）
- **sha256**：`f4d88eb10da20f506667ebfb65fb08e1c485827289195e0cf8f41a21d9a35f29`
- **触发**：R8 R2 拉丁方轮换 L1（MiniMax-M3/GLM-4.6V/DeepSeek-pro）发现 37 raw / 30 new 缺陷，**4 blocking 全部为 R1 修复的二阶回归**
- **关键修复**：
  - **4 blocking（二阶回归）**：R2-ZL-026 NHPP pseudocode-only 死锁→Tier-2/3 替代判据 / R2-ZL-023 快照跨会话→短内联+长 workspace-files / R2-ZL-024+IG-004 p2_modified_count 拆分→+p2_concurrent_changes / R2-ZL-034 子→父通信→§0.1 反向通信探测
  - **5 major（已落地）**：R2-IG-005 provisional 双语义拆分 / R2-IG-010 n_eff 中 n=3k / R2-IG-001 E4/E5 类 B 归类 / R2-IG-002 Acknowledge 时间预算 / R2-ZL-029 强制 STOP 纯计数
  - **5 major（ghost，仅 changelog 未入正文）**：R2-ZL-028 DEFERRED_PERMANENT / R2-ZL-033 .bak 恢复 / R2-ZL-035 carryover m₁₂ / R2-IG-008 ρ̄_l2 加权 / R2-ZL-037 拉丁方>3 轮
- **中间状态文件**：未独立快照

### v2.5.3（R8 R3 元修复 + 自指审查局限，2026-08-05 凌晨→下午）
- **行数**：1058 → 1100（+42 行）
- **sha256**：`dd4e15042c702802b17cd1a6b98ef48cf377768139ec1f45949a95c6f107f2d2`（= 当前发布的 sha256）
- **触发**：R8 R3 拉丁方轮换 L1 发现 5 blocking，含 ghost 修复元发现（R3-ZL-005）
- **关键变更**：
  - **元层面前置**：R3-ZL-016 → 新增 **§1.1 自指审查局限**（明示方法论不适合自指审查，预期终止形态只能是 `forced_by_*`）
  - **Ghost 修复诚实标注**：5 项 R2 ghost 标为 DEFERRED + 教训沉淀（P2 修复可验证性约束）
  - **§一 不适用列表更新**：增加"本方法论文档自身或任何会被本管线 P2 就地改写的文档"
  - **附录 B 补全**：v2.5.3/v2.5.2/v2.5.1 索引条目
- **当前状态**：✅ 已发布到 Proma 加载目录

## 中间版本（v2.5.0/v2.5.1/v2.5.2）为何未独立存档

R8 会话采用 **in-place 编辑**模式——每个版本的 P2 修复直接修改同一文件，未做版本间快照。这是 R8 自指审计的方法论实践本身（§4.2.y 实时并发写协议是 R2 修复后才补的，R1 阶段没有此机制）。

**反推重建**理论上可行（约 21 次精确字符串替换），但风险：
1. 我的 forward 编辑链中部分编辑在同一区域多次叠加，反推顺序敏感
2. 重建版本的" authenticity "无法验证（无外部 sha256 参照）
3. changelog 已精确记录每版本变更，重建价值边际

**推荐做法**：
- 查 v2.4.0 → 看 R8 审计起点的原始问题
- 查 v2.5.3 frontmatter 内的 v2.5.0/v2.5.1/v2.5.2 changelog → 看每版本具体修复了什么
- 查 `audit-data/R8-deep-glm52/R2-L1-findings/` 和 `R3-L1-findings/` → 看每版本 L1 发现的详细缺陷（含 `fix_status_v252` 字段）
- 综合 → 完整还原版本演进

如需反推重建中间版本，可单独请求（耗时但可做）。

## 完整文件位置

- **本目录**（历史归档）：`history/`
- **当前发布版本**：`skills/structured-doc-multi-agent-verification-v2/SKILL.md`（与 `history/v2.5.3-current.md` 内容一致）
- **审计数据**：`audit-data/R8-deep-glm52/`（含每轮 L1 findings、状态文件、v2.4.0 起点快照）
- **报告**：`reports/R8-self-audit-deep-glm52-final.md`（§六 格式最终报告）+ `reports/R7-observer-final-report.md`（R7 三模型对比）

## pre-r8-draft-415lines.md 的说明

415 行的截断文件，frontmatter 也是 v2.4.0 但内容只到 §3.7（结尾有 `<!-- @@SENTINEL_END@@ -->` 标记）。来自 Proma 加载目录的 `SKILL.md.r1-backup`（Aug 4 22:43），推测是 R7 工作期间某次编辑的中间产物。

**不作为完整版本参考**，但保留作历史工件——它可能记录了 R7 P2 修复过程中的某个中间状态，对研究 R7 工作流有参考价值。

## 版本号维护教训

R8 自指审计的元发现之一（R3-ZL-005 ghost 修复）暴露：**仅靠 changelog 文字声称"已修复"是不可信的**。本索引中：
- ✅ 标"authentic"的版本有完整文件 + sha256 双向校验
- ⚠️ 中间版本仅有 sha256（会话中计算过）+ 行数，无独立文件
- 教训已写入 v2.5.3 §1.1 + 记忆 `skill-v2-self-audit-structural-nonconvergence`
