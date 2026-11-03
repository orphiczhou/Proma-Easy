# Phase1 Task 11 第一核心片实施报告 — 驱动 blocked 协议：骨架环境阻塞 → 宿主解释 → suite/GWT 修复预算一致

> 文档版本：1.0.0｜执行会话：driver worker（父 cfce785b 国内模型授权；本会话 945b6093，模型 deepseek-v4-pro）
> 提交基线：`34f72fbc8114608b998eaf4e1f5e1937f3deeb59`｜实施日期：2026-09-20 GMT+8
> 范围：Phase1 plan §8 Task 11「驱动 blocked 协议、断言有效性、执行限制与归档」的第一核心片

---

## 1. 任务摘要与结论

打通「骨架环境阻塞 → 宿主解释 → suite verdict → GWT 修复预算」整条链的状态一致性：环境缺失（缺 DISPLAY / 设备不可达 / 密钥变量）必须判为 `blocked`（coveredUs 空、不消耗产品修复预算），而产品 fail / 崩溃 / 坏 schema 与伪造 exit 2 一律不得洗成 blocked。

**结论：** 已修复。阻塞结果现在以结构化 `blocked` 标记承载，宿主校验「来源 / 诊断 / 被测场景未执行」后才判 blocked；旧协议（exit 2 + 环境前置自检签名）保留兼容映射；其余 exit 2 落回产品判定（fail/error）。

---

## 2. 复现：emit_blocked 被 interpret 误判

**修复前行为（代码事实，本片直接复现目标）：**

- 骨架 `emit_blocked` 输出 `{testId, target, checks:[{storyId: covers[0]||null, label:'环境前置自检', expected:'环境就绪', actual:'缺失: DISPLAY', evidence:[…]}]}` 并 exit 2。
- 宿主 `interpret` 对 checks 循环校验：该检查 `expected('环境就绪') ≠ actual('缺失: DISPLAY')` → `passed=false`；且 `raw.exitCode(2) !== 0` → `passed=false` → **status = 'fail'**。
- 因此 `runEngineeringSuite` 把环境阻塞当作**产品失败**汇总，GWT 层 `verdict='fail'`、`retryCount+1`，**误消耗产品修复预算**（与本片架构原则「blocked 不扣产品预算」相悖）。

**修复后行为（新测试断言）：**

- 新骨架输出 `{testId, target, blocked:{kind:'environment', missing:['DISPLAY'], scenarioExecuted:false}, checks:[]}` 并 exit 2。
- 宿主 `interpretBlocked` 校验标记后返回 `status='blocked'`、`coveredUs=[]`、`checks=[]`、reason 含「不计入产品修复」。
- suite verdict=`blocked`（非 fail），GWT 层 `blockedReason` → `retryCount` 保持不变、不进入修复预算。

---

## 3. 协议设计（明确兼容策略）

### 3.1 新协议（结构化 blocked 标记，权威）

骨架 `emit_blocked` 输出：

```json
{
  "testId": "…", "target": "…",
  "blocked": { "kind": "environment", "missing": ["DISPLAY"], "scenarioExecuted": false },
  "checks": []
}
```

宿主 `interpretBlocked` 校验（任一不符即 error，fail-closed）：

| 校验项 | 规则 |
|---|---|
| 退出码 | `blocked` 必须伴随 exit 2，否则 error（退出码不一致） |
| kind | 必须 `environment` |
| missing | 非空字符串数组（结构化诊断来源；空数组无法校验 → error） |
| scenarioExecuted | 必须 `false`（明确「被测场景未执行」，与产品 fail 区分） |
| checks | 必须为空（阻塞不得携带产品检查） |
| error | 不得同时携带 error 信息 |

### 3.2 旧协议兼容（已复制到存量工程的旧骨架）

新骨架改用结构化标记后，存量工程里的旧骨架仍走 exit-2 自检拦截。宿主按旧签名区分：

| 旧签名 | 判定 |
|---|---|
| exit 2 + 单条 `label='环境前置自检'` | `blocked`（环境，向后兼容） |
| exit 2 + 单条 `label='输出schema自检'` | `error`（坏 schema 不得洗成 blocked） |
| 其余 exit 2（无结构化标记、无合法自检签名） | **落回产品判定**：有有效 checks → `fail`（非零退出）；空 checks → `error` |

> 关键修正：异常 exit 2 不再被无条件归 error，而是「不被洗成 blocked」即可——既有语义「退出码来自 OS、子进程异常退出不能由输出报告覆盖」（process-driver.test.ts 的 exit 2 用例）保持不变（`fail`）。

