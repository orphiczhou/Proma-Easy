# Issue #P1-EVD-001：证据校验反馈断裂致架构阶段死循环 + requirements.txt 词表误拦（deny#15）

> **状态**：已修复（`8d2de303`），未部署｜**严重级**：P1（流程级死锁，需人工介入恢复）
> **发现环境**：E2E 番茄工作法定时器（quick / desktop-app / Linux），dev 0.17.132 + 2026-09-30 22:52 部署版
> **影响窗口**：2026-10-01 00:06–00:54 GMT+8（48 分钟，5 次拒因、3 次 loop-limit、1 次词表误拦）
> **发现方式**：真实 E2E（用户手工推进失败后报告）
> **关联**：#2a（phase.role 豁免，e97bb2b6）、W19-C 词表收紧系列、E2E-Desktop 六轮 GWT 返工（verification-and-fix-plan-20260928.md §六）

---

## 1. 现象

番茄工程 architecture→coding 推进连续被拒（`advance.auto-gate verify-failed`），拒因「证据记录凭证缺失：以下 [实证]/[文证] 条目缺少有效来源或日期」。架构师**已按格式要求补写引用**仍被判缺失，两轮拒因**一字不差**；loop-limit 累计 5 次后流程静默停摆。用户手工发送「推进」无法解除。

## 2. 复现时间线（GMT+8，遥测+工程文件实录）

| 时刻 | 事件 | 事实 |
|---|---|---|
| 00:04 | `env.setup.verified` | 环境就绪 |
| 00:06 | 首次 `advance.auto-gate` 拒 | 拒因：7 条 [实证] 条目「缺少有效来源或日期」 |
| 00:08 | `spike.verdict confirmed` + 第 2 次拒（count 3, loop-limit） | 架构师登记 Spike 并补写「证据升级与检索记录」表格——**每条都写了 `file://` 引用 + 检索日期 2026-09-30，格式合规** |
| 00:34 | `dialog.submitted`（inputLength=2, vague=true） | 用户手工「推进」被判 vague，无效 |
| 00:37 | `delegate.guard.stage-deny` | 调度员转而提前委派开发工程师 → 命中 requirements 词表英文裸词 `requirements`（**来源：任务书列举产出物「requirements.txt、setup.sh、README」**） |
| 00:38 | 第 4、5 次拒（loop-limit） | 拒因仍与 00:06 一字不差 |
| 00:38–00:54 | 静默停摆 | loop-limit 上限，等待人工 |
| 01:14 | 人工介入恢复 | 修正 7 处虚构路径 → 调度员声明 coding → **推进成功**（subStage CODE） |

## 3. 根因分析

### 3.1 直接根因：LLM 虚构文件路径（不可全防，但必须可反馈）

架构师补写的引用指向虚构目录：

```
写：…/workspace-files/pomodoro-spike-evidence/probe-result.json      ← 不存在
真：…/project-番茄工作法定时器/00_SPIKES/spike-001-tray-preflight/evidence/probe-result.json
```

它未先查看 `00_SPIKES/` 实际结构，凭空命名了「证据目录」。第 219 行还虚构了同目录的 `template.md`/`prd.md`。校验器 `hasEvidenceReference` 对每条引用执行 `realpathSync()`——路径不存在 → 引用无效 → 依旧「凭证缺失」。

### 3.2 放大器（本 issue 的核心产品缺陷）：反馈断裂

`hasEvidenceReference` 内部**知道** realpath 失败（路径不存在），却只返回布尔值。于是：

| 轮次 | 架构师实际状态 | 收到的拒因 |
|---|---|---|
| 第 1 轮 | 未写引用 | 「缺少有效来源或日期（须 URL+检索日期…）」 |
| 第 2 轮 | **写了引用+日期，但路径不存在** | 「缺少有效来源或日期（须 URL+检索日期…）」**一字不差** |

作者拿不到「你的 file:// 路径不存在」这一关键修正信息，修正方向被封死——这是把一次可自愈的笔误放大成流程死锁的直接机制。

### 3.3 连锁问题 1：调度员响应错位（记录，未修）

