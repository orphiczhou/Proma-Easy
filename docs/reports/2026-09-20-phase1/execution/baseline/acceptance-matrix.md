# Phase 1 · S1–S3 验收矩阵（B0 补充，audit-r1 补制）

> 补制会话：audit-r1（独立审计角色）｜补制时间：2026-09-20 14:15 GMT+8
> 依据：`docs/reports/2026-09-20-phase1/项目盘点与问题台账-20260920.md`（P-01–P-21）＋原设计 `/home/orphic/proma-projDoc/DesignDoc/05_PROJECT_PLAN/sprint-plan.md` §3.0–3.3 ＋ 本轮执行证据（`execution/`、`execution/audit-r1/`）。
> 计划依据来源 Task 0「执行时创建 `acceptance-matrix.md`」；B0 未产出，由本轮审计补制。

## 0. 证据状态口径（先声明，避免把计划授权当验收）

| 状态 | 含义 | 允许的证据 |
|---|---|---|
| 实现存在 | 源码/资源里有入口 | 静态读码 + 文件:行号 + 哈希 |
| 定向验证 | 有测试或脚本在**明确版本与环境**下实际跑过 | 运行的命令 + 原始日志 + 退出码 |
| 真流程验证 | 经产品入口跑过真实需求→交付链 | 工程内 `06_TESTS/evidence/<runId>/` + 平台证据 |
| 产品验收 | 目标用户在**当时部署版本**上按 Phase1 口径走完并确认 | 部署版本号 + 工程/模板哈希 + 用户确认记录 |

**规则（本矩阵硬约束）**
1. 计划里"已排期/已授权/已分工"**不等于**任何一格通过。本表所有"是"都必须给出可复算证据路径。
2. 未取得证据的格子写 `未验证`，不写"应该可以"。
3. 定向测试绿**不能**填"产品验收"列；AC 轮次/测试总数也不代替验收。
4. 表格基于审计时点哈希（见 `execution/audit-r1/hashes.tsv`）；代码共享可变，**换哈希需重算本表**。

当前基线：HEAD `34f72fbc`（v0.17.131）；**dev 部署包 = 0.17.130（v131 未部署）** → 任何"产品验收"都必须先解决部署版本差。

---

## 1. Sprint 1（地基与最窄骨架）

| 原计划条目（sprint-plan §3.1） | 实现 | 测试 | 真流程 | 产品验收 |
|---|---|---|---|---|
| 模式选择页 + 快消型工作区（双区布局） | 存在：`renderer/components/nanju/ModeSelectView.tsx:54` | 未验证（无该页面断言测试；`quick-ux-model.test.ts` 仅覆盖文案/摘要函数） | 未验证（真流程工程停在 CODE，未回看 S1 行为） | 未验证 |
| 对话路由加载"需求分析师"角色 | 存在：`main/lib/nanju-router.ts:222` | 定向验证部分：`nanju-router.test.ts`(44) 覆盖路由表 | 未验证（无角色切换埋点的真流程截面） | 未验证 |
| 需求分析师 ≥3 引导问题、无技术术语 | 存在：`nanju-router-prompt.ts` | 未验证（**无黑名单词扫描测试**；原计划 T9 要求"心理防御黑名单词扫描"） | 未验证 | 未验证 |
| 首快照（项目创建即产生，非空目录） | 存在：`nanju-project.ts:320`、`nanju-ipc.ts:255` | 定向验证：`nanju-project-snapshots.test.ts`、`nanju-file-snapshot` 相关 | 未验证（台账 P-13/P-21：首快照失败只记日志） | 未验证 |
| 埋点基础（项目创建 + 每轮对话） | 存在：`nanju-quick-telemetry.ts:43` | 定向验证：`nanju-telemetry.test.ts` | 部分：台账 §3.2 用真流程 telemetry 重算 90 事件（**该项实测可信**） | 未验证 |
| 裁判/编程占位桩 | 已被后续实现取代（非桩） | — | — | — |
| S1 验收：应用启动→无活跃项目→两道门 | 存在：ModeSelectView | 未验证 | 未验证（需 GUI E2E） | 未验证 |

## 2. Sprint 2（向导主轴贯通）

