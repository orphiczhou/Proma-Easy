# R3 独立审计报告 · 交付视图增量（delivery-integrity）

> 独立只读审计会话。对象：p1-quick-engineering 未提交工作区（HEAD `34f72fbc`）。
> 时间窗：2026-09-23 21:14–21:30 GMT+8｜electron 0.17.132 / shared 0.1.63。
> 范围：本轮父会话新增/修改的交付视图增量——`nanju-delivery-view.ts`（mapReportVerdict 计数不变量、reportIntegrityWarnings、readDeliveryHistory、buildDeliveryViewModel 新增 history 字段）、`shared/types/nanju-delivery.ts`（DeliveryHistoryEntry、history 必填、buildDeliveryLaunchInstructions 品类分支）、`DeliveryCard.tsx`（历史验收记录列表）。
> 方法：只读源码审查 + 隔离 HOME 子进程反例（41 项，/dev/shm 夹具，执行后清理）+ /dev/shm 前缀边界实测。
> 约束遵守：未委派 / 未 commit / 未部署 / 未启动 release-dev / 未修改产品代码与 AGENTS 配置。
> ⚠️ **并发修改观察**：审计窗口内 `nanju-delivery-view.ts`（mtime 21:19:10）与其测试（21:19:13）被父会话/并行 worker 追加了 `lstatSync` 加固（拒绝 symlink `index.json` 与 >1MB 文件）。本报告全部结论基于 21:19 后稳定态复验（41/41 反例通过），并附 mtime 证据。本次追加的加固恰好覆盖了审计过程发现的 symlink `index.json` 跟随读取面。

## 0. 结论速览

交付视图增量的反向映射总体扎实，**无 red（高危）发现**。核心新增断言（mapReportVerdict 计数不变量、readDeliveryHistory 目录白名单 + lstat 校验）经反例实测全部生效，**无任何路径能把坏输入误判为「验收通过」**。

| 级别 | 数量 | 项 |
|---|---|---|
| red | 0 | — |
| yellow（中） | 3 | D-1 stale 覆盖后 evidence[].verdict 不一致、D-2 hasHistory/history 语义分裂、D-3 入口路径前缀边界缺口 |
| green（低/信息） | 1 | D-4 shared GwtReportJson 手工镜像漂移风险 |

## 1. 反向映射（每个新增断言能否挡住坏输入）

### 1a — mapReportVerdict 计数不变量交叉核对 ✅ 全部生效
断言：`passed > 0 && failed === 0 && skipped === 0 && passed === scenariosTotal`，否则 pass 伪造成 `fail`。
反例实测（`negative/delivery-integrity.probe.ts` a1–a8）：

| 输入（verdict 恒为 pass） | 期望 | 实测 |
|---|---|---|
| passed=5/scenariosTotal=5（自洽） | pass | pass ✅ |
| passed=0/scenariosTotal=0（空跑） | fail | fail ✅ |
| passed=6/scenariosTotal=5（>总数） | fail | fail ✅ |
| passed=-1/scenariosTotal=-1（负数） | fail | fail ✅ |
| passed=3/skipped=2（跳过>0） | fail | fail ✅ |
| passed=4/failed=1（失败>0） | fail | fail ✅ |
| passed=NaN | fail | fail ✅ |
| failed=-1（负数） | fail | fail ✅ |

fail/error/blocked verdict 不被计数核对改写（保持区分，不洗成 partial）。**结论：pass 伪造全形态均被拦截。**

### 1b — stale 与 integrity 优先级
- 篡改计数 + 指纹一致 → `verdict=fail`（integrity 拦截，不显示 pass）✅
- 篡改计数 + 指纹不符 → `verdict=stale`（stale 覆盖 fail，优先级合理：改产物必须重跑）✅
- 攻击者「改产物 + 重算指纹」→ `pass`。这是 sha256 信任模型固有边界（代码注释已声明「这不是 OS 沙箱」），非缺陷。
- ⚠️ 见 **D-1**：stale 覆盖后 evidence[].verdict 仍为 fail，且「计数不自洽」告警被 stale 遮蔽。