---

## 4. 交付清单

### 4.1 修改文件（独占范围）

| 路径 | 改动 |
|---|---|
| `apps/electron/src/main/lib/nanju-engineering-execution.ts` | `interpret` 新增结构化 blocked 识别 + 旧协议 exit-2 兼容；新增 `interpretBlocked` / `interpretLegacyExit2` 两个纯函数 |
| `apps/electron/resources/nanju-engineering-templates/driver-skeleton.py` | `emit_blocked` 改为输出结构化 `blocked` 标记（kind/missing/scenarioExecuted）+ `checks:[]` + exit 2；头部 ⑤ 说明同步 |
| `apps/electron/resources/nanju-engineering-templates/driver-skeleton.cjs` | `emitBlocked` 同上（Node 版） |
| `apps/electron/src/main/lib/nanju-driver-skeleton.test.ts` | 环境前置自检断言从「checks 含环境自检条目」更新为「结构化 blocked 标记」（Python + Node 两处） |

### 4.2 新增文件

| 路径 | 作用 |
|---|---|
| `apps/electron/src/main/lib/nanju-driver-blocked-protocol.test.ts` | 16 用例：宿主 interpret 单元级校验矩阵 + 跨骨架→宿主集成级六态 + suite verdict 级 |

### 4.3 未触碰文件（禁改 / 其他会话所有）

| 路径 | 状态 | 说明 |
|---|---|---|
| `nanju-gwt-runner.ts/.test.ts` | 未触碰（GLM 所有） | 已只读核验 blocked 链路，见 §6 接线建议 |
| `package.json` / `electron-builder.yml` / `manifest.json` | 未触碰 | autonomy 禁改；manifest 哈希需资源会话刷新（见 §6） |
| `nanju-engineering-process-driver.ts` / `nanju-engineering-suite.ts` | 未改动 | 既有 blocked 短路逻辑已正确，无需改 |
| `nanju-engineering-template.ts`、`README.md`、`shared/types`、`AGENTS.md` | 未触碰 | 其他会话所有 |

---

## 5. 命令与结果

```bash
export PATH=/home/orphic/.bun/bin:$PATH
cd /home/orphic/proma-patches/p1-quick-engineering

# 定向测试（本片 5 个文件，含新集成测试）
bun test apps/electron/src/main/lib/nanju-engineering-execution.test.ts \
        apps/electron/src/main/lib/nanju-engineering-suite.test.ts \
        apps/electron/src/main/lib/nanju-engineering-process-driver.test.ts \
        apps/electron/src/main/lib/nanju-driver-skeleton.test.ts \
        apps/electron/src/main/lib/nanju-driver-blocked-protocol.test.ts
# 结果：63 pass / 0 fail / 186 expect()（跨 5 文件）

# 新增 blocked 协议文件单独跑
bun test apps/electron/src/main/lib/nanju-driver-blocked-protocol.test.ts
# 结果：16 pass / 0 fail

# 类型检查（apps/electron 范围）
cd apps/electron && bun run typecheck
# 结果：exit 0（tsc --noEmit 无输出）
```

新集成测试覆盖六态：`blocked`（骨架声明变量缺失）/ `pass` / `fail`（probe 不符）/ `error`（probe 崩溃，driverIo 透传 traceback）/ `取消`（挂起后 abort → blocked）/ `伪造 exit2`（正常产品检查 + exit 2 → fail 而非 blocked）。

---

## 6. 集成建议（供父 / 资源 / GLM 会话）

1. **GWT 无需接线改动（已核验）**：`nanju-gwt-runner.ts` 中 `blockedReason = engineeringSuite.verdict === 'blocked' ? engineeringSuite.reason : null`，随后 `retryCount = blockedReason ? prevRetryCount : …`、`verdict = blockedReason ? 'blocked' : …`、blocked 摘要「本轮不计入代码缺陷修复次数」——suite verdict=blocked 即可正确进入不扣预算路径。**本片未改 gwt-runner（GLM 所有）**；若 GLM 需在摘要展示具体缺失项，`engineeringSuite.reason`（现含「缺失 XXX」）已随结果透传。
2. **manifest.json 哈希刷新（资源会话）**：`driver-skeleton.py/.cjs` 内容已变，`manifest.json` 中二者 SHA256 需由资源会话刷新（本片被禁改 manifest.json）。资源会话报告已列明该依赖。
3. **suite 级一致（本片已覆盖）**：blocked 结果 → `runEngineeringSuite` verdict=blocked、coveredUs 空，已用单测锁定。
4. **环境预检仍在驱动内（非 preflight）**：环境检测发生在驱动进程内（批准后）。这是既有设计（骨架 ⑤ 自检）；若要把 DISPLAY/设备探测前移到批准前，属 Task 10（env-probe 统一探测）范围，不在本片。

