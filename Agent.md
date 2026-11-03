# PromaEasy 项目入口

> 文档版本：1.0.1｜建立：2026-09-20 GMT+8｜用途：源码项目关键信息、项目记忆与交付资料的索引。
> 入口纠正（2026-09-20 13:27 GMT+8）：用户所指的是会话启动时检查的 Proma 工作区 AGENTS.md，已补建 [工作区规则](/home/orphic/.proma/agent-workspaces/default/AGENTS.md) 与 [当前工作目录入口](/home/orphic/.proma/agent-workspaces/default/workspace-files/AGENTS.md)。本文件保留为源码资料索引。

## 先读什么

1. [AGENTS.md](AGENTS.md)：编码、验证、IPC、版本及提交规则。
2. [项目当前状态](docs/project-memory/current-state.md)：已核验进展、阻塞、下一执行波和验证边界；开始任务时核对其日期及实际 HEAD。
3. [项目决策与经验](docs/project-memory/decisions.md)：范围、验收口径、恢复原则、资源分发与证据纪律。
4. [第一阶段完善与优化计划](docs/plans/2026-09-20-phase1-hardening-plan.md)：B0–B6 批次、13 个执行任务与验收清单。
5. 需要原始证据时读 [项目盘点与问题台账](docs/reports/2026-09-20-phase1/项目盘点与问题台账-20260920.md) 及 [来源归档](docs/reports/2026-09-20-phase1/sources/README.md)。

## 项目与当前范围

- 项目：PromaEasy，基于 Proma 的本地优先 Electron AI Agent，Bun monorepo，使用 Pi runtime。
- 当前源码项目根：`/home/orphic/proma-patches/p1-quick-engineering`；工作分支 `p1-quick-engineering`。本路径描述当前环境，项目内资料链接一律优先用相对路径。
- 本轮目标：设计施工计划 **Phase 1 / Sprint 1–3 快消型主轴** 的完善优化，加上已提前实现的六品类工程模板。
- 原始设计归档：[DesignDoc](docs/DesignDoc/README.md)、[施工计划](docs/DesignDoc/05_PROJECT_PLAN/sprint-plan.md)、[PRD](docs/DesignDoc/01_PRD/prd.md)。
- 后续阶段的长期型前台、完整 PlantUML、多角色开发全量化、视觉框选、科研看板与 A/B 实验不自动加入本轮范围。
- 有实现、单测通过、真流程通过、产品验收完成是四种不同证据状态。当前状态与版本只在项目记忆中维护，不在此重复滚动抄写。

## 关键代码入口

| 模块 | 位置 |
|---|---|
| Electron 主进程与流程机 | `apps/electron/src/main/lib/`；重点 `nanju-router.ts`、`nanju-router-gate.ts`、`nanju-phase-advance-consumer.ts`、`agent-orchestrator.ts` |
| 模板与环境 | `apps/electron/resources/nanju-engineering-templates/`；`nanju-engineering-template.ts`、`nanju-env-probe.ts` |
| 契约、执行与验收 | `nanju-engineering-contract.ts`、`nanju-engineering-execution.ts`、`nanju-engineering-suite.ts`、`nanju-gwt-runner.ts` |
| 快照与恢复 | `nanju-snapshot.ts`、`nanju-file-snapshot.ts`、`nanju-project-snapshots.ts` |
| 项目界面 | `apps/electron/src/renderer/components/nanju/`，含 `guide/` |
| IPC 与共享类型 | `apps/electron/src/main/lib/nanju-ipc.ts`、`apps/electron/src/preload/index.ts`、`packages/shared/` |
| 打包和开发部署 | `apps/electron/electron-builder.yml`、`deploy/`；运行时模板当前走 `extraResources` |

表中仅写文件名的源码均位于 `apps/electron/src/main/lib/`。通用架构、开发命令和强制工程规则以 [AGENTS.md](AGENTS.md) 为准。

## 资料落位与维护规则

用户于 **2026-09-20 13:10 GMT+8** 明确要求：报告等放在项目目录，项目记忆由本文件索引。

- 报告、盘点、审查结论与对应证据：`docs/reports/<日期>-<主题>/`。
- 可执行计划：`docs/plans/`，链接对应盘点与证据。
- 项目记忆：`docs/project-memory/`；只存项目状态、项目决策及工程经验，**不混入用户画像或个人协作记忆**。
- 设计依据：`docs/DesignDoc/`；已有评审单继续在 `dispatch/reviews/`，通过索引关联，避免重复改写。
- 新增长期有效项目记忆文件时，必须在本文件增加链接及一句话说明。更新状态须标核验日期、源码基线和证据；冲突以更新且可验证的事实为准，保留历史来源。
- 项目报告、计划、证据和交接不以会话目录或 Proma 托管工作区目录为权威存放点。工具产生的临时输出可暂存，但交付前归档到项目并更新相对链接。
- 源码 `AGENTS.md` 保留工程规则，源码 `Agent.md` 保留详细项目资料索引；Proma 当前工作目录的 `AGENTS.md` 是用户要求补建的启动导航入口。各入口通过链接连接，不重复维护状态表。
- 本文件与项目记忆可以随已验证的项目进展做最小更新；不覆盖用户规则，不把计划中的修复提前记为已完成。

## 项目记忆索引

| 文件 | 内容 |
|---|---|
| [current-state.md](docs/project-memory/current-state.md) | 当前基线、实现与实测状态、阻塞问题、下一步、最近验证 |
| [decisions.md](docs/project-memory/decisions.md) | 已确认范围、验证口径与项目资料位置；后续修复方案的建议与待执行边界 |

## 最近交付索引

| 资料 | 用途 |
|---|---|
| [2026-09-20 项目盘点](docs/reports/2026-09-20-phase1/项目盘点与问题台账-20260920.md) | Phase 1 覆盖矩阵、六模板成熟度与21项问题 |
| [2026-09-20 推进计划](docs/plans/2026-09-20-phase1-hardening-plan.md) | 正确性→v131补齐→真流程→交接/协议→产品收口 |
| [机器状态快照](docs/reports/2026-09-20-phase1/evidence/inventory-snapshot.json) | SHA、模板哈希、项目状态及90条遥测的复算结果 |
| [交接与观察来源](docs/reports/2026-09-20-phase1/sources/README.md) | 三份历史交接、两组八份观察报告；注明观察窗口和结论冲突 |
| [v131 原方案](dispatch/reviews/v131-门禁透明化方案.md) | 历史修复承诺；实际完成情况以新盘点对账为准 |
| [desktop 历史实测](dispatch/reviews/E2E-desktop-clipboard-review.md) | 编排版实测与模板回填依据 |
| [mobile 历史实测](dispatch/reviews/mobile闭环验证-review.md) | 真机环境/驱动验证，非业务项目验收 |
