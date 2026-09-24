# 项目当前状态

> 文档版本：1.0.0｜事实核验：2026-09-20 12:46–13:04 GMT+8｜归档：2026-09-20 13:10 用户指令后。
> 源码基线：`34f72fbc8114608b998eaf4e1f5e1937f3deeb59` / `apps/electron/package.json` v0.17.131。
> 本文件记录核验截面，后续开工必须检查 Git 与实际部署；不能把此日期状态当作永远有效。

## 当前定位

Phase 1 快消型主轴的模块和六品类模板已有较完整实现，进入闭环加固期，**尚未达到产品验收完成**。当前用户目标是完善和优化现有范围；详细范围见 [施工计划](../DesignDoc/05_PROJECT_PLAN/sprint-plan.md) 与 [当前推进计划](../plans/2026-09-20-phase1-hardening-plan.md)。

## 截面事实

- 源码工作树在盘点结束时干净；此次文档归档新增的文件尚未提交，不代表应用版本已升级。
- 前序交接称 v131 已推送；本轮未查询网络远端，不重复背书远端实时状态。
- dev 包实际为 v0.17.130；asar 无工程模板；外置 desktop 模板 v1.0，而源码为 v2.4。
- 核验时未发现 dev app 进程，19877/9224 无监听。恢复前重新核实，未自行重启。
- 真流程剪贴板工程停在 CODE；pending 指向 testing；`06_TESTS` 空。AC 审查3轮不能记成测试通过3轮。
- desktop 有编排版业务实测；mobile 有 OPPO Android 11 真机环境与驱动验证，但非业务项目验收；其他四品类尚需代表项目实测。
- 真流程 O3 当前归档仅有早期快照。v131 完整 Attack/Defense/Arbiter 收敛报告未核实；不能标记完整 AC PASS。

## 当前优先问题

1. GWT 同US存在pass+skip仍可判pass（已有测试本轮复现）。
2. 回滚失败/不完整仍可显示成功；文件、会话、阶段一致恢复未闭环。
3. 模板资源部署漂移；asar优先候选未解决实际extraResources发布路径。
4. pending已落盘但恢复消费不足；拒因逐项清单与可靠续接待补。
5. 驱动环境blocked与宿主fail/error解释不一致，可能误扣修复预算。
6. 编码前验收规格、testing点选修改、持久验收摘要和可启动交付入口待完善。

完整编号、源码锚点及置信边界：[问题台账](../reports/2026-09-20-phase1/项目盘点与问题台账-20260920.md)。

## 下一执行波（计划，未实施）

**B0基线＋B1验收/恢复正确性＋B2资源/拒因/续接补齐**。正确性与部署修复可并行，公共大文件由单一负责人集成。之后B3真流程验证，再执行B4–B6交接、环境协议、用户体验及品类验收。

2026-09-20截至本次归档：上述产品修复未开始；仅完成盘点、计划、验证与项目文档落位。不要读取计划后误记为已交付。

## 最近实际验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 模板/契约/骨架/坑库4文件 | 123 pass / 0 fail | [focused-tests.log](../reports/2026-09-20-phase1/evidence/focused-tests.log) |
| 现有skip规则复现 | 1 pass，证明缺口行为存在，不代表规格正确 | [gwt-skip-policy.log](../reports/2026-09-20-phase1/evidence/gwt-skip-policy.log) |
| 类型检查 | 6包exit 0；首次总命令超时后electron单独完成 | [总日志](../reports/2026-09-20-phase1/evidence/typecheck.log)、[electron日志](../reports/2026-09-20-phase1/evidence/electron-typecheck.log) |
| 全量/build/pack/GUI E2E | 本轮未执行 | 历史75/92 fail需分类，不直接称全为环境性 |

## 本机操作位置

- 源码根：`/home/orphic/proma-patches/p1-quick-engineering`。
- dev安装：`/home/orphic/proma-easy/dev/app/`。
- 真流程样本：`/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-真流程e2e-剪贴板历史/`。
- 编排版样本：`/home/orphic/.proma-dev/agent-workspaces/default/workspace-files/project-剪贴板历史工具e2e/`。
- 仅在执行任务需要时读取上述运行态工程；报告与记忆的权威副本已经在本源码项目内。

