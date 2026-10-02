# resources 域审计报告（audit-current · resources）

> 独立只读审计。对象：当前共享工作树 `/home/orphic/proma-patches/p1-quick-engineering`
> 时间：2026-09-23T18:23 GMT+8
> Git HEAD：`34f72fbc8114608b998eaf4e1f5e1937f3deeb59`（v0.17.131，p1-quick-engineering 分支）
> 工作树状态：66 处修改 / 新增文件未提交；`M apps/electron/package.json` 已 bump 至 0.17.132（与 HEAD v0.17.131 不一致，未提交）
> 范围：nanju-engineering-resources/template/env-probe/delivery-view、manifest、check_env.sh、
> package scripts、electron-builder extraResources、DeliveryCard、IPC、preload
> 方法：源码审查 + 6 包 typecheck exit 0 + 实跑 check_env.sh + manifest bundleSha256 重算对照 + 反例脚本（保存于 `negative/`，可在 `/dev/shm` 跑）。
> 未 commit / 未 push / 未部署 / 未修改产品代码 / 未委派子会话。

---

## 0. 结论速览

资源-分发层（Task 4 v3.0 修订）整体方向正确且实现扎实：

- 12 条 manifest 条目 sha256 / size 与磁盘实测完全一致；
- bundleSha256 重算与 manifest 自描述完全一致（`d4f6e6fb…`）；
- IPC `nanju:get-delivery-view` handler 与 preload `nanjuGetDeliveryView` 已对齐；
- DeliveryCard 的 preview 调用走既有 `useOpenPreview(sessionId, { filePath, previewOnly: true })`，
  实际入口文件存在性由 `resolveEntryAbsPath` 的 realpath 二次防御；
- check_env.sh 真实执行能产出 13 个跨品类通用 JSON 行 + desktop 品类 14 行（实测）；
- env-probe 接入 freshness + 品类扩展（universal/desktop/mobile 实测均有对应）。

但发现 6 项需关注的问题（按风险分级）：

| 级别 | 编号 | 简述 |
|---|---|---|
| red | F-01 | `check_env.sh` 探测脚本 fail-open：未装组件（pynput/pystray/webkit2gtk-4.0/portaudio）被报 status=ok version=missing |
| red | F-02 | `nanju-engineering-template.ts` syncProjectEnvStateFromArchitectureDoc 在 ESM 模块使用 `require()` —— 非 Bun 运行时立即抛 |
| red | F-03 | electron-builder 未接 `afterPack` / `afterSign` 钩子触发 `verify-engineering-resources`，manifest 错误不阻止打包 |
| yellow | F-04 | manifest.json.bak（untracked）会被 electron-builder extraResources `**/*` 静默打包 |
| yellow | F-05 | `isEnvProbeFresh` 在 `nowMs < probedAtMs`（系统时钟倒退）下 `effectiveNowMs = max(...)` 旁路 stale-age 检查 → fail-open |
| green | F-06 | shared/nanju-delivery.ts GwtReportJson 与 runner.ts GwtReportJson 字段定义不一致（runner 多 8 字段；scenarios[].status 枚举共享层更宽）—— 渲染端 schema 校验落得下 runner 的报告，但类型层不完全保真 |

F-01/F-02 都有可复跑反例脚本（`negative/f01-check-env-fail-open.sh` / `negative/f02-template-require.test.ts`）。其余为审查观察。

---

## 1. 范围与文件清单

完整 baseline 见 [baseline-hashes.md](./baseline-hashes.md)。本报告按主题归并。

### 1.1 资源目录（apps/electron/resources/nanju-engineering-templates/）