| 原计划条目（§3.2） | 实现 | 测试 | 真流程 | 产品验收 |
|---|---|---|---|---|
| 预览区渲染单文件 HTML 原型 | 存在：`nanju-ipc.ts` 预览链 + `GuidePanel` | 定向验证：预览/协议 token 相关（`nanju-preview` 系） | 未验证（最近真流程已完成原型并进入 CODE，但无本次截面复核） | 未验证 |
| 4 角色串行切换（含后台架构师/工程经理） | 存在：`nanju-router.ts:459`、`nanju-router-prompt.ts` | 定向验证：`nanju-router*.test.ts` | 未验证 | 未验证；且台账要求**写等价交付清单**说明工程经理职责是否并入（P-17），当前未产出 |
| 快消型精简文档体系（01/02/03/04/06/README） | 存在：模板 materialize 链 | 定向验证：`nanju-engineering-template.test.ts` | 未验证（P-20：Spike 协议未随 materialize 复制） | 未验证 |
| GWT Feature 自动生成（正常+边界+异常） | 存在：`nanju-router.ts:326` | 定向验证：`nanju-rgwt` 系 | 未验证；台账 P-17：**后置到 testing 才生成，硬要求仅 happy path** | 未验证 |
| 裁判硬约束（PRD + GWT 存在性） | 存在：`nanju-router-gate.ts` | 定向验证：`nanju-router-gate.test.ts` | 未验证 | 未验证 |
| 原型确认前后自动快照 | 存在：快照触发 | 定向验证 | 未验证（P-16：回滚链存在正确性缺口） | 未验证 |
| S2 验收：用户确认原型→后台自动开发 | 存在 | 定向验证 | 未验证 | 未验证 |

## 3. Sprint 3（编程收口闭环）

| 原计划条目（§3.3） | 实现 | 测试 | 真流程 | 产品验收 |
|---|---|---|---|---|
| 编程 Agent 产出可运行代码 | 存在 | 定向验证：委派/契约测试 | **部分真流程**：真流程工程已产出 `08_APP` 代码与 AC verdict（台账 §3） | 未验证 |
| 测试 Agent 执行全量 GWT + 结构化报告 | 存在：`nanju-gwt-runner.ts` | 定向验证：`nanju-gwt-runner.test.ts` **114 pass / 0 fail**（audit-r1 复算，哈希 `62b00d49`） | 未验证（`06_TESTS` 为空，无机器报告） | 未验证 |
| 裁判全量通过口径（**全量场景通过**） | **本轮变更**：`judgeGwtResult` 增加 `skipped === 0`（`nanju-gwt-runner.ts:403`） | 定向验证 + 独立负例：pass+skip→fail 已复现（B1 新用例 + audit-r1 N5） | 未验证 | 未验证 |
| 3 次修复 + 熔断 + 自动回滚 | 存在：`agent-orchestrator.ts:955`、`nanju-repair-loop.ts:54`、`nanju-project-snapshots.ts:329` | 定向验证：repair/snapshot 测试 | 未验证（P-16：**回滚失败/不完整仍显示成功**；audit-r1 未见修复证据） | 未验证 |
| 异常通知（安抚文案） | 存在 | 定向验证：`GuardAlertCard` 数据链 | 未验证 | 未验证 |
| 用户看到自然语言测试摘要 | 存在：`GwtProgressCard.tsx`、`buildGwtSummaryLine` | 定向验证：`quick-ux-model.test.ts:177-193`（含 skip 诚实文案）；audit-r1 读码核对 | 未验证（P-21：实时卡 60s 隐藏、切会话清空，缺持久入口） | 未验证 |
| 点选纠错 MVP（data-ai-id） | 存在：`nanju-ipc.ts:501` | 定向验证 | 未验证（P-18：testing 期调整被路由回 prototype/PRD） | 未验证 |
| 基础执行隔离（超时/输出限制/子进程数） | **本轮变更**：并发上限 8（`nanju-engineering-process-driver.ts` `DEFAULT_MAX_CONCURRENT_DRIVER_PROCESSES`） | 定向验证：72 pass（5 文件，audit-r1 复算哈希 `5791c1ca`） | 未验证 | 未验证；注：套件顺序执行下并发上限实际不可达（见 audit-r1 `findings.json` F-07） |
| 埋点完成（沙箱/自修复/裁判/满意度/完成） | 存在：`nanju-quick-telemetry.ts` | 定向验证 | 部分（台账 §3.2 事件重算） | 未验证 |
| **S3 收口验收**：零基础用户拿到可运行软件，全程无代码/无术语 | 部分（模板+契约+指纹门） | — | 未验证 | **未验证**（台账 §2：可双击产物未单列验收；dev 包 0.17.130） |
| 驱动环境阻塞不误扣修复预算（Task 11） | **本轮变更**：结构化 blocked（`nanju-engineering-execution.ts`：`interpretBlocked`） | 定向验证：16→**72 pass**（本轮加严） | 未验证（driver 报告 §7 自述未实测端到端） | 未验证 |

