# B3 真流程 GUI 实况验证（2026-09-24 21:20–21:45 GMT+8）

> 状态：dev 实例已启动，GUI 真实运行且可程序化交互。旧工程状态已确认。
> 此前的 B3 BLOCKED（dev 未运行 / 无真实产品入口）已解除。

## 解锁前提（本会话完成）

1. **磁盘解阻**：清理 dotslash/npm/pip/tmp/apt 等可再生缓存，根盘从 23M → 2.0G 可用（未删任何旧部署备份与历史数据）。
2. **pack 成功 + afterPack 门禁首次实跑**：见 `../current-verification/pack-20260924.log`。
   - attempt1：afterPack 拦截 bundleSha256 不一致（1ebb16 != 397b19），pack 退出码 1。
   - 根因：after-pack-verify-resources.cjs 用 `localeCompare` 排序，权威源 `computeBundleSha256` 用码元比较，
     localeCompare 把 CHANGELOG.md/README.md 按大小写不敏感排到末尾，导致同一批文件 bundle 指纹不同。
   - 修复：afterPack 排序改码元比较（与 computeBundleSha256 一致）。
   - attempt2：afterPack 通过（12 required），产出 out/linux-unpacked/proma（220MB）。
   - 结论：afterPack 资源门禁非摆设，首次真实打包即拦截了门禁脚本自身的排序漂移。
3. **部署 dev（修复 B5-F-1）**：dev/app/resources/nanju-engineering-templates 从 7 文件（Sep 4 旧版，缺 manifest.json/check_env.sh/driver-skeleton/Spike协议）→ 13 文件（完整）。app.asar sha256 `6698f6…` → `a894f4…`（v0.17.132）。
4. **dev 实例启动**：`start-dev.sh`，9224 CDP 端口监听，proma-dev 进程正常，IPC 注册完成，自动归档 44 个会话。

## GUI 实况证据（CDP 9224 读取）

- 主窗口 `file://…/app.asar/dist/renderer/index.html`，标题 Proma。
- 侧边栏导航项齐全：Agent / Chat / 新会话 / 南大向导 / 项目列表 / 新建项目 / 任务日程Todo / Agent 技能(25)。
- 点击「南大向导」→ 向导面板显示两种模式：「快速做一个工具」（quick）与「做一个长期维护的项目」（长期迭代）。
- 截图存档：`shots/dev-main.png`。

## 旧工程状态确认（恢复入口输入）

`project-真流程e2e-剪贴板历史`（workspace-1786847832507）：
- mode=quick，subStage=CODE，envReady=true。
- coding phaseGuards errorCount=2（lastErrorAt 2026-09-19T21:46）。
- pendingAdvanceCorrection = `{kind:gate-deny, target:testing, expected:testing, at:2026-09-19T22:02, count:1}`（**旧 schema，无 executionState/eventKey/checks/fingerprint**）。
- 06_TESTS 空；00_OBSERVERS 有 O1–O4 观察员记录。

该工程是 Task 5「旧 schema 拒因可恢复」的**真实样本**：`buildPendingAdvanceRecoveryPrompt` 应能
在下一轮 L1 prompt 中注入「待纠正的阶段推进（非推进授权）」段（源码级已有单测覆盖，含「旧schema同样可恢复」）。

## 本轮 verified vs 仍待

**Verified（真 GUI 层）**：dev 实例真实运行、GUI 可交互（南大向导/新建项目入口可点击并渲染）、旧工程状态从 dev 工作区读取一致。

**仍待（需更系统 GUI 自动化）**：
- 完整新建工程向导多步流程（quick 模式从 PRD 到 coding 的端到端）。
- 在 GUI 中切换到 workspace-1786847832507 并打开旧工程，观察「待纠正阶段推进」横幅/续接入口。
- 六品类真实代表工程产品验收（B6）。
- 这些仍不计数为 coveredUs（见既有阻塞协议）。

---

## 追加：新工程平台 UI 流程创建（真实通过）

通过 CDP 9224 操作真实 GUI：南大向导 → 「快速做一个工具」→「开始创建」→ 新工程会话视图。

**产物**（workspace-1786847832507/workspace-files/project-我的快速工具）：
- 8 个标准目录落盘：00_SPIKES / 01_PRD / 02_UX_DESIGN / 03_ARCHITECTURE / 04_API_SPEC / 05_PROJECT_PLAN / 06_TESTS / 07_VERSIONS / 08_APP。
- `_project-info.json`：mode=quick、`acceptanceBaselineRequired=true`、`archEvidenceGate=true`、sessionId=c8d9527d。
- `_nanju-projects.json`：currentStage=requirements、status=active。

**证据链**：GUI 点击 → 主进程 `createNanjuProject`（nanju-project.ts:345-356）写入 `acceptanceBaselineRequired: true` + `archEvidenceGate: true` + 标准目录 → 项目登记 requirements。

**意义**：此前 B3「干净工程平台 quick 全链」BLOCKED 的核心阻塞（dev 未运行）已解除；
新工程创建的真实 UI 流程走通，且 Task 9 验收前置标记在真实平台流程中生效（非测试注入）。
此项仍按既有阻塞协议不计数为「六品类产品验收」的 coveredUs（新工程尚未走过 coding→testing→delivery 全链）。

## 本轮 verified / 仍待（更新）

**Verified（真 GUI 层）**：
- dev 实例真实运行 + GUI 可交互（南大向导、新建项目、模式选择、开始创建均可点击渲染）。
- 新建工程 quick 模式真实创建成功，验收前置标记 + 标准目录落盘（真平台流程，非源码测试）。

**仍待（需更系统 GUI 自动化 / 更长时间）**：
- 新工程从 requirements 走完 coding→testing→delivery 全链（需 Agent 会话实际执行 + 委派）。
- 在 GUI 中打开旧工程 project-真流程e2e-剪贴板历史，观察「待纠正阶段推进」恢复入口。
- 六品类真实代表工程产品验收（B6）。