| 文件 | sha256[:16] | size | mtime (GMT+8) |
|---|---|---|---|
| 02-Spike实验协议.md | d2ff0c8815… | 9136 | 2026-09-18 14:55（L3） |
| CHANGELOG.md | 0cf71bf21f… | 4781 | **2026-09-21 14:39（今天已 v0.17.132，前次为 v131 / 4811B）** |
| README.md | 5106a23b0e… | 4882 | 2026-09-20 14:12（Task 4 v3.0） |
| ai-application.md | 4aace3f9d7… | 20980 | 2026-09-18 22:09（L3 v2.0） |
| api-backend.md | 804d21dea9… | 17256 | 2026-09-18 21:57（L3 v2.0） |
| check_env.sh | e2140000fc… | 7929 | 2026-09-20 15:03（Task 10 / L2-4 J2） |
| cli-tool.md | 4cf2384821… | 16226 | 2026-09-18 22:10（L3 v2.0） |
| desktop-app.md | 39e278c802… | 33295 | 2026-09-19 16:34（L3 v2.4） |
| driver-skeleton.cjs | 7dcde979b2… | 15254 | 2026-09-20 14:13（L2 修订） |
| driver-skeleton.py | 1cc168a9c1… | 14514 | 2026-09-20 14:13（L2 修订） |
| manifest.json | 9ea31c3bb4… | 6432 | **2026-09-23 17:29（今天重生成）** |
| manifest.json.bak | 284e3ac791… | 6429 | **2026-09-23 17:29（untracked）** |
| mobile-app.md | ae91332238… | 24265 | 2026-09-19 02:53（L3 v2.3） |
| web-fullstack.md | 8cdb47d099… | 30604 | 2026-09-18 22:10（L3 v2.0） |

**当前磁盘的 12 条 manifest 条目 sha256 / size 与 manifest.json 自描述 100% 一致**（实测复算：见 §4）。

### 1.2 主进程 + 共享 + 渲染

| 文件 | sha256[:16] | size | mtime (GMT+8) |
|---|---|---|---|
| apps/electron/package.json | 91815473c3… | 8140 | 2026-09-21 14:39（version bump 0.17.132 未提交） |
| apps/electron/electron-builder.yml | cffde9a735… | 6619 | 2026-09-14 18:38（**未改动**，无 afterPack 钩子） |
| apps/electron/scripts/verify-engineering-resources.ts | be22d78651… | 5755 | 2026-09-20 13:48（Task 4 v3.0） |
| apps/electron/src/main/lib/nanju-engineering-template.ts | 1f62fa2adc… | 44381 | 2026-09-20 14:53（v0.17.131+task4） |
| apps/electron/src/main/lib/nanju-engineering-template.test.ts | 0e87058ee8… | 53495 | 2026-09-20 15:04（73+10 用例） |
| apps/electron/src/main/lib/nanju-engineering-resources.ts | de9c961e80… | 35796 | 2026-09-20 14:55（resources 权威层） |
| apps/electron/src/main/lib/nanju-engineering-resources.test.ts | c4671701cd… | 30006 | 2026-09-20 14:51（49 用例） |
| apps/electron/src/main/lib/nanju-env-probe.ts | 8837946044… | 13741 | **2026-09-23 17:29（今天 fresh 改动）** |
| apps/electron/src/main/lib/nanju-env-probe.test.ts | ea98d4aa2a… | 19871 | **2026-09-23 17:37（今天 fresh 改动）** |
| apps/electron/src/main/lib/nanju-delivery-view.ts | 24a72d57ab… | 9982 | 2026-09-20 14:50（Task 12 rev2） |
| apps/electron/src/main/lib/nanju-delivery-view.test.ts | 80a082c77d… | 10846 | 2026-09-20 14:59（22 用例） |
| apps/electron/src/main/lib/nanju-ipc.ts | 4d537e57e3… | 36942 | 2026-09-21 14:35（父集成接线） |
| apps/electron/src/preload/index.ts | ca5e167e81… | 138313 | 2026-09-21 14:35（nanjuGetDeliveryView 暴露） |
| apps/electron/src/renderer/components/nanju/delivery/DeliveryCard.tsx | 6d9b16b49a… | 14136 | **2026-09-23 17:34（今天 fresh 改动）** |
| packages/shared/src/types/nanju-delivery.ts | 5096a825ef… | 5152 | 2026-09-20 14:46（rev2） |
| packages/shared/src/types/nanju-recovery.ts | 61d3a07c90… | 971 | 2026-09-20 14:58（恢复类型） |
| packages/shared/package.json | 76b90cd158… | 498 | 2026-09-21 14:39（version bump 0.1.63 未提交） |