## 2026-09-23 当前实施截面（持续执行）

- 代码工作树仍基于 `34f72fbc`，但工作树已包含 B1/B2 实施和审计修复；Electron `0.17.132`、shared `0.1.63` 尚未提交。
- 当前已验证：Electron typecheck exit 0；资源 CLI exit 0；资源/环境/交付/验收定向波 270 pass / 0 fail；恢复波 65 pass / 0 fail；门禁/GWT波 485 pass / 0 fail；focused波15 pass / 0 fail。具体日志见 `docs/reports/2026-09-20-phase1/execution/current-verification/`。
- 当前已修复并经异构审计复核：GWT skip 不通过、恢复事务/锁/跨项目/损坏日志/阶段形状、结构化拒因与幂等续接、资源 manifest/materialize/env freshness、check_env 缺失组件 fail-open、模板 ESM require、pack afterPack资源门禁、验收基线前置与testing绑定、testing点选失效旧交付事实、route missing fail-closed、不可见字符门禁绕过。
- B3 真流程状态：BLOCKED。旧工程只读事实为 CODE、pending target=testing、`06_TESTS`为空；dev未运行且本轮不启动/不部署，不能把源码测试或历史编排样本计为产品验收。证据见 `execution/b3/`。
- B5/B6 六品类状态：协议层/模板层有证据；web/api/mobile/AI缺真实代表工程，desktop历史样本非本轮平台UI流程；真实产品验收仍未建立。B5矩阵原始截面归档于 `/home/orphic/proma-patches/p1-quick-engineering/docs/reports/2026-09-23-phase1-b5/execution/b5/`，其 web 探测旧日志含脚本缺陷，已在当前源码修复后重跑单项确认 exit 0；不能把旧矩阵时间截面冒充当前产品绿。
- 未执行：`electron:build`/pack、真实 afterPack、dev部署、Electron GUI、旧工程恢复入口、新工程端到端、六品类真实产品验收。根盘空间约百MB量级，pack需要至少约1GB；保留为明确未验证/受阻，不清理历史部署物。

## 2026-09-23 21:30–22:20 实施截面（R3 审计收敛 + Task 5 收口）

- **Task 5 收口（源码级）**：新增 4 项测试证明「待纠正拒因重启后仍进入下一轮 L1 上下文」（`_project-info.json` 持久化 → 每轮 L1 prompt 注入拒因段；cancelled 不复活、跨阶段不注入、私钥形态脱敏）。同 eventKey 只领一次、取消不续接、变更产物后需重新生成事件由 `nanju-advance-recovery.test.ts` 覆盖。Task 5 剩余项就此视为源码验证完毕。
- **R3 独立审计（异构只读，2 会话）**已收并处置：
  - delivery-integrity（deepseek-v4-pro）：0 red / 3 yellow / 1 green。
    - D-1 yellow 已修：stale 覆盖后同步 `evidence[].verdict`，完整性告警并入 `staleMessage`。
    - D-2 yellow 已修：UI「暂无测试运行记录」空态仅当 `!hasHistory && history 空` 时展示，消除与历史区的自相矛盾。
    - D-3 yellow 已修：`resolveEntryAbsPath` 前缀校验加 `sep` 分隔符（防兄弟目录 `project-<id>-evil` 前缀命中）；导出并补单测。
    - D-4 green：shared `GwtReportJson` 手工镜像漂移风险，暂不处理（记录在案）。
    - symlink 逃逸：目录 symlink 被 `isDirectory()===false` 天然跳过；文件级 `index.json` symlink 与 >1MB 由 `lstatSync` 拒绝（R3 窗口内父已加，审计复验 41/41）。
  - wiring-semantics（glm-5.3-flash）：1 red / 2 yellow / 1 info + 3 green。
    - W-02 yellow（品类变更复用旧探测结果）**已修**：`isEnvProbeFresh` 增加 `category-mismatch` 判定（落盘 category 与请求不一致即不新鲜，含旧文件无 category），`runEnvProbe` 传 `category` 进新鲜度；补「universal→desktop-app 重跑」与纯函数单测。
    - W-05 red（b6 文档「w-i-b-e-wiring 46/46」不可复现）**已修**：实测 24 pass / 0 fail / 104 expect，更正 b6 两处引用并标注校正来源。
    - W-06 yellow（工作树统计过时）**已修**：更正为 46 M + 26 ?? = 72。
    - W-08 info 已修：`buildEnvProbeSummaryLines` 摘要首行附 `探测品类：xxx`。
    - W-01/W-03/W-04/W-07 green 无需改动。
