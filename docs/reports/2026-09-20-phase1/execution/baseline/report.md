# Phase 1 · B0 事实与测试基线报告

> 执行会话：B0（执行会话 cfce785b 调度）｜执行时间：2026-09-20 13:37–13:52 GMT+8
> 基线 SHA：`34f72fbc8114608b998eaf4e1f5e1937f3deeb59`（分支 `p1-quick-engineering`，`apps/electron` v0.17.131）
> 产物目录：`docs/reports/2026-09-20-phase1/execution/baseline/`
> 约束履行：未改产品代码、未安装依赖、未构建、未部署/提交/推送、未重启实例；不清理任何既有数据。

---

## 1. 结论摘要

1. **基线可复算**：同一 SHA、同一副本、同一条命令（`PROMA_DEV=1 bun test`）连续跑两次，结果完全一致：
   **2341 pass / 113 fail（真实用例）+ 6 文件级加载错误**，耗时均 73s。
2. **113 个失败全部可归类，且每类都有单文件复跑或定向诊断证据；未发现可被单文件复现的产品代码缺陷**（`productDefectsConfirmed = 0`）：

   | 类别 | 含义 | 失败数 | 涉及文件 |
   |---|---|---|---|
   | A | 测试隔离缺陷（跨文件 `mock.module` / 模块缓存泄漏） | 106 | 14 |
   | B | 环境依赖（真实 dev 配置 override 文件参与模型配置加载） | 6 | 2 |
   | C | 基线方法限制（临时副本无 `.git`） | 1 | 1 |
   | D | 遗留失效用例（引用不存在模块，文件级加载错误，0 用例执行） | 6 个加载错误 | 6 |

   **不得**把这 113 项概括为“环境性失败”：A 类有配对实验的因果证据，B 类有 `PROMA_DEV=0` 对照，C 类有 `GIT_DIR` 对照。
3. **写入边界**：本次基线**未向 release 配置 `~/.proma` 写入**任何内容；在 dev 配置 `~/.proma-dev` 中留下 **1 个测试夹具目录**（`agent-workspaces/__f2_union_nonexistent__/workspace-files/`，由 `nanju-telemetry.test.ts:55` 创建），未修改、未删除任何既有文件，未自行清理。
4. **产品代码完整性**：基线期间工作树变化仅限文档/证据（`M AGENTS.md`、新增 `Agent.md`、`docs/plans/`、`docs/project-memory/`、`docs/reports/`），无产品源文件改动。

---

## 2. 基线与方法

| 项目 | 取值 |
|---|---|
| 源码（只读） | `/home/orphic/proma-patches/p1-quick-engineering` |
| 测试副本 | `/dev/shm/proma-p1-baseline-cfce`（`git archive HEAD \| tar -x`，**不含 `.git`**；仅用于测试，不安装/不构建） |
| 依赖复用 | `cp -a --no-dereference node_modules`（第三方包仍指向 `/home/orphic/proma-source/node_modules`）；**`node_modules/@proma/*` 重建为指向副本自身** `apps|packages`，避免并行会话改源码污染基线 |
| 配置隔离 | `PROMA_DEV=1`（`config-paths.ts` 的隔离变量）→ 配置目录 `~/.proma-dev`；**未设置 HOME**；未使用磁盘 worktree |
| 环境 | Linux 6.8.0-139-generic x86_64；Bun 1.3.14（`/home/orphic/.bun/bin/bun`）；Node v22.23.2；`/dev/shm` 可用 3.8G（系统盘仅 94M 可用，故不使用磁盘副本） |
| 命令 | `export PATH=/home/orphic/.bun/bin:$PATH; export PROMA_DEV=1; cd /dev/shm/proma-p1-baseline-cfce; bun test` |
| 规模 | 发现 163 个测试文件（162 `.test.ts` + 1 `.test.tsx`）；其中 157 个执行了用例，6 个文件加载失败 |

**两次运行**（`test-baseline.json → runs`）：