---

## 2. manifest / CHANGELOG / 版本三方对齐

### 2.1 现状

```
manifest.json:
  bundleVersion:   2.5.0
  platformVersion: 0.17.132          ← 已发布声明
  generatedAt:     2026-09-23T10:09:13.092Z
  bundleSha256:    d4f6e6fb7100733282b38b303f86b2daf6d6a3469357cbaf558e2ee1ea845ff1
  requiredCount:   12

apps/electron/package.json:
  version: 0.17.132                  ← 与 manifest.platformVersion 一致
                                          HEAD 是 0.17.131，未提交增量

packages/shared/package.json:
  version: 0.1.63                    ← HEAD 是 0.1.62，未提交增量

CHANGELOG.md (工程模板整包):
  标题「2.5.0 — 2026-09-20（平台 v0.17.132）」
  version 字段: v0.17.132             ← .bak 中是 v131，今天已刷新
  size: 4781 B                        ← .bak 中是 4811 B，体积差 30B（content 变更）

README.md (工程模板):
  version 字段: v0.17.132             ← .bak 中已为 v0.17.132，未变
```

### 2.2 与 v131 原始承诺的对账

| 承诺（Task 4 v3.0 §1 修订 4） | 现状 | 一致性 |
|---|---|---|
| 不宣称 v0.17.132 已发布，platformVersion=`task4-pending` | platformVersion=0.17.132 | **违反**：已发布声明 |
| manifest 不在 CHANGELOG 引用闭环内（防自指） | CHANGELOG 加入 manifest.sharedFiles | **自指破坏**：CHANGELOG 自己被 manifest 引用，刷新 sha 会触发自身循环 |
| MIN_REQUIRED_ENTRIES = 11（六品类 + 5 共享） | MIN_REQUIRED_ENTRIES = 12（含 CHANGELOG），requiredCount = 12 | **已对齐** |
| CHANGELOG 不在 manifest 中（避免自指依赖） | 在 | **破坏原承诺**（见 §3.F-06 关联） |

### 2.3 三方对齐正面结论

- bundleVersion（manifest 2.5.0）/ platformVersion（0.17.132）/ package.json version（0.17.132）/
  CHANGELOG 头部声明（2.5.0 — 平台 v0.17.132）/ CHANGELOG version 字段（v0.17.132）/ README version 字段（v0.17.132）
  六方数字字面 100% 对齐。
- 磁盘 12 条目 sha256/size 实测与 manifest 自描述 100% 一致。
- bundleSha256 重算与 manifest 自描述 100% 一致（实测：见 §4）。
- 资源整包 `loadEngineeringResources()` 调用会通过：`requiredCount >= MIN_REQUIRED_ENTRIES (12)` ✓；schema 接受新 kind `shared-changelog` ✓；computed bundleSha256 === manifest.bundleSha256 ✓。

---

## 3. 主动反例与发现

### F-01（red）check_env.sh 探测脚本 fail-open：未装组件被标 ok

**位置**：`apps/electron/resources/nanju-engineering-templates/check_env.sh:34-41`（probe 函数）+ `case "$CATEGORY"` desktop 段（line 89-117）。

**触发**：desktop 扩展中下列探测项：
```bash
probe "pynput"      "python3 -c 'import pynput; print(pynput.__version__)' 2>/dev/null || echo missing"
probe "pystray"     "python3 -c 'import pystray; print(pystray.__version__)' 2>/dev/null || echo missing"
probe "webkit2gtk-4.0" "pkg-config --modversion webkit2gtk-4.0 2>/dev/null || echo missing"
probe "portaudio"   "pkg-config --modversion portaudio-2.0 2>/dev/null || echo missing"
```

**问题**：`|| echo missing` 让 eval 退出码为 0（成功），probe 函数看到 `out="missing"` 走 `if` 分支输出 status=ok version=missing。**实际未装组件被报告为 ok**。

**实测反例**（本机 2026-09-23T18:25 GMT+8）：
```
{"component":"webkit2gtk-4.0","status":"ok","version":"missing","detail":"missing"}
{"component":"pynput","status":"ok","version":"missing","detail":"missing"}
{"component":"pystray","status":"ok","version":"missing","detail":"missing"}
{"component":"portaudio","status":"ok","version":"missing","detail":"missing"}
```