### 1c — readDeliveryHistory 对坏 tests[] 不误判 pass ✅
- tests=[null,{pass}] / [5,"pass",{pass}] → `not-tested`（null/非对象不计入 passed，但计入 testsTotal，`passed===testsTotal` 永不成立）✅
- status 未知字符串（'skip'/'skipped'/'unknown'）→ 不计入任何桶 → `not-tested` ✅
- generatedAt 非法（数字）→ **不影响 conclusion**（conclusion 纯由 status 计数决定），仅 fallback 到 tests[0].generatedAt 用于展示 ✅
- 有 error → 结论 `error`（优先级 error > fail > blocked > pass）✅

### 1d — runId 目录名白名单 ✅
正则 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` + 拒 '.'/'..'/含 '..'。实测 `a..b`、`.hidden`、140 字符超长名均被拒，`valid-1` 被收，`..evil` 被拒。（'a/b' 因 '/' 不在字符集被正则拒，且文件系统单目录名本不允许 '/'。）

### 1e — history 与 report.json 结论矛盾时的展示
- 历史区是「过去轮次」摘要，与顶部当前 verdict 语义分离，label 已标注「历史验收记录」。
- ⚠️ 见 **D-2**：无 report.json 但有 evidence 时出现「暂无测试运行记录」+「历史验收记录」并存的矛盾展示。

## 2. 安全：readDeliveryHistory 符号链接逃逸

**结论：不逃逸，已双层防护。** 最小复现与机制根因如下（`negative/delivery-integrity.probe.ts` sec1–sec4）：

1. **symlink 目录（`evidence/<runId>` 为指向工程外的目录）**：`readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory())` 对符号链接 `isDirectory()` 返回 false（实测 `isSymbolicLink()=true`、`isDirectory()=false`），故 symlink 目录根本不会进入 `names`，不会读取外部 `index.json`。
2. **symlink 文件（`index.json` 为指向工程外文件的符号链接）**：`readDeliveryHistory` 用 `lstatSync(indexPath)` 校验 `st.isFile() && !st.isSymbolicLink() && st.size<=1MB`，symlink 命中 `isSymbolicLink()` 被 `continue` 跳过（sec3 实测 `findHist('real-dir')=null`）。
3. **超大文件**：`st.size > 1024*1024` 拒绝（sec4 实测 >1MB 被拒）。

需要说明：第 2 点（lstatSync 加固）在本审计窗口内由父会话追加（mtime 21:19:10），本报告在初始读取时该防护尚不存在、仅靠目录级 `isDirectory()` 挡住目录 symlink，文件级 symlink 曾可被 `readFileSync` 跟随读取（信息面小，仅 JSON 字段展示）。当前稳定态已闭合。

**残余（理论，低）**：硬链接（hard link）不会被 `isSymbolicLink()` 识别，但硬链接只能同文件系统内创建，且攻击者若已有写权限可直接读目标文件，不构成信息越权。lstat 校验已达 fail-closed，无需额外 realpath。

## 3. 回归面：DeliveryViewModel 新增必填字段 history

- 唯一构造点 `buildDeliveryViewModel` 恒返回 `history: readDeliveryHistory(projectDir)`（数组），无遗漏分支。
- 消费者仅 preload 类型声明（`Promise<DeliveryViewModel|null>`）、IPC handler（透传）、DeliveryCard（`viewModel.history ?? []` 兜底）。无其他对象字面量构造 DeliveryViewModel，无 mock/快照依赖 history 字段。
- 无 evidence 目录 → `readDeliveryHistory` 返回 `[]`，不抛错（reg1 实测）。
- 坏索引 → 跳过不抛错（reg2 实测）。
- 旧报告缺 retryCount → `validateReportSchema` 返回 null → 降级 not-tested，不崩（reg3 实测）。
- 渲染端旧数据兼容：`?? []` 兜底，主进程未升级（返回无 history 对象）也不崩。

**结论：无破坏性回归。**

## 4. NOT VERIFIED

- **GUI 视觉**：DeliveryCard 历史列表实际渲染、badge 配色/图标未做视觉截图验证。
- **真实工程数据**：仅用合成夹具，未用真实项目 evidence 目录（driver-execution 真实 status 分布）验证。
- **IPC/preload 端到端**：`nanju:get-delivery-view` handler 接线与 `window.electronAPI.nanjuGetDeliveryView` 类型仅静态核对，未运行触发。
- **打包产物**：未 build/pack，未验证 electron-builder 产物内共享类型/模块解析。

## 5. 反例脚本与证据

- 探针：`audit-r3/negative/delivery-integrity.probe.ts`（41 项断言，隔离 HOME 子进程，执行后清理）
- 日志：`audit-r3/negative/delivery-integrity.probe.log`（`total=41 fail=0`）
- 前缀边界实测：/dev/shm 一次性脚本（见 D-3 counterexample，已清理）

## 6. 发现明细

### D-1 — stale 覆盖后 evidence[].verdict 与顶层 verdict 不一致 🟡仍在
- **file**: `apps/electron/src/main/lib/nanju-delivery-view.ts`（line 339–365 / 281）
- **客观引用**：`verdict = 'stale'`
- **论证**：`mapReportVerdict` 先跑（计数不自洽→fail），随后 stale 检测在指纹不符时把顶层 `verdict` 覆写为 `stale`；但 `evidence` 数组在 stale 检测前已由 `buildEvidence` 生成（内部再次 `mapReportVerdict`，不知 stale）。故「篡改报告计数 + 改产物」时顶层 badge=已过期(stale)、evidence[0].verdict=验收未通过(fail)。两者均非 pass（不误判通过），但顶层 stale 完全遮盖「计数不自洽=报告被篡改」的完整性告警（该告警只在 evidence[0].warnings，折叠态不可见）。
- **反例**：probe b3 → `vm.verdict='stale'`，`vm.evidence[0].verdict='fail'`。
- **建议**：stale 判定后同步覆写 evidence[].verdict，并把 integrity 告警并入 staleMessage。

### D-2 — hasHistory 与 history 语义分裂，无 report.json 时 UI 自相矛盾 🟡仍在
- **file**: `nanju-delivery-view.ts`（line 340/374）/ `DeliveryCard.tsx`（line 257 vs 316）
- **客观引用**：`hasHistory = true  // 仅当 report 存在`
- **论证**：hasHistory 由 report.json 决定、history 由 evidence 目录决定。evidence 存在（driver-execution 归档）而 report.json 缺失/被删时，verdict=not-tested、hasHistory=false、history 非空，UI 展开态同时渲染「暂无测试运行记录」与「历史验收记录（最近 N 次）」。
- **反例**：仅写 evidence/run-x/index.json 不写 report.json → `{verdict:'not-tested', hasHistory:false, history:[...]}`。
- **建议**：hasHistory 与 history 非空对齐，或 UI 按 history 非空判断历史区显示。