| runId | 记者 | 开始/结束（UTC） | 耗时 | exit | 报告值 |
|---|---|---|---|---|---|
| full-1-default-reporter | default | 05:38:03 → 05:39:16 | 73s | 1 | 2341 pass / 119 fail / 6 errors，Ran 2460 tests / 163 files |
| full-2-junit-reporter | junit(+stdout) | 05:39:58 → 05:41:11 | 73s | 1 | 同上；junit 汇总 tests=2454 / failures=113 / errors=0 / suites=157 |

---

## 3. 数字口径对账（119 与 113 的差额）

- junit 口径：`2341 + 113 = 2454` = 实际执行的用例数。
- default reporter 口径：`2341 + 119 = 2460`（= “Ran 2460 tests”），另报 “6 errors”。
- 差额 6 = **6 个文件级加载错误被 default reporter 各计为 1 个失败测试**，同时又单列 “6 errors”。即 default reporter 的 119 fail 中有 6 项与文件加载错误重复计数。
  > 证据：junit 只产出 157 个 testsuite（163 − 6），加载失败的 6 个文件无 testsuite；两口径其余数字完全一致。
  > 标注：此处为**观察 + 算术推断**（bun 默认 reporter 的显示语义），不是产品行为结论。

---

## 4. A 类：测试隔离缺陷（106 失败 / 14 文件）

### 4.1 判据

- 判据规则：**该文件单独运行 100% 通过；仅在与其它测试文件同进程串行运行（`bun test` 全量）时失败**。
- 机制（仓库内既有注释已确认）：bun `mock.module` 在本版本**进程级全局生效且跨文件泄漏**，模块缓存同样跨文件共享 → 先注册的桩/先导入的真实模块会污染后续文件。

### 4.2 逐文件结果（全量失败数 vs 单文件复跑）

| 文件 | 全量失败 | 单文件复跑 | 说明 |
|---|---|---|---|
| `agent-session-manager.test.ts` | 21 | 21 pass / 0 fail | `manager.truncateSDKMessages is not a function`（被桩替换） |
| `__tests__/w17-phase-advance-chain.test.ts` | 17 | 117 pass / 0 fail | 埋点写入 `/tmp/nanju-w17-*/_telemetry/...` 出现 ENOENT 等 |
| `channel-manager.test.ts` | 16 | 18 pass / 0 fail | `channelManager.decryptApiKey/createChannel is not a function` |
| `nanju-delegate-guard.test.ts` | 11 | 141 pass / 0 fail | 期望模型 `glm-5-turbo` 收到 `undefined`、埋点长度 0 |
| `__tests__/w18-delivery-gate.test.ts` | 9 | 27 pass / 0 fail | 门禁事实判定被污染为 false |
| `nanju-clarify-proxy.test.ts` | 7 | 41 pass / 0 fail | 代决链路桩未生效 |
| `nanju-guide-progress.test.ts` | 7 | 21 pass / 0 fail | write-then-emit 未观测到 |
| `channel-runtime-api-key.test.ts` | 5 | 5 pass / 0 fail | `resolveChannelRuntimeApiKey is not a function` |
| `agent-model-selection.test.ts` | 4 | 4 pass / 0 fail | 收到别处桩内文案（见 P3） |
| `nanju-model-fallback.test.ts` | 3 | 13 pass / 0 fail | 降级埋点计数 0 |
| `__tests__/w18-delegate-intent.test.ts` | 2 | 27 pass / 0 fail | violations 长度 0 |
| `nanju-gwt-runner.test.ts` | 2 | 107 pass / 0 fail | report/埋点断言 |
| `dingtalk-config.test.ts` | 1 | 4 pass / 0 fail | 钩子阶段 `SyntaxError: Export named 'safeStorage' not found in module '.../electron/index.js'` |
| `nanju-phase-guard.test.ts` | 1 | 12 pass / 0 fail | 两计数独立断言 |
| **合计** | **106** | 全部 0 失败 | |

### 4.3 已最小化确认的污染链（配对实验，`pairExperiments` P1–P4）