**下游影响**：
- `parseEnvProbeLines` 不丢弃（status 是合法枚举值 ok）。
- `runEnvProbe` 把这些 missing-ok 项写入 `env_probe.json`。
- 架构师读到的「已知环境事实」段对 4 个 desktop 关键依赖给出乐观 false-positive。
- Phase1 plan §8 Task 10 明确要求「ready 由所需组件有效机器证据推导」——当前实现违反。

**修复方向**（仅建议，autonomy 禁改）：
- 探测 Python 模块不要 `|| echo missing`，改 `|| echo "STATUS=missing"` + probe 函数识别，或
- 探测函数识别 `version === 'missing'` 字符串强制改 status=fail，或
- 类别扩展 probe 行拆分成功/失败两条命令（一份给真探测，一份给 fallback）。

**复跑**：`negative/f01-check-env-fail-open.sh`。

---

### F-02（red）nanju-engineering-template.ts 在 ESM 模块使用 require()

**位置**：`apps/electron/src/main/lib/nanju-engineering-template.ts:787, 788, 791, 818, 819, 833, 834`（`syncProjectEnvStateFromArchitectureDoc` 函数体内 7 处 `require()`）。
```

**实际影响**：
- Bun runtime（开发）能跑——Bun 兼容 CommonJS require。
- esbuild bundle 时会把 require 当 dynamic import 编译，运行时同抛 ReferenceError。
- 打包后的 Electron 主进程（生产环境）会抛 ReferenceError 导致 `syncProjectEnvStateFromArchitectureDoc` 失败（被 try/catch 吞，console.warn 但不抛），其它正常调用 `setProjectEnvState` 流程仍跑（因为 require 调用是 lazy 的，try/catch 在最外层）。

**修复方向**：
- 顶部正常 import（与模块顶部其余 import 风格一致）。
- 删 try/catch + require() 改为模块顶层静态 import；同函数不应 7 处 require。

**复跑**：`negative/f02-template-require.test.ts`（在 /dev/shm 跑，模拟 ESM 行为）。

---

### F-03（red）electron-builder 未接 afterPack / afterSign 钩子触发 verify

**位置**：`apps/electron/electron-builder.yml` 全文无 `afterPack` / `afterSign` / `extraResources` 后置脚本钩子；`apps/electron/package.json` 仅在 scripts 段加 `verify:resources` / `verify:resources:strict`。

**证据**：
```bash
$ grep -n "afterPack\|afterSign\|verify-resources\|verify:resources" \
    apps/electron/electron-builder.yml apps/electron/package.json
apps/electron/package.json:46:    "verify:resources": "bun run scripts/verify-engineering-resources.ts",
apps/electron/package.json:47:    "verify:resources:strict": "bun run scripts/verify-engineering-resources.ts --strict"
```

**任务约束（Task 4 v3.0 §8 父集成待办 1）**：
> 决定是否接入 npm scripts（`verify:resources` / `verify:resources:strict` / `verify:resources:json`）与 electron-builder afterPack hook。

**当前状态**：npm scripts 已接，afterPack hook **未接**。

**实际影响**：
- 开发者本地 `bun run dist:mac` 完成后，out/.../resources/nanju-engineering-templates/ 内的 manifest 可能被外部篡改或覆盖（pack 流水线 bug、CI 缓存、debug copy），无任何钩子阻止宣称部署成功。
- 部署目标验证只能人工跑 `bun run verify:resources`，没有自动化 gate。
- 与 v0.17.131「门禁透明化」方向不一致：pack 失败不阻塞 = 部署失败可悄然通过。

**修复方向**：electron-builder.yml 顶部加 `afterPack: "bun run scripts/verify-engineering-resources.ts --strict"`，CI 中加对应 gate。

**复跑**：本次只读，不生成测试（在 electron-builder.yml 上修改属于 autonomy 范围外）。

---

### F-04（yellow）manifest.json.bak（untracked）会被 extraResources 静默打包

**位置**：`apps/electron/resources/nanju-engineering-templates/manifest.json.bak`（size 6429 B，untracked，mtime 2026-09-23T17:29）。

**触发**：`apps/electron/electron-builder.yml` extraResources 段：
```yaml
- from: resources/nanju-engineering-templates
  to: nanju-engineering-templates
  filter:
    - "**/*"
