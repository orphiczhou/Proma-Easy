# B3 干净对照工程推演 + 恢复/路由相关测试矩阵

> 任务：B3 只读验证｜生成：2026-09-23 19:11 GMT+8
> 边界声明：干净工程为「从源码契约/创建入口推演所需步骤」，本会话无运行中的 dev，**明确 blocked**；仅用 bun 跑了当前工作树的恢复/路由相关测试（源码级，非产品验收）。

## 0. 结论速览

| 项 | 值 |
|---|---|
| 干净工程 | `project-剪贴板历史工具e2e`（release 侧编排样本，**非平台 quick 引擎驱动**） |
| 位置 | `/home/orphic/.proma-dev/agent-workspaces/default/workspace-files/project-剪贴板历史工具e2e/` |
| 契约 | engineering.json schema v2，3 条 tests（unit/integration/acceptance），entry=`src/main.py` |
| 推演状态 | 已从契约/创建入口推演所需步骤 |
| 可运行 dev | **无**（无 proma-dev 进程，CDP 9224 未监听） |
| 判定 | **blocked** |

## 1. 干净工程性质

`_project-info.json` 明示：

```json
{
  "projectId": "剪贴板历史工具e2e",
  "mode": "quick",
  "sessionId": "0ae71da9-45b9-4294-a118-d5b62d8defa3",
  "subStage": "TEST_JUDGE",
  "note": "E2E 编排工程（非平台 UI 流程创建）：多角色会话由 release 侧指挥官驱动；PRD/UX/04/05/07 及 features 为事后按 PRD §5.3 快消型规范补档"
}
```

README 首行即声明：**「非平台 quick 流程引擎驱动——故无 requirements/prototype 阶段产物」**。

→ 该工程是 **release 侧指挥官多角色会话手工编排** 的对照样本，不是平台 quick 引擎从正常入口创建的。因此：
- 它的 06_TESTS（16/16 run-rounds 全绿）证明的是**编排能力 + 模板局部能力**，不能作为平台 quick 引擎真流程闭环的验收证据。
- 它只能作为「干净对照」的参考：契约结构、测试三层、环境声明、驱动用法可对照真流程工程。

## 2. 契约与创建入口推演

### 2.1 engineering.json（schema v2）关键字段

| tests[].id | layer | adapter | target | covers | requiresReal |
|---|---|---|---|---|---|
| tst-unit-history-store | unit | cli-driver | src/history_store.py | [] | false |
| tst-integration-clipboard | integration | native-driver | src/clipboard.py | [] | true |
| tst-acceptance-loop | acceptance | native-driver | src/main.py | US-01~US-05 | true |

- entry：`src/main.py`；run：`python3 src/main.py`（需 DISPLAY + X11 会话）
- build：`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`（仅 xclip 系统依赖）

### 2.2 干净工程从头走通的所需步骤（推演）

要在平台 quick 引擎下完成一次干净真流程，需要：

1. **启动隔离 dev 实例**：`PROMA_INSTANCE=dev PROMA_DEV=1`，CDP 9224，DISPLAY + DBUS。
2. **正常入口创建全新工程**：南大向导 → 快消卡 → 起唯一名 → 独立数据目录 → 发送自然语言需求。
3. **全链真实推进**：需求(PRD+AC) → 原型 → 架构(契约+Spike) → 编码(08_APP) → testing(06_TESTS report) → 试用 → 确认交付。
4. **06_TESTS 落真实 report**，核对 PRD/契约/代码指纹与 runId，展示产物实际启动。

### 2.3 当前可行性判定

| 前置条件 | 当前状态 |
|---|---|
| 运行中的 dev 实例（proma-dev 进程） | ❌ 未运行 |
| CDP 9224 监听 | ❌ 未监听（9222 是 chrome zhihu，9333 是 chrome headless，均非 dev） |
| 任务边界允许启动 dev | ❌ 本任务为只读验证，禁止启动 dev |

→ **干净工程从头走通 = blocked**，无法在本会话执行。

## 3. 环境 GUI 可用性

| 检查 | 结果 |
|---|---|
| DISPLAY | `:12.0`，xdpyinfo 正常（X.Org 21.1.11，screen 2200x1000） |
| dbus ScreenSaver | org.gnome.ScreenSaver 服务不存在（无法通过 dbus 判锁屏） |
| 旧工程 README 记录 | :12.0 会话处于锁屏（交互类断言 BLOCKED），:99 Xvfb 通道可补采证 |

> 即便 DISPLAY 可达，真流程 GUI 验证仍需运行中的 dev 实例；dev 未运行 + 禁止启动 → GUI 验证无法开展，结构化 blocked。

## 4. 恢复/路由相关测试（bun，源码级）

**命令**（工作树含 B1/B2 未提交改动）：

```bash
export PATH=/home/orphic/.bun/bin:$PATH
bun test \
  apps/electron/src/main/lib/nanju-project-snapshots.test.ts \
  apps/electron/src/main/lib/nanju-snapshot.test.ts \
  apps/electron/src/main/lib/__tests__/nanju-file-snapshot.test.ts \
  apps/electron/src/main/lib/nanju-gwt-runner.test.ts \
  apps/electron/src/main/lib/nanju-router-gate.test.ts \
  apps/electron/src/main/lib/nanju-advance-recovery.test.ts \
  apps/electron/src/main/lib/__tests__/w17-phase-advance-chain.test.ts
```

**结果**：

| 项 | 值 |
|---|---|
| exit code | **0** |
| 耗时 | **57 s**（56.24s） |
| pass | **399** |
| fail | **0** |
| expect() calls | 1477 |
| files | 7 |
| git SHA | `34f72fbc8114608b998eaf4e1f5e1937f3deeb59` |
| 工作树 | dirty，68 个未提交文件（Electron 0.17.132 / shared 0.1.63 未提交） |
| 完整日志 | `docs/reports/2026-09-20-phase1/execution/b3/recovery-routing-tests.log` |

**口径声明**：这些是当前工作树（含 B1/B2 未提交修复）的恢复/路由相关**源码级**测试，覆盖快照/恢复/文件快照/GWT 裁判/路由门禁/推进恢复/阶段推进链。测试绿只证明代码层逻辑通过，**不等于**旧工程已恢复、不等于真流程 testing 通过、不等于产品验收完成。coveredUs 仍为空。

## 5. 证据链

- 干净工程控制文件：`_project-info.json`、README.md、`03_ARCHITECTURE/engineering.json`、`06_TESTS/SUMMARY.md`
- 环境：`ps`（无 proma-dev 进程）、`ss -tlnp`（9224 未监听）、`xdpyinfo`（:12.0 可达）
- 测试日志：`recovery-routing-tests.log`（同目录）
- 结构化结论：`findings.json`（同目录）