| 编号 | 先运行（污染源） | 受害文件 | 配对结果 | 复现失败数 | 关键证据 |
|---|---|---|---|---|---|
| P1 | `nanju-router-prompt.test.ts` | `channel-manager.test.ts` | 131 pass / 17 fail | 16 / 16 | 前者 9 处 `mock.module('./channel-manager')` 泄漏；受害文件单跑 18/0 |
| P2 | `nanju-router-prompt.test.ts` | `agent-session-manager.test.ts` | 132 pass / 19 fail | 18 / 21 | 同样泄漏 `./agent-session-manager` 桩 |
| P3 | `nanju-model-fallback.test.ts` | `agent-model-selection.test.ts` | 13 pass / 4 fail | 4 / 4 | 受害用例收到字符串「跨渠道协作子会话：未配置默认模型（本桩不覆盖该路径）」，该串**仅**存在于 `nanju-model-fallback.test.ts:93` 与 `nanju-clarify-proxy.test.ts:96` 的桩中 → 泄漏源可文本定位 |
| P4 | `nanju-clarify-proxy.test.ts` | `channel-runtime-api-key.test.ts` | 41 pass / 5 fail | 5 / 5 | 同上一桩源；受害文件单跑 5/0 |
| P5 | `nanju-snapshot.test.ts` | `agent-session-manager.test.ts` | 6 pass / 1 fail | —（钩子阶段即失败，大量用例未执行） | 说明该受害文件同时受多个文件影响 |

**阴性对照（避免“凡是配对都算污染”）：**

| 编号 | 配对 | 结果 | 结论 |
|---|---|---|---|
| P6 | `nanju-telemetry.test.ts` + `w17-phase-advance-chain.test.ts` | 121 pass / 0 fail | w17 的污染源不是 telemetry |
| P7 | `nanju-router-gate.test.ts` + `nanju-delegate-guard.test.ts` | 238 pass / 0 fail | delegate-guard 的泄漏源未被该配对复现（**污染源未最小化确认**） |

### 4.4 未完成最小化的部分（如实标注）

`w17-phase-advance-chain`、`nanju-delegate-guard`、`nanju-guide-progress`、`w18-delivery-gate`、`w18-delegate-intent`、`nanju-gwt-runner`、`nanju-phase-guard`、`dingtalk-config`、`nanju-model-fallback`、`agent-session-manager`（部分路径）的**污染源文件未逐一最小化确认**；它们已确认为 A 类（单文件复跑全绿 + 全局 mock 清单：17 个文件 mock `./config-paths`、9 个 mock `./agent-session-manager`、9 处桩 `./channel-manager`、11 个 mock `'electron'`、5 个 mock `'node:os'`，且**无任何 `mock.restore()`**）。

---

## 5. B 类：环境依赖（6 失败 / 2 文件）

**根因（已定向诊断确认）**：真实用户 dev 配置 `~/.proma-dev/nanju-model-config-override.json`（2026-09-14 15:58 写入）参与模型配置加载：

```json
{ "phases": { "planning": { "channel": "deepseek", "model": "deepseek-v4-pro",
  "fallbacks": ["deepseek:deepseek-flash"] } } }
```

- `nanju-model-config.test.ts` 的失败用例只传 `userConfigPath: null, builtinConfigPath: null`，**未传 `overrideConfigPath: null`**；实现为 `if (opts.overrideConfigPath !== null) { const path = opts.overrideConfigPath ?? getUserNanjuModelOverridePath() ... }`，`undefined` 仍落到默认真实路径 → 读入该 override。
- `nanju-router.test.ts` 的 1 项失败同理：PHASE 节点 planning 主选被 override 改成 `deepseek-v4-pro`，与用例期望的 `deepseek-flash` 冲突。

| 诊断 | 命令 | 结果 | 对照（PROMA_DEV=1） |
|---|---|---|---|
| D1 | `PROMA_DEV=0 bun test apps/electron/src/main/lib/nanju-model-config.test.ts` | **35 pass / 0 fail** | 30 pass / 5 fail |
| D2 | `PROMA_DEV=0 bun test apps/electron/src/main/lib/nanju-router.test.ts` | **44 pass / 0 fail** | 43 pass / 1 fail |