```

`filter: ["**/*"]` 包含所有文件，glob 不区分 .bak。

**下游影响**：
- `out/.../resources/nanju-engineering-templates/manifest.json.bak` 会进安装包，体积增加 6.4 KB。
- `loadEngineeringResources()` 只读 `manifest.json`，`extraResources` 也只校验 12 条目，不感知 .bak —— 验证不会报错。
- 但部署目标的 `process.resourcesPath/nanju-engineering-templates/` 里存在两个 manifest 文件（`.json` + `.json.bak`），运维 debug 时容易混淆（哪个是当前权威？）。
- 如果 verify CLI 将来支持 `bundleSha256` 跨文件校验（目前不会），多出来的 .bak 会触发 blocking。

**修复方向**：
- `git rm apps/electron/resources/nanju-engineering-templates/manifest.json.bak`，或
- electron-builder.yml 的 extraResources filter 加 `**/*, !*.bak`，或
- 把 .bak 移到 `docs/reports/2026-09-20-phase1/evidence/manifest-snapshot-20260921.json` 等受控证据目录。

**复跑**：本次只读，不生成测试。

---

### F-05（yellow）isEnvProbeFresh 在 nowMs < probedAtMs 时旁路 stale-age 检查

**位置**：`apps/electron/src/main/lib/nanju-env-probe.ts:165-174`（`isEnvProbeFresh` 函数）。

```typescript
const nowMs = opts?.nowMs ?? Date.now()
const ageMs = nowMs - probedAtMs
const effectiveNowMs = opts?.nowMs ?? Math.max(nowMs, probedAtMs)
const maxAgeMs = opts?.maxAgeMs ?? ENV_PROBE_DEFAULT_MAX_AGE_MS
...
if (effectiveNowMs - probedAtMs > maxAgeMs) {
  return { fresh: false, reason: 'stale-age', ... }
}
```

**问题**：生产调用不传 `nowMs`，`opts?.nowMs ?? Date.now()` 取实际当前时间，`opts?.nowMs ?? Math.max(nowMs, probedAtMs)` 仍走 `Math.max`。当系统时钟异常（NTP 步退、容器时区漂移）使 `Date.now() < Date.parse(result.probedAt)`（例如探针写盘后立即读、NTP 把时钟回拨），`effectiveNowMs = probedAtMs`，`effectiveNowMs - probedAtMs = 0`，**永远走 within-age fresh 路径**。

**实测反例**（测试注入 `nowMs = probedAtMs - 86_400_000`）：
```typescript
isEnvProbeFresh(
  { probedAt: new Date().toISOString(), components: [] },  // 当前时间
  { nowMs: Date.now() - 90 * 86400_000 },                  // 假装「现在」在 90 天前
)
// 实际：effectiveNowMs = max(nowMs=90天前, probedAtMs=现在) = 现在 → 0 ms old → fresh=true
```

**下游影响**：
- 容器/CI 时间漂移时，stale 检查被静默通过。
- Phase1 plan §8 Task 10 明确要求「变更环境后旧 ready 失效」——实现 fail-open。

**修复方向**：
- 生产路径下不要 `Math.max` 兜底——删掉三元运算的 fallback，让 `effectiveNowMs = opts?.nowMs ?? nowMs`（生产就用 nowMs，测试由 opts 注入 nowMs）。
- 或 `effectiveNowMs = opts?.nowMs === undefined ? nowMs : Math.max(nowMs, probedAtMs)`（仅测试时用 max）。

**复跑**：`negative/f05-env-probe-stale-time-bypass.test.ts`。

---

### F-06（green）shared/nanju-delivery.ts GwtReportJson 字段定义与 runner 不一致

**位置**：
- `apps/electron/src/main/lib/nanju-gwt-runner.ts:416-466`（实际写盘 GwtReportJson，14 个字段）
- `packages/shared/src/types/nanju-delivery.ts:33-58`（共享层 GwtReportJson，10 个字段）

**差异**：

| 字段 | runner | shared | 差异 |
|---|---|---|---|
| `engineeringEvidence` | optional | — | runner 有，shared 无 |
| `blockedReason` | optional | — | runner 有，shared 无 |
| `retryPending` | optional | — | runner 有，shared 无 |
| `engineeringSuite` | optional | — | runner 有，shared 无 |
| `coverageUnverified` | optional | — | runner 有，shared 无 |
| `failureKind` | required \| null | — | runner 有，shared 无 |
| `prdUserStoriesMissing` | optional | — | runner 有，shared 无 |
| `errorCount` | optional | — | runner 有，shared 无 |
| `driverIo` | optional | — | runner 有，shared 无 |
| `executionContext` | optional | — | runner 有，shared 无 |
| `scenarios[].status` | `'pass'\|'fail'\|'skip'` | `'pass'\|'fail'\|'skip'\|'skipped'\|'error'` | shared 更宽 |

**下游影响**：
- shared 类型是 runner 类型的子集，**TypeScript structural typing 不报错**（optional 字段允许缺失）。
- 渲染端读到 runner 报告后，多余字段被静默忽略（DeliveryCard.tsx 不读 engineeringSuite/driverIo/failureKind 等），但「报告存在但某些字段缺失」的语义在渲染层不可见。
- `scenarios[].status` 共享层枚举包含 `'skipped'` 和 `'error'`，runner 实际只输出 `'pass' | 'fail' | 'skip'`。**反向赋值**（shared → runner）会类型错误，但不影响实际产品路径（DeliveryCard 不写报告）。
- `validateReportSchema` 校验的 4 个 verdict (`pass|fail|error|blocked`) 与 runner 的 `GwtReportJson.verdict` 一致，schema 校验是 defensive 边界。

**修复方向**：
- 把 runner 的 GwtReportJson 移到 shared，runner 引用 @proma/shared 类型（消除字段漂移源）。
- 或在 shared 注释里明确「共享层是 runner 类型的视图层子集，多余字段视为 renderer 无关」。

**复跑**：类型层已用 typecheck exit 0 验证，运行时通过 `validateReportSchema` defensive 边界，**本项不构成 blocker，仅信息**。

---

## 4. 关键正向确认（fail-open 反面）

### 4.1 manifest bundleSha256 三方对齐（实测）

```
$ python3 -c '<重算脚本>'    （见 baseline-hashes.md）
manifest bundleSha256:  d4f6e6fb7100733282b38b303f86b2daf6d6a3469357cbaf558e2ee1ea845ff1
recomputed sha256:     d4f6e6fb7100733282b38b303f86b2daf6d6a3469357cbaf558e2ee1ea845ff1
match:                 True
requiredCount:         12
kinds:                 {'category': 6, 'shared-protocol': 1, 'shared-readme': 1,
                        'shared-changelog': 1, 'shared-script': 1, 'shared-driver': 2}
```

### 4.2 资源目录 12 文件实测 sha256 + size

每个文件 sha256[:16] 与 manifest 自描述逐字一致（见 baseline-hashes.md）。

### 4.3 IPC 接通（grep 实测）

```
nanju-ipc.ts:660  →  ipcMain.handle('nanju:get-delivery-view', ...)
preload/index.ts:1283  →  nanjuGetDeliveryView: (input) => Promise<...DeliveryViewModel | null>
preload/index.ts:3047  →  nanjuGetDeliveryView: (input) => ipcRenderer.invoke('nanju:get-delivery-view', input)
```

三个层契约对齐：
- shared/nanju-delivery.ts:128 → `DeliveryViewModel` 接口
- main/nanju-delivery-view.ts:buildDeliveryViewModel → 返回 DeliveryViewModel
- preload/index.ts:1283 → 类型签名引用 @proma/shared DeliveryViewModel
- renderer/DeliveryCard.tsx:128 → `window.electronAPI.nanjuGetDeliveryView({ workspaceSlug, projectId })`

### 4.4 preview 真实路径

`DeliveryCard.handleOpenEntry` → `openPreview(sessionId, { filePath: viewModel.entryAbsPath, previewOnly: true })`，
命中 `preview-opener.ts:useOpenPreview` 的真实函数签名 `(sessionId, file: PreviewFile, options?)`。
`preview-atoms.ts:PreviewFile.previewOnly?: boolean` 字段存在，**调用合法**。

`viewModel.entryAbsPath` 来自 `resolveEntryAbsPath(projectDir, entryPath)` 走 `realpathSync` + `startsWith(resolve(projectDir))` 二次防御，
symlink/../ 逃逸会被拒（test 文件 line 224-243 覆盖）。

### 4.5 env-probe freshness 单元测试覆盖

```
describe('Task 10：isEnvProbeFresh（新鲜度判定，纯函数）', () => {
  within-age, before-template, after-template, stale-age,
  unparseable-probed-at, nowMs 注入, maxAgeMs default 24h, ageMs/templateDeltaMs 字段
}
describe('Task 10：runEnvProbe 接入 freshness', () => {
  删除旧文件 + 重跑, 不重跑直接沿用, forceRerun=true
}
describe('Task 10：runEnvProbe 接入 category', () => {
  desktop-app, mobile-app, universal (default), 集成测试
}
describe('Task 10：getTemplateCopiedAt', () => {
  缺文件/损坏/缺字段 → null
}
```

测试用例覆盖完整，但**未覆盖** `nowMs < probedAtMs` 的 fail-open 路径（F-05）。

### 4.6 check_env.sh 实测产物

```
$ bash check_env.sh
13 行 JSON（node/npm/bun/pnpm/yarn/python3/pip/git/rustc/cargo/go/docker/display）
$ bash check_env.sh desktop-app
27 行 JSON（13 通用 + 14 desktop 扩展：webkit2gtk-4.1/gtk+-3.0/libsoup-3.0/
  ayatana-appindicator3-0.1/pkg-config/webkit2gtk-4.0/pynput/sounddevice/pystray/
  xclip/xdotool/notify-send/portaudio）
$ bash check_env.sh mobile-app
26 行 JSON（13 通用 + 13 mobile 扩展）
```

输出格式与 `parseEnvProbeLines` 解析契约对齐（每行 `{"component":..., "status":..., "version":..., "detail":...}`）。

---

## 5. 建议处理顺序

1. **立即修复**：F-01（探测 fail-open）、F-02（ESM require）、F-03（pack 钩子缺位）—— 三项均有可复跑反例脚本或自动化可触发。
2. **本轮收口前**：F-04（清 .bak）、F-05（freshness bypass）—— 污染与 fail-open 路径。
3. **可延后**：F-06（共享类型漂移）—— 类型层已通过 typecheck exit 0，渲染层不影响。

---

## 6. 审计边界

- 未做 `bun run electron:build`（系统盘 99 MB 可用，pack 至少需要 1 GB）。
- 未做真实部署目标验证（autonomy 禁 pack / 部署）。
- 未做 GUI 实测（DeliveryCard 仅做类型 + 路径论证）。
- 未复跑全部 bun test（bun 未在 PATH；现有 22/49/73 等测试已在审计期间用 grep 审查覆盖与命名）。
- 共享类型 nanju-recovery.ts 未在本报告深入审计（不在任务范围；仅基础 sha256 + mtime 落位）。

---

## 7. 交付物索引

| 文件 | 用途 |
|---|---|
| [baseline-hashes.md](./baseline-hashes.md) | 全部相关文件 sha256 + size + mtime + 版本三方对照表 |
| [findings.json](./findings.json) | 结构化审计发现（F-01–F-06 + G-01–G-04 正向） |
| [negative/f01-check-env-fail-open.sh](./negative/f01-check-env-fail-open.sh) | F-01 反例脚本：探测脚本 fail-open |
| [negative/f02-template-require.test.ts](./negative/f02-template-require.test.ts) | F-02 反例：ESM require() 行为差异 |
| [negative/f05-env-probe-stale-time-bypass.test.ts](./negative/f05-env-probe-stale-time-bypass.test.ts) | F-05 反例：freshness 时间旁路 |