## 4. 台账 P-01–P-21 在审计时点的处置

| ID | 批次 | 审计时点状态（证据） |
|---|---|---|
| P-01 资源部署漂移 | B2 | 进行中（资源会话新增 manifest/校验脚本；dev 仍 0.17.130） |
| P-02 推进拒因/pending 无恢复 | B2 | 进行中（父会话正在实施恢复链；未审计） |
| P-03 testing 机器报告缺失 | B3 | 未开始（`06_TESTS` 空） |
| P-04 全量基线不可解释 | B0 | **已闭环**：`execution/baseline/`（113 失败分类，0 产品缺陷，含 mock 污染/环境依赖/方法限制/遗留用例四类） |
| P-05/P-06 误拦 | B4 | 未开始（事件级标注未做） |
| P-07 envReady 双源 | B5 | 未开始 |
| P-08 驱动质量人工审查 | B5 | 部分：本轮加严了 blocked 协议与并发上限；断言变异体/合规集未见 |
| P-09 证据落位 | B2/B5 | 未开始（本轮证据已按项目内归档执行） |
| P-10 error 详情透传 | B2/B3 | 部分（driver error 轮 driverIo 透传存在；缺真实样本） |
| P-11 UX/异常恢复统一验收 | B3/B6 | 未开始 |
| P-12 统计混用 | B0/B5 | 部分：B0 已把 GWT/AC/error 计数口径写明；仍需 V 层统一 |
| P-13 O3 终报/AC 结论 | B0 | **未核实**（本轮未取得 O3 终报；不标 pass） |
| P-14 模板版本索引漂移 | B6 | 未开始 |
| **P-15 同故事 pass+skip 仍判 pass** | B1 | **定向已闭环**：`judgeGwtResult` 加 `skipped === 0`；119→114 用例全绿；audit-r1 独立负例复现 fail 语义。**真流程/产品验收未验证** |
| P-16 回滚假成功 | B1 | 未见修复证据（父会话实施中，未到审计阶段） |
| P-17 GWT 后置/角色对账 | B4 | 未开始 |
| P-18 testing 点选错路由 | B4 | 未开始 |
| **P-19 骨架 exit2 被解释成 fail/error** | B5 | **定向已闭环（含加严）**：结构化 blocked 协议 + 旧签名加严；audit-r1 发现 label-only 逃逸（14:09 哈希）→ worker 14:10 已修；残留"自述性"问题见 F-01/F-03 |
| P-20 Spike 协议未复制 | B2 | 进行中（资源会话） |
| P-21 交付入口/持久摘要/进程限制 | B1/B5/B6 | 部分：进程并发上限已加（实际不可达）；交付入口/持久摘要未做 |

## 5. 结论

1. **S1–S3 在审计时点均不构成"产品验收通过"**：S1/S2 全部格子为"未验证"或"定向验证"，S3 有 1 个"部分真流程"（代码产物存在）+ 1 个"定向已闭环"（P-15），其余未验证。
2. **可对外声明的只有**：实现存在（多条）＋定向验证（B0 全量基线、GWT 114、blocked 协议 72、邻接 163、audit-r1 负例 15）。
3. **三个必须先解决的前置**：dev 部署版本 0.17.130 ≠ 源码 v0.17.131（P-01）；恢复链（P-16）未到审计；真流程 testing 从未执行（P-03）。
4. 本表**不是**验收记录；任何一格改判为"通过"都必须补上该行"产品验收"列的证据路径（部署版本 + 哈希 + runId + 用户确认）。