> `PROMA_DEV=0` 时配置目录为 `~/.proma`，该目录**不存在** `nanju-model-config-override.json`（已验证）。

---

## 6. C 类：基线方法限制（1 失败 / 1 文件）

- `nanju-router-prompt.test.ts` 用例「返工二 F3-2：off 冻结串独立证明……与 054f0721（v0.17.97）逐字一致」通过 `execSync('git show 054f0721:...')` 取历史文件；`git archive` 副本**无 `.git`** → `fatal: not a git repository`。
- 诊断 D3：`GIT_DIR=/home/orphic/proma-patches/p1-quick-engineering/.git bun test apps/electron/src/main/lib/nanju-router-prompt.test.ts` → **130 pass / 0 fail**。
- 结论：**基线副本方法造成，非产品缺陷**；真实仓库（含 `.git`）内该用例预期通过。为控制风险（避免 `GIT_DIR` 泄漏导致测试对真实仓库执行 git 写操作），未以此模式重跑全量。

---

## 7. D 类：遗留失效用例（6 个文件级加载错误）

| 文件 | 加载错误 |
|---|---|
| `docs/DesignDoc/06_TESTS/unit-llm-mock.test.ts` | `Cannot find module '../src/coder/coder-engine-stub'` |
| `docs/DesignDoc/06_TESTS/unit-judge-timeout.test.ts` | `Cannot find module '../src/common/proma-cloud-llm-client'` |
| `docs/DesignDoc/06_TESTS/unit-judge-hardchecks.test.ts` | `Cannot find module '../src/judge/judge-engine-stub'` |
| `docs/DesignDoc/06_TESTS/unit-coder-gwt-autofix.test.ts` | `Cannot find module '../src/coder/coder-engine-stub'` |
| `docs/DesignDoc/06_TESTS/e2e-ipc-cross-layer.test.ts` | `Cannot find module '../electron/main'` |
| `docs/DesignDoc/06_TESTS/e2e-coder-judge.test.ts` | `Cannot find module '../src/coder/coder-engine-stub'` |

- 这些文件在 git 中受管（`docs/DesignDoc/06_TESTS/`），引用的旧模块在当前架构中不存在；单文件复跑同样失败。
- 影响：每次全量 `bun test` 固定产生 6 个加载错误，并使 default reporter 多报 6 个 fail。

---

## 8. 配置目录写入边界（快照对比）

对比方式：`find <dir> -printf '%p\t%s\t%T@\n' | sort`，基线前 05:37:59Z、检查点约 05:43Z（含全部隔离/配对运行）。

| 目录 | 结论 | 明细 |
|---|---|---|
| `~/.proma`（release） | **本基线未写入** | 全部差异均为并发 Proma 实例/其他 agent 会话自身的产物（`agent-sessions.json`、`agent-sessions/*.jsonl`、`sdk-config/sessions/*.jsonl`）；两个新会话 jsonl 的创建时间（05:39:39Z、05:42:08Z）落在两次测试运行之间/之后，非测试进程产生；无测试夹具命名文件出现 |
| `~/.proma-dev`（dev） | **新增 1 个目录（增量）** | `agent-workspaces/__f2_union_nonexistent__/` 与 `.../workspace-files/`，创建于 05:38:05Z；来源 `apps/electron/src/main/lib/nanju-telemetry.test.ts:55`（`slug = '__f2_union_nonexistent__'`）。未修改、未删除任何既有文件 |

按授权要求**未自行清理**该残留；如需清理请由指挥官确认（`rm -rf ~/.proma-dev/agent-workspaces/__f2_union_nonexistent__`）。

另：本机 `bwrap` / `unshare --user` 均被拒绝（`setting up uid map: Permission denied`），无法把 `~/.proma-dev` 挂载到临时目录，因此改用 `PROMA_DEV=1` + 快照对比界定写入边界（已记入限制）。

