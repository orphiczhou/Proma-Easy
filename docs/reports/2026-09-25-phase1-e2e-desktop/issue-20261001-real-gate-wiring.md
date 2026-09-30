# Issue #P1-REAL-002：真实能力证据门禁「人机入口未接线」——requiresReal 工程结构上不可交付

> **状态**：已分析，修复方案待用户拍板｜**严重级**：P1（功能闭环缺口，非崩溃）
> **发现环境**：E2E 桌面便签（2026-09-29）+ E2E 番茄定时器（2026-10-01 02:50），两工程独立终结于同一状态
> **关联**：Issue #P1-EVD-001、W-I B-f 真实证据门禁设计（nanju-engineering-real-gate.ts 头注释）

## 1. 现象

两个 requiresReal=true 的 desktop-app 工程，GWT 驱动层全部通过（便签 29/29、番茄 92/92），均在交付门前被 blocked：

```
真实能力证据未齐备：缺少宿主独立观察证据：acceptance-xxx 仍需宿主观察器实测
或同会话真人见证，不能用项目驱动结果解除（测试项 acceptance-xxx）
```

调度员收到指引「请先解决该条件」后**没有任何可行动作**（该条件的解除手段不在会话可达范围内）。

## 2. 根因：门禁两端，一端完备一端缺失

| 层 | 状态 | 证据 |
|---|---|---|
| **门禁校验端**（消费侧） | ✅ 完备 | `validateEngineeringRealEvidenceCompleteness` 逐 testId 校验观察票据/见证收据；`requires-real-unattested` fail-closed；防伪造收据（opaque receipt + 宿主时钟绑定）设计严谨 |
| **证据生产端**（人机入口） | ❌ **未接线** | `registerHostObserverEvidence`（宿主观察器登记唯一入口）与 `EngineeringHumanWitnessDecision`（真人见证收据）**在产品流程中零调用点**：无 UI 询问横幅、无会话 Ask/permission 触发、`nanju-engineering-linux-observer.ts` 的观察点定义无人消费 |

即：协议与校验器按 W-I B-f 设计完整落地，但「谁来提供见证」的产品接线从未完成。requiresReal 工程（本工作区全部 desktop-app 工程默认如此）**在当前版本结构上不可能达成 delivered**。

## 3. 影响面

- 六品类中所有 `requiresReal: true` 的工程（desktop-app 全部、mobile 真机类）最终都会停在此门禁。
- 门禁 blocked 文案说「请先解决该条件」——调度员/用户均无解除手段，形成**误导性指引**（暗示可解决实则不可）。

## 4. 修复方案（三个选项，需拍板）

### 方案 1：最小可用——「同会话真人见证」Ask 接线（建议首选）
- 在 GWT suite 全 pass 但 requiresReal 项缺见证时，由宿主向**用户**发一次 AskUserQuestion（复用 capability 通道，与工程测试逐项批准同机制）：「以下验收项为项目驱动自证，是否由你真人见证其真实行为？见证将登记绑定本会话+时间的收据（不可伪造）」。
- 用户确认 → `registerHostObserverEvidence`（humanWitness 分支）登记 → 门禁放行。
- 工作量：real-gate 加一个宿主触发点 + orchestrator 接线 Ask；协议层零改动。
- 语义保真：真人按一下确认 ≠ 宿主观察器实测——但协议本身区分 `human-witness-limited-to-non-machine-points` 边界码，如实降级不冒充。

### 方案 2：宿主观察器接线（完整形态，工作量大）
- 按 linux-observer 设计接入真实观察（进程外读回、截图核对等），machineObservable 观察点由宿主实测。
- 适合后续版本，不建议本轮。

### 方案 3：临时出口——requiresReal 声明降级指引
- 门禁 blocked 文案改为如实：「本版本宿主见证入口尚未提供，需在设置中降级该工程契约 requiresReal 或等待产品接线」。
- 最诚实但用户仍无自助路径（改契约=重走架构门禁）。

## 5. 本轮工程处置

- 番茄工程已通知调度员「产品级门禁缺口，勿重试勿改码，等待用户决策」——避免空转。
- 便签/番茄两工程保持 blocked 终态，作为本 issue 的活样本。

## 6. 验证状态备注（E2E 四项验证点终局结论）

| 验证点 | 结论 |
|---|---|
| A. 2a phase.role 豁免 | ✅ **生效**：role-exempt 遥测 ×2（architecture 15:53:58 + testing 17:37:02），阶段角色委派零误拦 |
| B. 契约指引（自查第5条） | ✅ 生效：番茄契约 driver 全指向协议驱动、全在 artifacts、target 全为被测产物（便签 r1/r2/r4 三类错误零复发） |
| C. 前置校验 | ✅ 理想状态：未触发（契约一次合规） |
| D. 驱动协议指引 | ✅ 生效：四驱动 exitCode/等值/evidence 数组全合规，GWT **1 轮**全过（便签 6 轮）；唯一 error 为更深的覆盖完整性层（契约 covers 与驱动 checks 不匹配），已修复（0232c5bb：拒因列缺失 US 编号+两条出路） |