证据修不动后，调度员试图**提前委派开发工程师**绕路（00:37）。该委派按原判定流本应被 coding 角色词（「开发/实现」）正确拦截，但实际命中词是 `requirements`（文件名碰撞）——**拦截结论正确、拦截理由错误**（歪打正着）。另注：该委派 `phase.role=developer` 与 architecture 阶段不匹配，2a 豁免不适用，属正确不豁免。

### 3.4 连锁问题 2：用户推进通道不通（记录，未修）

自动审核模式下用户确认不豁免产出校验（设计如此），且 2 字「推进」被判 vague。但界面向用户零反馈「当前卡在哪、做什么才有用」——用户只能干等或误以为系统坏了。

## 4. 修复内容（`8d2de303`）

### 4.1 修复 A：证据拒因细分（路径级反馈）——治本

- 新增 `diagnoseEvidenceReference`（与 `hasEvidenceReference` 同一判定口径），失败时带回细分原因：`no-reference` / `file-not-found` / `file-outside-allowed` / `invalid-url` / `missing-date`，以及**失效引用的原文列表**。
- `validateEvidenceRecordSection` 拒因分三桶：
  1. **缺引用**（原文案，含格式说明）
  2. **引用无效**：「以下条目已写 file:// 引用但引用无效（请核对工程内实际文件路径——**先用 Read/ls 确认文件存在再引用**；不允许引用不存在的路径）：『条目』→ file:///fake/…（**路径不存在**/在工程/授权目录之外）」
  3. **缺日期**：引用有效但缺 YYYY-MM-DD。
- 效果：同场景下第 2 轮拒因将直接列出 `pomodoro-spike-evidence/probe-result.json` 与「路径不存在」——架构师一轮内可自修正。

### 4.2 修复 B：词表去 `requirements` 裸词（deny#15）——同 W19-C 模式

`STAGE_ROLE_KEYWORDS.requirements` 移除 `'requirements'`：Python 标配依赖清单文件名高频合法引用；requirements 阶段自身匹配由 `需求调研/需求收集/analyst` 等复合词承接。观测分类降级（`Requirements gathering` → unmatched 放行），**放行语义不变**。

### 4.3 未修但记录的产品改进（后续 backlog）

1. 调度员对拒因的响应策略（被拒后应优先修复当前阶段产出而非提前委派下一阶段——现有拒因已含「不得跳过门禁」，可在阶段指令中强化）。
2. 工程阻塞时向用户的可见卡点提示（当前 UI 零反馈）。
3. 证据引用的「工程内文件自动补全」建议（拒因可直接附 00_SPIKES/ 下实际文件列表，进一步降低虚构概率）。

## 5. 验证

- 单元：`nanju-router-gate.test.ts` +2（虚构路径拒因含具体路径/条目/操作指引；越出目录单列归因）；`nanju-delegate-guard.test.ts` +2（deny#15 复现：纯文件名列产出物不再拦；对照：真实 coding 角色词仍拦）。
- 263 pass / 0 fail；typecheck exit 0。
- **E2E 验证待部署后观察**：番茄工程当前已在 coding（推进于 01:14，人工修复路径后）；下一工程的架构阶段为自然验证场景。监控任务 `5372ddf2` 持续采集中。

## 6. 恢复操作记录（供复用）

```bash
# 1. 定位虚构引用（工程内全文档扫描）
grep -rn "file://" project-*/03_ARCHITECTURE/architecture.md
# 2. 对照真实产物路径（00_SPIKES/ 下）逐条替换
# 3. 自检全部引用存在（0 个 bad 为过）
python3 -c "import re,os; …"
# 4. CDP 向调度员会话发消息：说明已修正，请重新输出 PHASE_ADVANCE: coding
```

## 7. 教训（沉淀）

- **校验器拒绝时必须反馈「作者写了什么、为什么无效」**——布尔化反馈会把可自愈笔误放大成死锁。
- LLM 生成的 file:// 路径不可信（虚构目录是常态而非意外），拒因附「先 Read/ls 确认」的操作指引比格式说明更有效。
- 词表裸英文词对文件名/技术名碰撞零防御（requirements.txt 前有 fullstack/PRD/验收），W19-C 系列继续按实证逐词收紧。