- **验证**：delivery-view 43/0、env-probe 34/0、router-prompt 135/0、advance-recovery 全绿；4 文件合跑 216 pass / 0 fail；typecheck exit 0；`git diff --check` 通过。审计结论与 recheck 见 `execution/audit-r3/recheck.md`。
- **仍 block**：B3 真流程、B6 六品类产品验收、pack/afterPack/部署（根盘空间不足、dev 未运行且本轮不启动）。

## 2026-09-23 22:25 提交截面

- 首个硬化批次已提交：`4e4f4630`（Phase 1 硬化：恢复事务/结构化拒因/交付视图/验收基线/环境探测）。工作树清零；版本 electron `0.17.132`、shared `0.1.63`、manifest bundle `2.5.0` 已入库。commit trailer 唯一 `Made-with: Proma`；**未推送**。
- 仍 block：B3 真流程、B6 六品类产品验收、pack/afterPack/部署（根盘空间不足、dev 未运行且本轮不启动）。下一波优先解阻磁盘与 dev 实例，再评估 pack 与真流程端到端。

## 2026-09-24 21:20–21:45 实施截面（磁盘解阻 / pack+afterPack 实跑 / dev 启动 / B3 GUI 突破）

- **磁盘解阻**：清理 dotslash/npm/pip/tmp/apt 可再生缓存，根盘 23M → 2.0G 可用（未删旧部署备份与历史数据）。
- **pack + afterPack 门禁首次实跑**：`electron-builder --dir` 产出 out/linux-unpacked/proma（220MB）。
  - attempt1 afterPack 拦截 bundleSha256 不一致（1ebb16 != 397b19），根因是 after-pack-verify-resources.cjs 用 `localeCompare` 排序、权威源 `computeBundleSha256` 用码元比较（CHANGELOG/README 大小写不敏感排到末尾）。已修复 afterPack 排序为码元比较，attempt2 通过（12 required）。
  - 结论：afterPack 门禁非摆设，首次真实打包即拦截门禁脚本自身排序漂移。
- **部署 dev（修复 B5-F-1）**：dev/app/resources/nanju-engineering-templates 从 7 文件（Sep 4 旧版缺 manifest/check_env/driver-skeleton/Spike协议）→ 13 文件完整；app.asar 6698f6… → a894f4…（v0.17.132）。
- **dev 实例启动**：start-dev.sh，9224 CDP 监听，proma-dev 进程正常。
- **B3 GUI 突破**：通过 CDP 9224 操作真实 GUI——南大向导→快速做一个工具→开始创建→新工程 `project-我的快速工具`（workspace-1786847832507）真实创建，8 目录 + `acceptanceBaselineRequired=true` + `archEvidenceGate=true`（createNanjuProject 写入，非测试注入）+ currentStage=requirements。
  - 旧工程 `project-真流程e2e-剪贴板历史` 状态确认：subStage=CODE、coding errorCount=2、pendingAdvanceCorrection 为旧 schema（无 eventKey/checks）、06_TESTS 空——是 Task 5 旧 schema 恢复的真实样本。
- 证据：`execution/b3/gui-live-verification-20260924.md`、`execution/b3/shots/dev-main.png`、`execution/current-verification/pack-20260924.log`。
- 仍待：新工程走完 coding→testing→delivery 全链、GUI 打开旧工程看恢复入口、六品类产品验收（B6）。均不计数 coveredUs。