---

## 8bis. 基线之后工作树出现并行改动（重要）

基线副本在 13:37 由 `git archive HEAD` 固化。测试运行期间（13:46–13:47），**其他并行执行会话**开始修改源码工作树：

| 文件 | 状态 | mtime | 归属（按计划任务判断） |
|---|---|---|---|
| `apps/electron/src/main/lib/nanju-engineering-template.ts` | ` M`（-34/+…） | 13:46:26 | B2 Task 4（统一模板发布来源与依赖分发） |
| `apps/electron/src/main/lib/nanju-gwt-runner.test.ts` | ` M`（+127） | 13:46:17 | B1 Task 1（必测场景 skip 不得判整体通过） |
| `apps/electron/src/main/lib/nanju-engineering-resources.ts` | `??` 新增 | 13:47:03 | B2 Task 4 |
| `apps/electron/resources/nanju-engineering-templates/manifest.json` | `??` 新增 | 13:47:12 | B2 Task 4 |

**B0 自身未改动任何产品文件**，证据：副本内 `nanju-engineering-template.ts` 与 `nanju-gwt-runner.test.ts` 的 sha256 与 `git show HEAD:<file>` 完全一致（`0477a446b7452fa0…` / `9ddc0ff3150309b9…`）；B0 的写入范围仅为 `/dev/shm/proma-p1-baseline-cfce*` 与本 baseline 目录。

**影响**：本报告全部数字对应固化于 `/dev/shm` 的 HEAD 快照，**不是**当前工作树。任何后续对比必须重新固定 SHA；若直接用当前工作树重跑全量，`nanju-gwt-runner.test.ts` 等用例集已变，数字不可与本基线直接相减。

---

## 9. 产物清单

| 文件 | 说明 |
|---|---|
| `report.md` | 本报告 |
| `test-baseline.json` | 机器可读基线：SHA、方法、环境、两次运行、计数与口径对账、113 条失败（testId=文件:行号 + suite + 用例名 + 错误原文 + 期望/实际 + 分类 + 单跑结果 + 复现命令）、6 条加载错误、单文件隔离结果、7 组配对实验、3 项环境诊断、配置写入检查、完整复现步骤、限制 |
| `full-tests.log` | 全量运行的原始 stdout/stderr（569 KB，已扫描：无 API Key / Token / JWT 等秘密） |
| `junit-full-tests.xml` | 同一次全量的 junit 结果（机器可读、含文件名/行号/断言数），用于口径对账 |
| `isolated-runs.tsv` | 23 个文件的单文件复跑索引（17 个失败文件 + 6 个加载错误文件）：rc/pass/fail/errors/耗时 |

---

## 10. 限制与不可推断事项

1. **副本无 `.git`** → 1 项冻结串对照用例必然失败（C 类，已诊断排除产品因素）。
2. **B0 只覆盖可执行测试**：未做 `typecheck` / `build` / `pack`、未做真实流程（B3）、UI 行为（B6）、部署资源落位（B2）验收。不得由本报告推断“产品无缺陷”或“交付可用”。
3. **A 类污染源未全部最小化**（见 4.4）；A 类的“全量失败”数不应作为产品缺陷台账，应作为**测试基础设施缺陷**台账。
4. **并发写源码**：本基线的两次运行结果一致，但另有多会话并行改源码；任何后续对比必须重新固定 SHA，不得套用本基线数字。
5. 1 条失败（`nanju-model-config.test.ts`「非法 JSON / 根结构非对象 → warn 跳层」）在 stdout 中未打印错误明细原文，仅有 `testId` 与 `assertionLocation`；其分类有 `PROMA_DEV=0` 对照（同为 B 类）支撑。
6. 本报告不评价 `docs/` 下文档用例是否“应当删除”，只记录事实。

---

## 11. 后续建议（供 B1/B2 与指挥官取用）