### D-3 — resolveEntryAbsPath 前缀边界缺口（startsWith 未加分隔符）🟡仍在（既有代码，非本轮增量）
- **file**: `nanju-delivery-view.ts`（line 176–184）
- **客观引用**：`if (!resolved.startsWith(resolve(projectDir))) return null`
- **论证**：realpathSync 已解析 symlink/../，但二次防御 `startsWith(resolve(projectDir))` 无尾部分隔符。构造 report.entry=`../project-<id>-evil/...` 可解析到兄弟目录且通过前缀校验。需篡改 report.entry（正常 GWT 只写项目内相对路径）、仅同 workspace 项目间越界，不可逃到任意绝对路径。
- **反例**：/dev/shm 前缀实测 → `resolved=.../project-<id>-evil/...`，`is_null=false`。
- **建议**：`resolved === resolve(projectDir) || resolved.startsWith(resolve(projectDir) + path.sep)`。

### D-4 — shared GwtReportJson 手工镜像漂移风险 🟢低
- **file**: `packages/shared/src/types/nanju-delivery.ts`（line 34–72）
- **客观引用**：`字段来源：全部从 nanju-gwt-runner.ts GwtReportJson 复制`
- **论证**：shared 侧 GwtReportJson 只镜像子集（缺 engineeringEvidence/blockedReason/retryPending/executionContext/engineeringSuite/coverageUnverified/failureKind/prdUserStoriesMissing/errorCount 等）。delivery-view 只读子集、validateReportSchema 只校验子集，当前无现实漂移；若 gwt-runner 未来改字段名，delivery-view 会误把合法报告降级 not-tested。
- **建议**：从 gwt-runner 类型 import 复用或加字段并集断言防漂移。