---

## 7. 限制与未测边界（诚实标注）

| 项 | 状态 | 说明 |
|---|---|---|
| 全量 `bun test` / `bun run build` / `pack` | **未跑** | 系统盘仅 78MB，autonomy 禁 pack/build；只跑定向测试 + typecheck |
| Python 骨架 → 宿主解释 | **未做子进程级集成** | 宿主 interpret 是运行时无关的 JSON 解析；Python 骨架 blocked 形态已在 `driver-skeleton.test.ts` 直接 spawn 断言（exit 2 + structured blocked），但未走 `runRegisteredEngineeringTest` 全链路。Node 侧已全链路覆盖。建议后续补一条 Python 宿主集成 |
| GWT 修复预算端到端 | **读码核验，未实测** | 实际「不扣预算」的端到端需真实 blocked 工程跑 GWT，属 B3/B5 范围（需浏览器/环境）；本片以 suite verdict=blocked 单测 + gwt-runner 读码核验链路 |
| Windows | 仍未接入（fail-closed） | process-driver 在 win32 抛 `EngineeringExecutionBlocked`，与基线一致，未改 |
| 取消门禁 / 批准 / 指纹 | 保留 | 未改动 `runRegisteredEngineeringTest` 的批准/版本/取消边界；新增解释逻辑位于 interpret，不触碰这些门禁 |

---

## 8. 自审（self_audit 口径）

- **四态正确**：pass / fail / error / blocked 各归其位（blocked 需结构化标记；fail=产品断言不符或非零退出；error=崩溃/坏协议/坏 schema）。
- **产物修改仍阻塞**：执行后版本变化仍 `blocked('执行期间工程版本变化…')`，未受影响。
- **未授权仍拦**：`approve` / 未注册驱动 / 版本指纹 / 取消门禁均保留，新增逻辑不绕过。
- **无其他会话文件改动**：`git status` 核对，本片只改 §4.1 四个文件 + 新增一个测试文件；gwt-runner / template / manifest / package.json / shared / AGENTS.md 均未触碰（工作树中它们的 M 状态系其他会话既有改动）。
- **实测与未测分明**：§7 表逐项标注「已测 / 未测 / 读码核验」。

---

# 第二阶段（2026-09-20 14:05 GMT+8 追加）——父复核后的剩余 Task 11 代码

> 本阶段不修改第一阶段既有报告事实，仅追加。父已读首片报告，下发 4 项剩余：① blocked 严格签名 + Python 全链 ② 证据归档 ③ 子进程数限制/清理回归 ④ 行为合规负例。

## 9. 本阶段交付

### 9.1 blocked 严格签名（①）

- `interpretLegacyExit2` 收紧：旧「环境前置自检」单独 label 不再可信，须同时满足 `单条 check + label 逐字 + expected==='环境就绪' + actual 以「缺失: 」前缀且非空 + evidence 非空字符串数组` 才判 blocked；不符即落回产品判定（fail/error），异常 exit 2 不洗成 blocked。
- 新增 5 条「legacy 伪装产品失败」负例：expected 非环境就绪 / actual 无前缀 / evidence 空 / 缺失项空 / 多条 checks，均断言 `not.toBe('blocked')`。
- **Python 骨架 → 宿主全链补测**：真实 python3 子进程 + `createEngineeringProcessDrivers({pythonPath})`，断言 blocked、coveredUs 空、reason 含缺失变量（消除首片「未做 Python 宿主全链」的限制项）。

### 9.2 证据归档（②）

- 新增 `nanju-engineering-evidence.ts`（+ 6 用例测试）：`archiveEngineeringTestEvidence` → `06_TESTS/evidence/<runId>/<testId>/evidence.json`（meta + checks + driverIo，content 用 sha256 自证）；`writeEngineeringEvidenceIndex` / `readEngineeringEvidenceIndex` / `readEngineeringTestEvidence` 写/读 `index.json`（runId/来源/时间/逐 testId 的 hash/状态）。
- 接入 `runEngineeringSuite`：生成 `runId`，逐测试 best-effort 归档，终态写索引；`EngineeringSuiteResult` 新增可选 `runId`/`evidenceIndex`（对 gwt-runner 无侵入）。
- 不变量：归档 `source='driver-execution'` 只读证据，**不写 approve() 结果 / 交付票据 / 白名单授权**（交付仍由 GWT 交付门 + 单次批准重新验证）；归档/索引失败不阻断判定。