1. **测试基础设施（建议优先级最高，成本低、收益大）**：把 A 类泄漏修复纳入 B0 收尾或 B1 起点——(a) 每个被 mock 的模块桩改为“文件级 fixture + `mock.restore()`”；(b) 需要真实模块的文件（`channel-manager`、`agent-session-manager`、`agent-model-selection`、`channel-runtime-api-key`）在 `beforeAll` 前禁止其它文件注册同名桩；(c) CI 增加“核心门禁/恢复/验收套件逐文件独立运行”清单，避免全量污染掩盖真实失败。
2. **B 类**：测试侧显式传 `overrideConfigPath: null` 即可消除对用户 dev 配置的依赖；产品侧是否需要“显式 null 才能禁用 override 层”的语义加固，交由 B1/B2 判定（本次不改代码）。
3. **D 类**：6 个 `docs/DesignDoc/06_TESTS/*` 加载错误建议列入“待裁决/归档”清单，或从默认发现范围排除，避免每次全量固定噪声；不在 B0 范围内处置。
4. **后续批次建立红测试时必须固定 SHA 并使用本报告的单文件复跑口径**（否则新失败可能被 A 类污染掩盖，或把污染误判为真失败）。
5. 计划 Task 0 提到的 `acceptance-matrix.md`（四列：实现/测试/真流程/产品验收）与刷新 `evidence/inventory-snapshot.json` **不在本次 brief 的 DoD 内**，未产出；请指挥官确认是否指派。
6. **异常关注点（留待 B2/B5 事实核对，非本基线结论）**：`~/.proma-dev/nanju-model-config-override.json` 会把 planning 主选改写为 `deepseek-v4-pro`——若该文件也参与真实运行时的模型选择，将影响阶段模型矩阵与家族多样性，建议 B2/B5 在“机器事实/配置来源”核对时确认其生效范围。

---

## 12. 复现命令

```bash
# 1) 建立隔离副本（不安装、不构建）
export PATH=/home/orphic/.bun/bin:$PATH
rm -rf /dev/shm/proma-p1-baseline-cfce && mkdir -p /dev/shm/proma-p1-baseline-cfce
cd /home/orphic/proma-patches/p1-quick-engineering
git archive HEAD | tar -x -C /dev/shm/proma-p1-baseline-cfce

# 2) 复用依赖（第三方包指向 proma-source；@proma/* 指向副本自身）
cp -a --no-dereference node_modules /dev/shm/proma-p1-baseline-cfce/node_modules
rm -rf /dev/shm/proma-p1-baseline-cfce/node_modules/@proma
mkdir -p /dev/shm/proma-p1-baseline-cfce/node_modules/@proma
for p in packages/*/ apps/*/; do n=$(basename "$p")
  ln -s "/dev/shm/proma-p1-baseline-cfce/${p%/}" "/dev/shm/proma-p1-baseline-cfce/node_modules/@proma/$n"; done

# 3) 全量基线（结果应与本报告一致：2341 pass / 119 fail / 6 errors）
cd /dev/shm/proma-p1-baseline-cfce
PROMA_DEV=1 bun test                       # 默认 reporter
PROMA_DEV=1 bun test --reporter=junit --reporter-outfile=/tmp/junit.xml

# 4) 单文件复跑（识别 A 类污染）
PROMA_DEV=1 bun test apps/electron/src/main/lib/channel-manager.test.ts

# 5) 定向诊断
PROMA_DEV=1 bun test apps/electron/src/main/lib/nanju-router-prompt.test.ts \
  apps/electron/src/main/lib/channel-manager.test.ts          # P1：配对复现泄漏
PROMA_DEV=0 bun test apps/electron/src/main/lib/nanju-model-config.test.ts   # D1：B 类对照
GIT_DIR=/home/orphic/proma-patches/p1-quick-engineering/.git \
  bun test apps/electron/src/main/lib/nanju-router-prompt.test.ts            # D3：C 类对照
```

*报告结束。基线结果即事实证据；除本文件标注的“观察 + 推断”项外，结论均由 `test-baseline.json`、`full-tests.log`、`junit-full-tests.xml` 中的原始记录支撑。*