### 9.3 子进程数限制 + 清理回归（③）

- `EngineeringProcessRuntime` 新增 `maxConcurrentProcesses`（默认 8），`createEngineeringProcessDrivers` 内共享并发计数；超限抛 `EngineeringExecutionBlocked('并发测试驱动进程数超限…')`。
- 3 条回归：`maxConcurrentProcesses=1` 时第二并发 blocked；取消后子进程 PID 不再存活；超时后子进程 PID 不再存活（`process.kill(pid,0)` 判活）。

### 9.4 行为合规负例（④）

- 骨架 `make_check`/`makeCheck` 增「恒真防线」：`actual` 参数只能传 probe 函数，传字符串直接抛 `DriverSelfCheckError`（手写 actual 使 expected==actual 恒真，无法暴露产品行为不符）；`run_probes`/`runProbes` 默认 TODO 改为 probe 形态。
- 新增负例（Python + Node 各 3 条）：恒真（字符串 actual）被拦截为 DriverSelfCheckError exit 1；空断言（返回空 checks）被③ schema 拦截 exit 2；关键变异体（变异 target 内容 → probe 驱动由 pass 转 fail，证明断言有鉴别力而非恒真/仅行数或非空 evidence）。

## 10. 命令与结果（第二阶段）

```bash
export PATH=/home/orphic/.bun/bin:$PATH
cd /home/orphic/proma-patches/p1-quick-engineering
bun test apps/electron/src/main/lib/nanju-engineering-execution.test.ts \
        apps/electron/src/main/lib/nanju-engineering-suite.test.ts \
        apps/electron/src/main/lib/nanju-engineering-process-driver.test.ts \
        apps/electron/src/main/lib/nanju-driver-skeleton.test.ts \
        apps/electron/src/main/lib/nanju-driver-blocked-protocol.test.ts \
        apps/electron/src/main/lib/nanju-engineering-evidence.test.ts \
        apps/electron/src/main/lib/nanju-engineering-driver-io.test.ts \
        apps/electron/src/main/lib/nanju-pit-reflow.test.ts
# 结果：121 pass / 0 fail / 359 expect()（跨 8 文件）

cd apps/electron && bun run typecheck
# 结果：exit 2，唯一错误在 nanju-project-snapshots.test.ts(283)（父恢复/IPC 范围的
# string|null vs string|undefined，非本片文件，系父并发改动所致）；本片文件 typecheck 干净。
```

## 11. 文件清单（第二阶段）

| 文件 | 改动 |
|---|---|
| `nanju-engineering-execution.ts` | `interpretLegacyExit2` 收紧 + `isLegacyEnvironmentBlock` 严格签名 |
| `driver-skeleton.py` / `.cjs` | `emit_blocked` 结构化标记（首片）+ 本阶段 `make_check` 恒真防线 |
| `nanju-engineering-process-driver.ts` | 并发子进程数限制（`maxConcurrentProcesses`） |
| `nanju-engineering-suite.ts` | runId + 证据归档接线 |
| `nanju-engineering-evidence.ts`（新增） | 证据归档/索引/读取模块 |
| `nanju-driver-skeleton.test.ts` | 恒真/空断言/变异体负例 + blocked 新形态断言 |
| `nanju-driver-blocked-protocol.test.ts` | legacy 伪装负例 + Python 全链 |
| `nanju-engineering-process-driver.test.ts` | 并发限制 + 取消/超时清理回归 |
| `nanju-engineering-evidence.test.ts`（新增） | 归档往返/hash/不持久化授权 |
| `nanju-engineering-suite.test.ts` | runId/evidenceIndex 落盘断言 |

## 12. 限制与未测（第二阶段）

- 全量 `bun test`/`build`/`pack` 仍未跑（磁盘 78MB，autonomy 禁）。
- typecheck 唯一错误在父范围（nanju-project-snapshots.test.ts），未触碰；本片文件干净。
- 证据归档在 suite 层生成 runId（与 gwt-runner 的 report runId 各自独立）；父/GLM 后续可把 gwt runId 下传以对齐两处 runId（需改 gwt-runner，不在本片范围）。
- gwt-runner 未改（GLM 负责预算端到端）；suite 的 runId/evidenceIndex 为可选字段，对 gwt-runner 无侵入。
